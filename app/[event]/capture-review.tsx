"use client";

import { useEffect, useRef } from "react";
import styles from "./booth.module.css";

export type CaptureReviewProps = {
  canvas: HTMLCanvasElement;
  autoAcceptSeconds: number;
  accepting: boolean;
  error: string | null;
  labels: {
    usePhoto: string;
    retake: string;
    moreTime: string;
    accepting: string;
    preview: string;
  };
  onAccept(): void;
  onRetake(): void;
  onMoreTime(): void;
};

export function CaptureReview({
  canvas,
  autoAcceptSeconds,
  accepting,
  error,
  labels,
  onAccept,
  onRetake,
  onMoreTime,
}: CaptureReviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acceptRef = useRef(onAccept);
  acceptRef.current = onAccept;

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    canvas.setAttribute("aria-hidden", "true");
    canvas.classList.add(styles.reviewCanvas);
    preview.replaceChildren(canvas);
    return () => {
      if (canvas.parentNode === preview) preview.removeChild(canvas);
    };
  }, [canvas]);

  useEffect(() => {
    if (accepting || error || autoAcceptSeconds <= 0) return;
    timerRef.current = setTimeout(() => acceptRef.current(), autoAcceptSeconds * 1_000);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [accepting, autoAcceptSeconds, canvas, error]);

  const cancelTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  return (
    <section className={styles.review} aria-label={labels.preview}>
      <div
        ref={previewRef}
        className={styles.reviewPreview}
        role="img"
        aria-label={labels.preview}
      />
      <div className={styles.reviewActions}>
        <button
          className={styles.reviewPrimary}
          type="button"
          autoFocus
          disabled={accepting}
          onClick={() => {
            cancelTimer();
            onAccept();
          }}
        >
          {labels.usePhoto}
        </button>
        <button
          type="button"
          disabled={accepting}
          onClick={() => {
            cancelTimer();
            onRetake();
          }}
        >
          {labels.retake}
        </button>
        <button
          type="button"
          disabled={accepting}
          onClick={() => {
            cancelTimer();
            onMoreTime();
          }}
        >
          {labels.moreTime}
        </button>
      </div>
      <div className={styles.reviewAnnouncement} aria-live="polite">
        {accepting && <p role="status">{labels.accepting}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
