"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  localeDirection,
  message,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@/app/i18n/catalog";
import {
  applyDocumentLocale,
  deviceLocaleStorageKey,
  resolveDeviceLocale,
} from "@/app/i18n/locale";
import styles from "./gallery.module.css";

export type DirectPhoto = { key: string; url: string; uploadedAt: string };
export type HandoffGalleryState =
  | { kind: "loading" }
  | { kind: "ready"; photo: DirectPhoto }
  | { kind: "invalid" }
  | { kind: "not-found" }
  | { kind: "offline" }
  | { kind: "error" };

type PhotoTransferDeps = {
  fetchPhoto: (url: string) => Promise<Response>;
  canShare: (data: ShareData) => boolean;
  share: (data: ShareData) => Promise<void>;
  download: (blob: Blob, filename: string) => void;
};

type HandoffGalleryControllerDeps = {
  fetchPhoto: (
    url: string,
    init: { cache: "no-store"; signal: AbortSignal }
  ) => Promise<Response>;
  isOnline: () => boolean;
  onState: (state: HandoffGalleryState) => void;
};

export function parseDirectPhotoQuery(params: Pick<URLSearchParams, "getAll">): string | null {
  const values = params.getAll("photo");
  return values.length === 1 && values[0] ? values[0] : null;
}

export async function prefetchPublicPhoto(
  photo: DirectPhoto,
  fetchPhoto: (url: string) => Promise<Response>
): Promise<Blob> {
  const response = await fetchPhoto(photo.url);
  if (!response.ok) throw new Error("photo prefetch failed");
  return response.blob();
}

export async function transferPublicPhoto(
  photo: DirectPhoto,
  prefetchedBlob: Blob | null,
  deps: PhotoTransferDeps
): Promise<"shared" | "downloaded"> {
  const filename = photo.key.slice(photo.key.lastIndexOf("/") + 1);
  if (prefetchedBlob) {
    const file = new File(
      [prefetchedBlob],
      filename,
      { type: prefetchedBlob.type || "image/jpeg" }
    );
    const data = { files: [file], title: "Photo" };
    try {
      if (deps.canShare(data)) {
        await deps.share(data);
        return "shared";
      }
    } catch {
      // A rejected native share still leaves a reliable direct download.
    }
    deps.download(prefetchedBlob, filename);
    return "downloaded";
  }

  // Fetching here crosses Safari's transient user-activation boundary, so this
  // path deliberately downloads instead of attempting a late native share.
  const response = await deps.fetchPhoto(photo.url);
  if (!response.ok) throw new Error("photo download failed");
  const blob = await response.blob();
  deps.download(blob, filename);
  return "downloaded";
}

function browserTransferDeps(): PhotoTransferDeps {
  return {
    fetchPhoto: (url) => fetch(url),
    canShare: (data) => typeof navigator.share === "function"
      && typeof navigator.canShare === "function"
      && navigator.canShare(data),
    share: (data) => navigator.share(data),
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  };
}

function stateMessage(locale: SupportedLocale, state: Exclude<HandoffGalleryState, { kind: "ready" }>): string {
  switch (state.kind) {
    case "loading": return message(locale, "galleryLoading");
    case "invalid": return message(locale, "galleryInvalid");
    case "not-found": return message(locale, "galleryNotFound");
    case "offline": return message(locale, "galleryOffline");
    case "error": return message(locale, "galleryUnavailable");
  }
}

function isDirectPhoto(value: unknown, expectedKey: string): value is DirectPhoto {
  if (!value || typeof value !== "object") return false;
  const photo = value as Record<string, unknown>;
  return photo.key === expectedKey
    && typeof photo.url === "string"
    && typeof photo.uploadedAt === "string";
}

export class HandoffGalleryController {
  private generation = 0;
  private active: AbortController | null = null;

  constructor(private readonly deps: HandoffGalleryControllerDeps) {}

