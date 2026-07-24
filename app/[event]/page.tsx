"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./booth.module.css";
import { TEMPLATES, availableTemplates, composite } from "../templates";
import { createOutboxStore, type OutboxItem } from "./booth-session/outbox";
import { BoothSession, runCaptureSequence, type UploadState } from "./booth-session/session";
import { outboxUploadHeaders } from "./booth-session/upload";
import { HttpUploadError, type UploadErrorClass } from "./booth-session/retry-policy";

type Status = "starting" | "picking" | "ready" | "denied" | "running";

function uploadErrorClass(status: number): UploadErrorClass {
  if (status === 401) return "auth";
  if (status === 408 || status === 425 || status === 429) return "timeout";
  if (status >= 500) return "server";
  if (status === 400 || status === 403 || status === 413 || status === 415) return "payload";
  return "unknown";
}

export default function Booth() {
  const { event } = useParams<{ event: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<BoothSession | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);
  const [status, setStatus] = useState<Status>("starting");
  const [mode, setMode] = useState<keyof typeof TEMPLATES | null>(null);
  const [count, setCount] = useState(0);
  const [shot, setShot] = useState(0); // e.g. 2 of 3
  const [flash, setFlash] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({
    status: "idle",
    pendingCount: 0,
    error: null,
    durable: true,
  });
  // per-event frame allowlist from /api/config; null (no config / not loaded
  // yet / fetch failed) degrades to defaults-only, never to all frames
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [configRevisionId, setConfigRevisionId] = useState<string | undefined>();

  useEffect(() => {
    fetch(`/api/config?event=${encodeURIComponent(event)}`)
      .then((r) => r.json())
      .then((d) => {
        setEnabled(Array.isArray(d.frames) ? d.frames : null);
        setConfigRevisionId(typeof d.currentRevisionId === "string" ? d.currentRevisionId : undefined);
      })
      .catch(() => {});
  }, [event]);

  // this event's booth key (set per event in /{event}/admin) — asked once,
  // kept in localStorage namespaced by event, cleared + re-asked on 401
  const keyRef = useRef<string>("");
  const storageKey = `boothKey:${event}`;
  const promptKey = useCallback(() => {
    const k = window.prompt("Enter this event's booth key") ?? "";
    if (k) localStorage.setItem(storageKey, k);
    else localStorage.removeItem(storageKey);
    keyRef.current = k;
  }, [storageKey]);
  useEffect(() => {
    const k = localStorage.getItem(storageKey);
    if (k) keyRef.current = k;
    else promptKey();
  }, [storageKey, promptKey]);

  const startCamera = useCallback(async () => {
    setStatus("starting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // unmounted while getUserMedia was pending: stop the tracks now or the
      // camera light stays on with nothing to clean it up
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus("picking");
    } catch (e) {
      setStatus("denied");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    startCamera();
    return () => {
      unmountedRef.current = true;
      captureRef.current?.abort();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [startCamera]);

  // grab the current video frame, mirrored to match the preview, at full res
  const grabFrame = useCallback((): HTMLCanvasElement => {
    const video = videoRef.current!;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
    return c;
  }, []);

  const uploadOne = useCallback(
    async (item: OutboxItem) => {
      const res = await fetch(`/api/upload?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: {
          "x-booth-key": keyRef.current,
          "content-type": "image/jpeg",
          ...outboxUploadHeaders(item),
        },
        body: item.blob,
      });
      if (!res.ok) {
        throw new HttpUploadError(
          res.status,
          res.headers.get("retry-after"),
          uploadErrorClass(res.status)
        );
      }
      return res.json() as Promise<{ url: string; key?: string; duplicate?: boolean }>;
    },
    [event]
  );

  useEffect(() => {
    let active = true;
    const session = new BoothSession(
      event,
      createOutboxStore(),
      uploadOne,
      ({ url }) => setLastUrl(url),
      undefined,
      undefined,
      {
        onAuthRequired: () => {
          // Keep the existing credential lifecycle: clear the rejected Booth
          // Key and let the retained manual Retry control prompt for a new one.
          localStorage.removeItem(storageKey);
          keyRef.current = "";
        },
      }
    );
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setUploadState);
    const reconsiderConnectivity = () => void session.reconsider("connectivity");
    const reconsiderForeground = () => {
      if (document.visibilityState === "visible") void session.reconsider("foreground");
    };
    window.addEventListener("online", reconsiderConnectivity);
    document.addEventListener("visibilitychange", reconsiderForeground);
    // Task 4 will add strict preflight. Until then, recovery plus the existing
    // Booth Key lifecycle is the only available start condition.
    void session.recover().then(() => {
      if (active) void session.start();
    });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("online", reconsiderConnectivity);
      document.removeEventListener("visibilitychange", reconsiderForeground);
      if (sessionRef.current === session) sessionRef.current = null;
      void session.stop();
    };
  }, [event, storageKey, uploadOne]);

  const retryUpload = useCallback(() => {
    if (!uploadState.pendingCount) return;
    if (!keyRef.current) promptKey();
    void sessionRef.current?.retry();
  }, [uploadState.pendingCount, promptKey]);

  // take the whole sequence for the chosen mode, composite, upload
  const run = useCallback(async () => {
    if (status !== "ready" || !mode) return;
    const t = TEMPLATES[mode];
    setStatus("running");
    const controller = new AbortController();
    captureRef.current = controller;
    try {
      const session = sessionRef.current;
      if (!session) throw new Error("Photo queue is still starting — please try again");
      await session.enqueueCapture(
        async (signal) => {
          const frames = await runCaptureSequence({
            shots: t.shots,
            intervalMs: t.intervalMs,
            signal,
            captureFrame: grabFrame,
            onCountdown: (nextCount, nextShot) => {
              setCount(nextCount);
              setShot(nextShot);
            },
            onFlash: setFlash,
          });
          return composite(frames, frames.map((f) => ({ w: f.width, h: f.height })), t);
        },
        {
          signal: controller.signal,
          metadata: {
            source: "framed",
            frameKey: mode,
            ...(configRevisionId ? { configRevisionId } : {}),
          },
        }
      );
      // Durable handoff is complete. Return to the picker before uploading so
      // the next guest is never trapped on the previous guest's frame.
      setError(null);
      setMode(null);
      setStatus("picking");
      void session.process();
    } catch (e) {
      // composite (frame art fetch, toBlob) failed — surface it and recover
      // instead of leaving the booth stuck in "running" until a reload
      setError(e instanceof Error ? e.message : String(e));
      setShot(0);
      setCount(0);
      setFlash(false);
      setMode(null);
      setStatus(streamRef.current ? "picking" : "denied");
    } finally {
      if (captureRef.current === controller) captureRef.current = null;
    }
  }, [status, mode, grabFrame]);

  // fallback: native file input (camera) when getUserMedia is blocked.
  // Re-encode to a real JPEG first — iPhones hand back HEIC, and the stored
  // key/content-type is always .jpg / image/jpeg.
  // ponytail: fallback photos stay frameless; compositing needs the live capture flow.
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const session = sessionRef.current;
        if (!session) throw new Error("Photo queue is still starting — please try again");
        await session.enqueueCapture(async () => {
          let blob: Blob = file;
          try {
            const bmp = await createImageBitmap(file);
            const c = document.createElement("canvas");
            c.width = bmp.width;
            c.height = bmp.height;
            c.getContext("2d")!.drawImage(bmp, 0, 0);
            blob = await new Promise<Blob>((res, rej) =>
              c.toBlob((b) => (b ? res(b) : rej(new Error("re-encode failed"))), "image/jpeg", 0.9)
            );
          } catch {
            // Undecodable file: preserve it; the server signature check decides.
          }
          return blob;
        }, {
          metadata: {
            source: "camera-fallback",
            ...(configRevisionId ? { configRevisionId } : {}),
          },
        });
        setError(null);
        void session.process();
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
      }
    },
    [configRevisionId]
  );

  const pick = (m: keyof typeof TEMPLATES) => {
    setMode(m);
    setStatus("ready");
  };

  // preview crops to the chosen frame's photo aspect (w/h of its first slot),
  // so guests see exactly what will be captured. Fullscreen until a mode is set.
  const previewAspect = mode ? TEMPLATES[mode].slots[0].w / TEMPLATES[mode].slots[0].h : null;
  const framed = mode !== null && status !== "picking";

  return (
    <main className={styles.booth}>
      {/* framed box is exactly the slot's aspect at the largest size that fits,
          so the cover-cropped preview is edge-to-edge what composite() captures */}
      <video
        ref={videoRef}
        className={`${styles.video} ${framed ? styles.framed : ""}`}
        style={
          framed
            ? { aspectRatio: String(previewAspect), width: `min(100dvw, ${previewAspect} * 100dvh)` }
            : undefined
        }
        playsInline
        muted
      />
      {flash && <div className={styles.flash} />}
      {count > 0 && (
        <div className={styles.count}>
          {count}
          {shot > 0 && <span className={styles.shot}>{shot} / {mode && TEMPLATES[mode].shots}</span>}
        </div>
      )}

      {status === "picking" && (
        <div className={styles.picker}>
          {lastUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastUrl} alt="Last photo" className={styles.thumb} />
          )}
          <h1>Pick a style</h1>
          {availableTemplates(enabled).length === 0 && (
            <p>No frames are enabled for this event yet.</p>
          )}
          <div className={styles.choices}>
            {availableTemplates(enabled).map((k) => {
              const t = TEMPLATES[k];
              return (
                <button key={k} className={styles.choice} onClick={() => pick(k)}>
                  {t.bgImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.bgImage} alt="" className={styles.iconFrame} />
                  ) : (
                    <span className={`${styles.icon} ${styles.iconSquare}`} />
                  )}
                  {t.label}
                  <small>{t.shots === 1 ? "1 photo" : `${t.shots} photos`}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {status === "denied" && (
        <div className={styles.picker}>
          <p>Camera unavailable. Use your device camera instead:</p>
          <label className={styles.fileBtn}>
            Take a photo
            <input type="file" accept="image/*" capture="user" onChange={onFile} hidden />
          </label>
        </div>
      )}

      {(status === "ready" || status === "running") && (
        <div className={styles.bottom}>
          {lastUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastUrl} alt="Last photo" className={styles.thumb} />
          )}
          <button
            className={styles.shutter}
            onClick={run}
            disabled={status !== "ready"}
            aria-label="Start"
          >
            {status === "running" ? "" : mode && TEMPLATES[mode].shots > 1 ? "▶" : ""}
          </button>
          <button className={styles.change} onClick={() => setStatus("picking")} disabled={status !== "ready"}>
            {mode && TEMPLATES[mode].label} · change
          </button>
          <a className={styles.liveLink} href={`/${event}/live`} target="_blank" rel="noreferrer">
            Live →
          </a>
        </div>
      )}

      {uploadState.pendingCount > 0 && status !== "running" && (
        <button
          className={styles.retry}
          onClick={retryUpload}
          disabled={uploadState.status === "uploading"}
          aria-live="polite"
        >
          {uploadState.status === "uploading"
            ? `Uploading ${uploadState.pendingCount}…`
            : `⟳ Retry ${uploadState.pendingCount} pending`}
        </button>
      )}
      {(error || uploadState.error) && (
        <div className={styles.error} onClick={() => setError(null)}>
          {error || uploadState.error}
        </div>
      )}
      {!uploadState.durable && (
        <div className={styles.storageWarning} role="status">
          Offline photo storage is unavailable. Pending photos may be lost if this page reloads.
        </div>
      )}
    </main>
  );
}
