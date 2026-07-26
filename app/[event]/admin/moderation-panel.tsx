"use client";

import type { SupportedLocale } from "../../i18n/catalog";
import { localeDirection, message } from "../../i18n/catalog";
import { formatLocalizedDateTime } from "../../i18n/locale";
import type { ModerationPhoto } from "../../moderation";
import styles from "./admin.module.css";
import type { ModerationFilters } from "./moderation-state";

export type ModerationRebuildState = {
  complete: boolean;
  scanned: number;
  indexed: number;
};

type ModerationPanelProps = {
  locale: SupportedLocale;
  photos: readonly ModerationPhoto[];
  filters: ModerationFilters;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  notice: string;
  rebuild: ModerationRebuildState | null;
  rebuilding: boolean;
  timeZone?: string;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  photoRefs?: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onFiltersChange: (filters: ModerationFilters) => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onOpen: (photo: ModerationPhoto, trigger: HTMLButtonElement) => void;
  onRebuild: () => void;
};

function filename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

export function ModerationPanel({
  locale,
  photos,
  filters,
  nextCursor,
  loading,
  loadingMore,
  error,
  notice,
  rebuild,
  rebuilding,
  timeZone,
  headingRef,
  photoRefs,
  onFiltersChange,
  onApplyFilters,
  onClearFilters,
  onLoadMore,
  onOpen,
  onRebuild,
}: ModerationPanelProps) {
  const text = (key: Parameters<typeof message>[1], values?: Record<string, string | number>) =>
    message(locale, key, values);

  return (
    <section
      className={styles.moderation}
      aria-labelledby="moderation-heading"
      dir={localeDirection(locale)}
    >
      <div className={styles.sectionHead}>
        <div>
          <span>04</span>
          <h2 id="moderation-heading" ref={headingRef} tabIndex={-1}>
            {text("moderationHeading")}
          </h2>
        </div>
        <p>{text("moderationIntro")}</p>
      </div>

      <form
        className={styles.moderationFilters}
        onSubmit={(event) => {
          event.preventDefault();
          onApplyFilters();
        }}
      >
        <label htmlFor="moderation-from">
          <span>{text("moderationFrom")}</span>
          <input
            id="moderation-from"
            type="datetime-local"
            value={filters.from}
            onChange={(event) => onFiltersChange({ ...filters, from: event.target.value })}
          />
        </label>
        <label htmlFor="moderation-to">
          <span>{text("moderationTo")}</span>
          <input
            id="moderation-to"
            type="datetime-local"
            value={filters.to}
            onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
          />
        </label>
        <div className={styles.moderationFilterActions}>
          <button type="submit" disabled={loading}>{text("moderationApply")}</button>
          <button type="button" onClick={onClearFilters} disabled={loading}>
            {text("moderationClear")}
          </button>
        </div>
      </form>

      <div className={styles.moderationSummary}>
        <strong>{text("moderationLoaded", { count: photos.length })}</strong>
        {loading && <span role="status">{text("moderationLoading")}</span>}
      </div>

      <div className={styles.moderationLive} aria-live="polite" aria-atomic="true">
        {notice}
      </div>
      <div className={styles.moderationAlert} role="alert" aria-atomic="true">
        {error}
      </div>

      {error && photos.length === 0 ? (
        <div className={styles.failure}>
          <strong>{text("moderationError")}</strong>
          <button type="button" onClick={onApplyFilters}>{text("moderationRetry")}</button>
        </div>
      ) : photos.length === 0 && !loading ? (
        <div className={styles.emptySheet}><strong>{text("moderationEmpty")}</strong></div>
      ) : (
        <ol className={styles.moderationGrid} aria-label={text("moderationHeading")}>
          {photos.map((photo) => {
            const displayDate = formatLocalizedDateTime(photo.capturedAt, locale, timeZone);
            const exactFilename = filename(photo.key);
            return (
              <li key={photo.key} className={styles.moderationTile}>
                <button
                  type="button"
                  ref={(element) => {
                    if (!photoRefs) return;
                    if (element) photoRefs.current.set(photo.key, element);
                    else photoRefs.current.delete(photo.key);
                  }}
                  onClick={(event) => onOpen(photo, event.currentTarget)}
                  aria-label={text("moderationOpenPhoto", { filename: exactFilename })}
                >
                  <img
                    src={photo.url}
                    alt={text("moderationPhotoAlt", { date: displayDate })}
                    loading="lazy"
                    decoding="async"
                  />
                  <span>
                    <time dateTime={photo.uploadedAt}>{displayDate}</time>
                    <bdi><code>{exactFilename}</code></bdi>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {nextCursor !== null && (
        <button
          className={styles.moderationLoadMore}
          type="button"
          onClick={onLoadMore}
          disabled={loading || loadingMore}
          aria-busy={loadingMore}
        >
          {loadingMore ? text("moderationLoadingMore") : text("moderationLoadMore")}
        </button>
      )}

      <aside className={styles.moderationRebuild} aria-labelledby="moderation-rebuild-heading">
        <div>
          <h3 id="moderation-rebuild-heading">{text("moderationRebuildHeading")}</h3>
          <p>{text("moderationRebuildIntro")}</p>
          {rebuild && (
            <p role="status">
              {rebuild.complete
                ? text("moderationRebuildComplete")
                : text("moderationRebuildProgress", {
                    scanned: rebuild.scanned,
                    indexed: rebuild.indexed,
                  })}
            </p>
          )}
        </div>
        {(!rebuild || !rebuild.complete) && (
          <button type="button" onClick={onRebuild} disabled={rebuilding}>
            {rebuilding
              ? text("moderationRebuilding")
              : rebuild
                ? text("moderationRebuildContinue")
                : text("moderationRebuildStart")}
          </button>
        )}
      </aside>
    </section>
  );
}