  async load(event: string, photoKey: string | null): Promise<void> {
    const generation = ++this.generation;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const publish = (state: HandoffGalleryState) => {
      if (this.generation === generation && !controller.signal.aborted) {
        this.deps.onState(state);
      }
    };

    if (!photoKey) {
      publish({ kind: "invalid" });
      this.finish(generation);
      return;
    }
    if (!this.deps.isOnline()) {
      publish({ kind: "offline" });
      this.finish(generation);
      return;
    }

    publish({ kind: "loading" });
    try {
      const query = new URLSearchParams({ event, key: photoKey });
      const response = await this.deps.fetchPhoto(`/api/photo?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 400) {
        publish({ kind: "invalid" });
        return;
      }
      if (response.status === 404) {
        publish({ kind: "not-found" });
        return;
      }
      if (!response.ok) throw new Error(`photo lookup returned ${response.status}`);
      const payload: unknown = await response.json();
      publish(isDirectPhoto(payload, photoKey)
        ? { kind: "ready", photo: payload }
        : { kind: "invalid" });
    } catch {
      if (this.generation !== generation || controller.signal.aborted) return;
      publish({ kind: this.deps.isOnline() ? "error" : "offline" });
    } finally {
      this.finish(generation);
    }
  }

  cancel(): void {
    this.generation += 1;
    this.active?.abort();
    this.active = null;
  }

  private finish(generation: number): void {
    if (this.generation === generation) this.active = null;
  }
}

export function focusHandoffStatus(
  target: Pick<HTMLElement, "focus"> | null,
  state: HandoffGalleryState,
  saveError: boolean
): void {
  if (state.kind !== "ready" || saveError) target?.focus();
}

function storedLocale(event: string): string | null {
  try {
    return window.localStorage.getItem(deviceLocaleStorageKey(event));
  } catch {
    return null;
  }
}

function initialLocale(event: string): SupportedLocale {
  return resolveDeviceLocale({
    event,
    configured: SUPPORTED_LOCALES,
    storedLocale: storedLocale(event),
    navigatorLanguages: navigator.languages,
  });
}

type HandoffGalleryViewProps = {
  state: HandoffGalleryState;
  locale: SupportedLocale;
  onRetry: () => void;
  onSave: () => void;
  saveError?: boolean;
  statusRef?: (element: HTMLElement | null) => void;
};

export function HandoffGalleryView({
  state,
  locale,
  onRetry,
  onSave,
  saveError = false,
  statusRef,
}: HandoffGalleryViewProps) {
  const direction = localeDirection(locale);
  const hasPhoto = state.kind === "ready";

  return (
    <main className={styles.gallery} lang={locale} dir={direction}>
      <section className={styles.card}>
        <h1>{message(locale, "handoffTitle")}</h1>
        {hasPhoto ? (
          <>
            <img className={styles.photo} src={state.photo.url} alt={message(locale, "preview")} />
            <div className={styles.actions}>
              <button className={styles.primaryAction} type="button" onClick={onSave}>
                {message(locale, "gallerySave")}
              </button>
            </div>
            {saveError ? (
              <p ref={statusRef} className={styles.error} role="alert" tabIndex={-1}>
                {message(locale, "gallerySaveError")}
              </p>
            ) : null}
          </>
        ) : (
          <section
            ref={statusRef}
            className={styles.status}
            role={state.kind === "loading" ? "status" : "alert"}
            aria-live={state.kind === "loading" ? "polite" : "assertive"}
            tabIndex={-1}
          >
            <p>{stateMessage(locale, state)}</p>
            {state.kind !== "loading" ? (
              <button className={styles.secondaryAction} type="button" onClick={onRetry}>
                {message(locale, "galleryRetry")}
              </button>
            ) : null}
          </section>
        )}
      </section>
    </main>
  );
}

export default function HandoffGallery() {
  const { event } = useParams<{ event: string }>();
  const params = useSearchParams();
  const photoKey = params ? parseDirectPhotoQuery(params) : null;
  const [state, setState] = useState<HandoffGalleryState>({ kind: "loading" });
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [saveError, setSaveError] = useState(false);
  const statusRef = useRef<HTMLElement>(null);
  const photoBlobRef = useRef<{ url: string; blob: Blob } | null>(null);
  const controllerRef = useRef<HandoffGalleryController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new HandoffGalleryController({
      fetchPhoto: (url, init) => fetch(url, init),
      isOnline: () => navigator.onLine,
      onState: setState,
    });
  }
  const setStatusElement = useCallback((element: HTMLElement | null) => {
    statusRef.current = element;
  }, []);

  useEffect(() => {
    setLocale(initialLocale(event));
  }, [event]);

  useEffect(() => {
    applyDocumentLocale(document.documentElement, locale);
  }, [locale]);

  const load = useCallback(async () => {
    setSaveError(false);
    await controllerRef.current!.load(event, photoKey);
  }, [event, photoKey]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.cancel();
  }, [load]);

  useEffect(() => {
    focusHandoffStatus(statusRef.current, state, saveError);
  }, [saveError, state.kind]);

  useEffect(() => {
    photoBlobRef.current = null;
    if (state.kind !== "ready") return;
    const photo = state.photo;
    const controller = new AbortController();
    let active = true;
    void prefetchPublicPhoto(
      photo,
      (url) => fetch(url, { signal: controller.signal })
    ).then((blob) => {
      if (active) photoBlobRef.current = { url: photo.url, blob };
    }).catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [state]);

  const save = useCallback(async () => {
    if (state.kind !== "ready") return;
    setSaveError(false);
    try {
      const prefetched = photoBlobRef.current?.url === state.photo.url
        ? photoBlobRef.current.blob
        : null;
      await transferPublicPhoto(state.photo, prefetched, browserTransferDeps());
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setSaveError(true);
    }
  }, [state]);

  return (
    <HandoffGalleryView
      state={state}
      locale={locale}
      onRetry={() => { void load(); }}
      onSave={() => { void save(); }}
      saveError={saveError}
      statusRef={setStatusElement}
    />
  );
}
