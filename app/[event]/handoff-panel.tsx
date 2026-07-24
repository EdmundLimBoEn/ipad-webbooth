"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { CurrentHandoff } from "./booth-session/handoff";
import styles from "./booth.module.css";

export type HandoffPanelProps = {
  handoff: CurrentHandoff;
  labels: {
    queued: string;
    title: string;
    body: string;
    viewPhoto: string;
    continue: string;
  };
  onContinue(): void;
};

export type QrImage = {
  captureId: string;
  galleryUrl: string;
  dataUrl: string;
};

export function isCurrentQrImage(
  handoff: CurrentHandoff,
  qr: QrImage | null,
): qr is QrImage {
  return handoff.status === "ready"
    && qr?.captureId === handoff.captureId
    && qr.galleryUrl === handoff.galleryUrl;
}

export function HandoffPanel({
  handoff,
  labels,
  onContinue,
}: HandoffPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [qr, setQr] = useState<QrImage | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [handoff.captureId]);

  useEffect(() => {
    let current = true;
    setQr(null);
    if (handoff.status !== "ready") return () => {
      current = false;
    };
    const { captureId, galleryUrl } = handoff;
    void QRCode.toDataURL(galleryUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    }).then((dataUrl) => {
      if (current) setQr({ captureId, galleryUrl, dataUrl });
    }).catch(() => {
      // The exact text link remains available if local QR generation fails.
    });
    return () => {
      current = false;
    };
  }, [handoff]);

  const exactQr = isCurrentQrImage(handoff, qr) ? qr : null;

  return (
    <section className={styles.handoff} aria-labelledby="handoff-title">
      <div className={styles.handoffPanel}>
        <h1 id="handoff-title" ref={headingRef} tabIndex={-1}>
          {handoff.status === "ready" ? labels.title : labels.queued}
        </h1>
        {handoff.status === "waiting" ? (
          <p role="status" aria-live="polite">{labels.queued}</p>
        ) : (
          <>
            <p>{labels.body}</p>
            {exactQr && (
              // Generated locally from the same value used by the visible anchor.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className={styles.handoffQr}
                src={exactQr.dataUrl}
                alt=""
                data-gallery-url={exactQr.galleryUrl}
              />
            )}
            <a
              className={styles.handoffLink}
              href={handoff.galleryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {labels.viewPhoto}
            </a>
          </>
        )}
        <button className={styles.handoffContinue} type="button" onClick={onContinue}>
          {labels.continue}
        </button>
      </div>
    </section>
  );
}
