"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
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
import { BROWSE_FEED_PROFILE } from "@/app/photo-feed/controller";
import type { FeedPhoto } from "@/app/photo-feed/types";
import { usePhotoFeed } from "@/app/photo-feed/use-photo-feed";
import { exactGalleryUrl } from "./photo-actions";
import { PhotoLightbox } from "./photo-lightbox";
import { anchoredScrollTop, chooseScrollAnchor, type ScrollAnchor } from "./scroll-anchor";
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

type BrowseHistory = Pick<History, "pushState" | "replaceState">;

export function browseGalleryUrl(origin: string, event: string): string {
  return new URL(`/${encodeURIComponent(event)}/gallery`, origin).toString();
}

export function openBrowsePhoto(
  history: BrowseHistory,
  origin: string,
  event: string,
  completeKey: string,
): string {
  const url = exactGalleryUrl(origin, event, completeKey);
  history.pushState(null, "", url);
  return url;
}

export function restoreBrowseUrl(
  history: BrowseHistory,
  origin: string,
  event: string,
): string {
  const url = browseGalleryUrl(origin, event);
  history.replaceState(null, "", url);
  return url;
}

export function mergeBrowsePhotos(
  feedPhotos: readonly FeedPhoto[],
  directPhoto: FeedPhoto | null,
): FeedPhoto[] {
  void directPhoto;
  // The server feed is authoritative for newest-first browse ordering. A
  // direct handoff may be older than the initial feed window, so it stays in
  // the lightbox until its exact key naturally arrives in the feed.
  return feedPhotos as FeedPhoto[];
}

export function correlateSelectedPhoto(
  selected: FeedPhoto | null,
  feedPhotos: readonly FeedPhoto[],
): FeedPhoto | null {
  if (!selected) return null;
  return feedPhotos.find((photo) => photo.key === selected.key) ?? selected;
}

type BrowseGalleryViewProps = {
  locale: SupportedLocale;
  photos: readonly FeedPhoto[];
  feedStatus: "loading" | "ready" | "error";
  feedError: string | null;
  directState: HandoffGalleryState | null;
  newPhotoCount: number;
  onOpen(photo: FeedPhoto): void;
  onRetryFeed(): void;
  onRetryDirect(): void;
  onJumpLatest(): void;
  gridRef?: Ref<HTMLDivElement>;
};

