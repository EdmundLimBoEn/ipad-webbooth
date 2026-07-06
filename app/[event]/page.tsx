"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./booth.module.css";
import { TEMPLATES, availableTemplates, composite } from "../templates";

type Status = "starting" | "picking" | "ready" | "denied" | "running" | "uploading";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Booth() {
  const { event } = useParams<{ event: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const unmountedRef = useRef(false);
  const [status, setStatus] = useState<Status>("starting");
  const [mode, setMode] = useState<keyof typeof TEMPLATES | null>(null);
  const [count, setCount] = useState(0);
  const [shot, setShot] = useState(0); // e.g. 2 of 3
  const [flash, setFlash] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // a composited photo whose upload failed — kept so the guest can retry
  // instead of silently losing their shots to flaky venue Wi-Fi
  const [pending, setPending] = useState<Blob | null>(null);
  // per-event frame allowlist from /api/config; null (no config / not loaded
  // yet / fetch failed) degrades to defaults-only, never to all frames
  const [enabled, setEnabled] = useState<string[] | null>(null);

  useEffect(() => {
    fetch(`/api/config?event=${encodeURIComponent(event)}`)
      .then((r) => r.json())
      .then((d) => setEnabled(Array.isArray(d.frames) ? d.frames : null))
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

  const upload = useCallback(
    async (blob: Blob) => {
      setStatus("uploading");
      try {
        const res = await fetch(`/api/upload?event=${encodeURIComponent(event)}`, {
          method: "POST",
          headers: { "x-booth-key": keyRef.current, "content-type": "image/jpeg" },
          body: blob,
        });
        if (res.status === 401) {
          // wrong key: forget it so Retry re-prompts instead of looping
          localStorage.removeItem(storageKey);
          keyRef.current = "";
          throw new Error("Wrong booth key — tap Retry upload to re-enter it");
        }
        if (!res.ok) throw new Error(`Upload failed (${res.status}) — tap Retry upload`);
        const { url } = await res.json();
        setLastUrl(url);
        setPending(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPending(blob); // keep the photo; don't lose the guest's shots
      } finally {
        // every photo returns to the frame picker — each guest picks manually,
        // the previous guest's mode never carries over. (Camera-denied fallback
        // returns to its own screen instead.)
        setMode(null);
        setStatus(streamRef.current ? "picking" : "denied");
      }
    },
    [event, storageKey]
  );

  const retryUpload = useCallback(() => {
    if (!pending) return;
    if (!keyRef.current) promptKey();
    upload(pending);
  }, [pending, promptKey, upload]);

  // take the whole sequence for the chosen mode, composite, upload
  const run = useCallback(async () => {
    if (status !== "ready" || !mode) return;
    const t = TEMPLATES[mode];
    setStatus("running");
    try {
      const frames: HTMLCanvasElement[] = [];
      for (let i = 0; i < t.shots; i++) {
        setShot(t.shots > 1 ? i + 1 : 0);
        for (let n = Math.round(t.intervalMs / 1000); n >= 1; n--) {
          setCount(n);
          await sleep(1000);
        }
        setCount(0);
        setFlash(true);
        frames.push(grabFrame());
        await sleep(300);
        setFlash(false);
        if (i < t.shots - 1) await sleep(400); // brief pause between shots
      }
      setShot(0);
      const blob = await composite(
        frames,
        frames.map((f) => ({ w: f.width, h: f.height })),
        t
      );
      await upload(blob);
    } catch (e) {
      // composite (frame art fetch, toBlob) failed — surface it and recover
      // instead of leaving the booth stuck in "running" until a reload
      setError(e instanceof Error ? e.message : String(e));
      setShot(0);
      setCount(0);
      setFlash(false);
      setMode(null);
      setStatus(streamRef.current ? "picking" : "denied");
    }
  }, [status, mode, grabFrame, upload]);

  // fallback: native file input (camera) when getUserMedia is blocked.
  // Re-encode to a real JPEG first — iPhones hand back HEIC, and the stored
  // key/content-type is always .jpg / image/jpeg.
  // ponytail: fallback photos stay frameless; compositing needs the live capture flow.
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
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
        // undecodable file: send as-is and let the server's signature check decide
      }
      await upload(blob);
    },
    [upload]
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

      {(status === "ready" || status === "running" || status === "uploading") && (
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
            {status === "uploading" ? "…" : status === "running" ? "" : mode && TEMPLATES[mode].shots > 1 ? "▶" : ""}
          </button>
          <button className={styles.change} onClick={() => setStatus("picking")} disabled={status !== "ready"}>
            {mode && TEMPLATES[mode].label} · change
          </button>
          <a className={styles.liveLink} href={`/${event}/live`} target="_blank" rel="noreferrer">
            Live →
          </a>
        </div>
      )}

      {pending && status !== "uploading" && status !== "running" && (
        <button className={styles.retry} onClick={retryUpload}>
          ⟳ Retry upload
        </button>
      )}
      {error && <div className={styles.error} onClick={() => setError(null)}>{error}</div>}
    </main>
  );
}
