"use client";

import { useEffect, useRef } from "react";
import type { SupportedLocale } from "../../i18n/catalog";
import { localeDirection, message } from "../../i18n/catalog";
import { formatLocalizedDateTime } from "../../i18n/locale";
import type { ModerationPhoto } from "../../moderation";
import styles from "./admin.module.css";

type ModerationDialogProps = {
  locale: SupportedLocale;
  photo: ModerationPhoto;
  position: number;
  loadedCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
  confirming: boolean;
  deleting: boolean;
  cleanupPending: boolean;
  error: string;
  timeZone?: string;
  returnFocus: HTMLElement | null;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function filename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

export function ModerationDialog({
  locale,
  photo,
  position,
  loadedCount,
  hasPrevious,
  hasNext,
  confirming,
  deleting,
  cleanupPending,
  error,
  timeZone,
  returnFocus,
  onPrevious,
  onNext,
  onClose,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: ModerationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const text = (key: Parameters<typeof message>[1], values?: Record<string, string | number>) =>
    message(locale, key, values);
  const exactFilename = filename(photo.key);
  const displayDate = formatLocalizedDateTime(photo.capturedAt, locale, timeZone);

  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  return (
    <div className={styles.moderationBackdrop}>
      <div
        ref={dialogRef}
        className={styles.moderationDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="moderation-dialog-title"
        dir={localeDirection(locale)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowLeft" && hasPrevious) {
            event.preventDefault();
            onPrevious();
            return;
          }
          if (event.key === "ArrowRight" && hasNext) {
            event.preventDefault();
            onNext();
            return;
          }
          if (event.key !== "Tab" || !dialogRef.current) return;
          const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className={styles.moderationDialogHead}>
          <div>
            <p>{text("moderationPosition", { position, count: loadedCount })}</p>
            <h2 id="moderation-dialog-title">{text("moderationInspectTitle")}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose}>
            {text("moderationClose")}
          </button>
        </header>

        <figure className={styles.moderationInspection}>
          <img
            src={photo.url}
            alt={text("moderationPhotoAlt", { date: displayDate })}
          />
          <figcaption>
            <time dateTime={photo.uploadedAt}>{displayDate}</time>
            <bdi><code>{exactFilename}</code></bdi>
          </figcaption>
        </figure>

        <nav className={styles.moderationDialogNav} aria-label={text("moderationInspectTitle")}>
          <button type="button" onClick={onPrevious} disabled={!hasPrevious}>
            ← {text("moderationPrevious")}
          </button>
          <button type="button" onClick={onNext} disabled={!hasNext}>
            {text("moderationNext")} →
          </button>
        </nav>

        {cleanupPending && (
          <p className={styles.moderationCleanup} role="status">
            {text("moderationCleanupPending")}
          </p>
        )}
        {error && <p className={styles.moderationDialogError} role="alert">{error}</p>}

        {confirming ? (
          <section className={styles.moderationConfirm} aria-labelledby="moderation-confirm-title">
            <h3 id="moderation-confirm-title">{text("moderationConfirmTitle")}</h3>
            <p>{text("moderationConfirmBody", { filename: exactFilename })}</p>
            <p>
              <span>{text("moderationCompleteKey")}</span>
              <bdi><code>{photo.key}</code></bdi>
            </p>
            <div>
              <button type="button" onClick={onConfirmDelete} disabled={deleting}>
                {deleting ? text("moderationRemoving") : text("moderationConfirmDelete")}
              </button>
              <button type="button" onClick={onCancelDelete} disabled={deleting}>
                {text("moderationCancel")}
              </button>
            </div>
          </section>
        ) : (
          !cleanupPending && (
            <button
              className={styles.moderationRemove}
              type="button"
              onClick={onRequestDelete}
            >
              {text("moderationRemove")}
            </button>
          )
        )}
      </div>
    </div>
  );
}
