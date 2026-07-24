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

export function parseDirectPhotoQuery(params: Pick<URLSearchParams, "getAll">): string | null {
  const values = params.getAll("photo");
  return values.length === 1 && values[0] ? values[0] : null;
}

export async function transferPublicPhoto(
  photo: DirectPhoto,
  deps: PhotoTransferDeps
): Promise<"shared" | "downloaded"> {
  const response = await deps.fetchPhoto(photo.url);
  if (!response.ok) throw new Error("photo download failed");
  const blob = await response.blob();
  const filename = photo.key.slice(photo.key.lastIndexOf("/") + 1);
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  const data = { files: [file], title: "Photo" };
  if (deps.canShare(data)) {
    await deps.share(data);
    return "shared";
  }
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
  const setStatusElement = useCallback((element: HTMLElement | null) => {
    statusRef.current = element;
  }, []);

  useEffect(() => {
    setLocale(initialLocale(event));
  }, [event]);

  useEffect(() => {
    applyDocumentLocale(document.documentElement, locale);
  }, [locale]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!photoKey) {
      setState({ kind: "invalid" });
      return;
    }
    if (!navigator.onLine) {
      setState({ kind: "offline" });
      return;
    }

    setSaveError(false);
    setState({ kind: "loading" });
    try {
      const query = new URLSearchParams({ event, key: photoKey });
      const response = await fetch(`/api/photo?${query}`, { cache: "no-store", signal });
      if (response.status === 400) {
        setState({ kind: "invalid" });
        return;
      }
      if (response.status === 404) {
        setState({ kind: "not-found" });
        return;
      }
      if (!response.ok) throw new Error(`photo lookup returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!isDirectPhoto(payload, photoKey)) {
        setState({ kind: "invalid" });
        return;
      }
      setState({ kind: "ready", photo: payload });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ kind: navigator.onLine ? "error" : "offline" });
    }
  }, [event, photoKey]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (state.kind !== "ready" || saveError) statusRef.current?.focus();
  }, [saveError, state.kind]);

  const save = useCallback(async () => {
    if (state.kind !== "ready") return;
    setSaveError(false);
    try {
      await transferPublicPhoto(state.photo, browserTransferDeps());
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
