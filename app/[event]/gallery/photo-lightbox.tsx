"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FeedPhoto } from "@/app/photo-feed/types";
import {
  browserPhotoActionDeps,
  exactGalleryUrl,
  savePhoto,
  sharePhoto,
  type PhotoActionDeps,
  type PrefetchedPhoto,
} from "./photo-actions";
import styles from "./gallery.module.css";

export type PhotoLightboxLabels = {
  title: string;
  photoAlt: string;
  save: string;
  share: string;
  close: string;
  previous: string;
  next: string;
  working: string;
  actionError: string;
};

type PhotoLightboxProps = {
  event: string;
  photo: FeedPhoto;
  origin: string;
  labels: PhotoLightboxLabels;
  onClose(): void;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  actionDeps?: PhotoActionDeps | undefined;
};

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute("aria-hidden"));
}

export function PhotoLightbox({
  event,
  photo,
  origin,
  labels,
  onClose,
  onPrevious,
  onNext,
  actionDeps,
}: PhotoLightboxProps) {
  const generatedTitleId = useId();
  const titleId = generatedTitleId
    ? `photo-lightbox-title-${generatedTitleId.replace(/:/g, "")}`
    : "photo-lightbox-title";
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const generationRef = useRef(0);
  const [prefetched, setPrefetched] = useState<PrefetchedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exactUrl = useMemo(
    () => exactGalleryUrl(origin, event, photo.key),
    [event, origin, photo.key]
  );
  const deps = useMemo(
    () => actionDeps ?? browserPhotoActionDeps(),
    [actionDeps]
  );

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();
    return () => restoreFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    setPrefetched(null);
    setError("");
    let active = true;
    void deps.fetchBlob(photo.url).then((blob) => {
      if (active && generationRef.current === generation) {
        setPrefetched({ key: photo.key, url: photo.url, blob });
      }
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [deps, photo.key, photo.url]);

  const act = useCallback(async (kind: "save" | "share") => {
    const generation = generationRef.current;
    setBusy(true);
    setError("");
    const input = { photo, prefetched, exactUrl, deps };
    const result = kind === "save" ? await savePhoto(input) : await sharePhoto(input);
    if (generationRef.current !== generation) return;
    setBusy(false);
    if (result.kind === "error") setError(labels.actionError);
  }, [deps, exactUrl, labels.actionError, photo, prefetched]);

  const onKeyDown = useCallback((keyboardEvent: React.KeyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      onClose();
      return;
    }
    if (keyboardEvent.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (keyboardEvent.shiftKey && document.activeElement === first) {
      keyboardEvent.preventDefault();
      last.focus();
    } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
      keyboardEvent.preventDefault();
      first.focus();
    }
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <div className={styles.lightboxHeader}>
        <h2 id={titleId}>{labels.title}</h2>
        <button
          ref={closeRef}
          className={styles.iconAction}
          type="button"
          aria-label={labels.close}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <img className={styles.lightboxPhoto} src={photo.url} alt={labels.photoAlt} />
      <div className={styles.lightboxActions}>
        {onPrevious ? (
          <button type="button" aria-label={labels.previous} onClick={onPrevious}>
            ←
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void act("save")}>
          {labels.save}
        </button>
        <button type="button" disabled={busy} onClick={() => void act("share")}>
          {labels.share}
        </button>
        {onNext ? (
          <button type="button" aria-label={labels.next} onClick={onNext}>
            →
          </button>
        ) : null}
      </div>
      <p className={styles.lightboxLink}>
        <a href={exactUrl}><bdi>{exactUrl}</bdi></a>
      </p>
      <p className={styles.srStatus} role="status" aria-live="polite">
        {busy ? labels.working : ""}
      </p>
      <p className={styles.srStatus} role="alert">
        {error}
      </p>
    </div>
  );
}