export function BrowseGalleryView({
  locale,
  photos,
  feedStatus,
  feedError,
  directState,
  newPhotoCount,
  onOpen,
  onRetryFeed,
  onRetryDirect,
  onJumpLatest,
  gridRef,
}: BrowseGalleryViewProps) {
  const direction = localeDirection(locale);
  const directFailure = directState
    && directState.kind !== "ready"
    && directState.kind !== "loading"
    ? directState
    : null;

  return (
    <main className={styles.browse} lang={locale} dir={direction}>
      <header className={styles.browseHeader}>
        <p className={styles.browseEyebrow}>{message(locale, "liveGallery")}</p>
        <h1>{message(locale, "galleryBrowseTitle")}</h1>
      </header>

      {newPhotoCount > 0 ? (
        <aside className={styles.newPhotoNotice} aria-live="polite">
          <strong>{message(locale, "galleryNewPhotos", { count: newPhotoCount })}</strong>
          <button type="button" onClick={onJumpLatest}>
            {message(locale, "galleryJumpLatest")}
          </button>
        </aside>
      ) : null}

      {directState?.kind === "loading" ? (
        <section className={styles.inlineStatus} role="status" aria-live="polite">
          {message(locale, "galleryLoading")}
        </section>
      ) : null}
      {directFailure ? (
        <section className={styles.inlineError} role="alert">
          <p>{stateMessage(locale, directFailure)}</p>
          <button type="button" onClick={onRetryDirect}>
            {message(locale, "galleryRetry")}
          </button>
        </section>
      ) : null}

      {photos.length === 0 && feedStatus === "loading" ? (
        <section className={styles.browseEmpty} role="status" aria-live="polite">
          <span className={styles.browsePulse} />
          <p>{message(locale, "galleryBrowseLoading")}</p>
        </section>
      ) : null}
      {photos.length === 0 && feedStatus === "ready" ? (
        <section className={styles.browseEmpty}>
          <h2>{message(locale, "galleryBrowseEmpty")}</h2>
          <p>{message(locale, "galleryBrowseEmptyBody")}</p>
        </section>
      ) : null}
      {feedStatus === "error" ? (
        <section className={styles.inlineError} role="alert">
          <strong>{message(locale, "galleryConnectionLost")}</strong>
          {feedError ? <p>{feedError}</p> : null}
          <button type="button" onClick={onRetryFeed}>
            {message(locale, "galleryRetry")}
          </button>
        </section>
      ) : null}

      <div ref={gridRef} className={styles.browseGrid} aria-label={message(locale, "galleryBrowseTitle")}>
        {photos.map((photo) => (
          <button
            key={photo.key}
            className={styles.browseTile}
            type="button"
            data-photo-key={photo.key}
            aria-label={message(locale, "galleryPhotoLabel")}
            onClick={() => onOpen(photo)}
          >
            <img src={photo.url} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </main>
  );
}

export default function HandoffGallery() {
  const { event } = useParams<{ event: string }>();
  const params = useSearchParams();
  const photoKey = params ? parseDirectPhotoQuery(params) : null;
  const hasPhotoQuery = (params?.getAll("photo").length ?? 0) > 0;
  const feed = usePhotoFeed(event, BROWSE_FEED_PROFILE);
  const [directState, setDirectState] = useState<HandoffGalleryState | null>(
    photoKey ? { kind: "loading" } : hasPhotoQuery ? { kind: "invalid" } : null
  );
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [origin, setOrigin] = useState("");
  const [newPhotoCount, setNewPhotoCount] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<(ScrollAnchor & { scrollTop: number }) | null>(null);
  const selectedRef = useRef<FeedPhoto | null>(null);
  const browseTriggerRef = useRef<HTMLElement | null>(null);
  const browseTriggerKeyRef = useRef<string | null>(null);
  const controllerRef = useRef<HandoffGalleryController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new HandoffGalleryController({
      fetchPhoto: (url, init) => fetch(url, init),
      isOnline: () => navigator.onLine,
      onState: (state) => {
        if (state.kind === "ready") selectedRef.current = state.photo;
        setDirectState(state);
      },
    });
  }

  useEffect(() => {
    setLocale(initialLocale(event));
    setOrigin(window.location.origin);
  }, [event]);

  useEffect(() => {
    applyDocumentLocale(document.documentElement, locale);
  }, [locale]);

  const loadDirect = useCallback(async () => {
    if (!photoKey) return;
    await controllerRef.current!.load(event, photoKey);
  }, [event, photoKey]);

  useEffect(() => {
    if (!photoKey) {
      controllerRef.current?.cancel();
      selectedRef.current = null;
      setDirectState(hasPhotoQuery ? { kind: "invalid" } : null);
      return;
    }
    if (selectedRef.current?.key === photoKey) {
      setDirectState({ kind: "ready", photo: selectedRef.current });
      return;
    }
    void loadDirect();
    return () => {
      controllerRef.current?.cancel();
    };
  }, [hasPhotoQuery, loadDirect, photoKey]);

  const captureAnchor = useCallback(() => {
    if (window.scrollY <= 0 || !gridRef.current) {
      anchorRef.current = null;
      return;
    }
    const visible = Array.from(
      gridRef.current.querySelectorAll<HTMLElement>("[data-photo-key]")
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        key: element.dataset.photoKey ?? "",
        top: rect.top,
        bottom: rect.bottom,
      };
    }).filter((item) => item.top < window.innerHeight);
    const anchor = chooseScrollAnchor(visible);
    anchorRef.current = anchor ? { ...anchor, scrollTop: window.scrollY } : null;
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", captureAnchor, { passive: true });
    captureAnchor();
    return () => window.removeEventListener("scroll", captureAnchor);
  }, [captureAnchor]);

  useLayoutEffect(() => {
    const prior = anchorRef.current;
    if (feed.inserted.length > 0 && prior && gridRef.current) {
      const match = Array.from(
        gridRef.current.querySelectorAll<HTMLElement>("[data-photo-key]")
      ).find((element) => element.dataset.photoKey === prior.key);
      if (match) {
        window.scrollTo({
          top: anchoredScrollTop({
            previousScrollTop: prior.scrollTop,
            beforeTop: prior.top,
            afterTop: match.getBoundingClientRect().top,
          }),
          behavior: "auto",
        });
        setNewPhotoCount((count) => count + feed.inserted.length);
      }
    }
    captureAnchor();
  }, [captureAnchor, feed.inserted, feed.photos]);

  const selected = useMemo(
    () => correlateSelectedPhoto(
      directState?.kind === "ready" ? directState.photo : null,
      feed.photos
    ),
    [directState, feed.photos]
  );

  const photos = useMemo(
    () => mergeBrowsePhotos(feed.photos, selected),
    [feed.photos, selected]
  );

  const openPhoto = useCallback((photo: FeedPhoto) => {
    browseTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    browseTriggerKeyRef.current = photo.key;
    selectedRef.current = photo;
    setDirectState({ kind: "ready", photo });
    openBrowsePhoto(window.history, window.location.origin, event, photo.key);
  }, [event]);

  const closePhoto = useCallback(() => {
    const trigger = browseTriggerRef.current;
    const triggerKey = browseTriggerKeyRef.current;
    browseTriggerRef.current = null;
    browseTriggerKeyRef.current = null;
    controllerRef.current?.cancel();
    selectedRef.current = null;
    setDirectState(null);
    restoreBrowseUrl(window.history, window.location.origin, event);
    window.requestAnimationFrame(() => {
      const currentTrigger = triggerKey
        ? Array.from(document.querySelectorAll<HTMLElement>("[data-photo-key]"))
          .find((element) => element.dataset.photoKey === triggerKey)
        : null;
      (currentTrigger ?? (trigger?.isConnected ? trigger : null))?.focus();
    });
  }, [event]);

  const jumpLatest = useCallback(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    setNewPhotoCount(0);
    anchorRef.current = null;
  }, []);

  return (
    <>
    <BrowseGalleryView
      locale={locale}
      photos={photos}
      feedStatus={feed.status}
      feedError={feed.error}
      directState={directState}
      newPhotoCount={newPhotoCount}
      onOpen={openPhoto}
      onRetryFeed={feed.refresh}
      onRetryDirect={() => { void loadDirect(); }}
      onJumpLatest={jumpLatest}
      gridRef={gridRef}
    />
    {selected && origin ? (
      <PhotoLightbox
        event={event}
        photo={selected}
        origin={origin}
        labels={{
          title: message(locale, "galleryLightboxTitle"),
          photoAlt: message(locale, "galleryPhotoAlt"),
          save: message(locale, "gallerySave"),
          share: message(locale, "galleryShare"),
          close: message(locale, "galleryClose"),
          previous: message(locale, "galleryPrevious"),
          next: message(locale, "galleryNext"),
          working: message(locale, "galleryWorking"),
          actionError: message(locale, "galleryActionError"),
        }}
        onClose={closePhoto}
      />
    ) : null}
    </>
  );
}
