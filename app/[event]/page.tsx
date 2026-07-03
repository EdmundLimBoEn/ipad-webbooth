"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./booth.module.css";
import { TEMPLATES, composite } from "../templates";

type Status = "starting" | "picking" | "ready" | "denied" | "running" | "uploading";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Booth() {
  const { event } = useParams<{ event: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [mode, setMode] = useState<keyof typeof TEMPLATES | null>(null);
  const [count, setCount] = useState(0);
  const [shot, setShot] = useState(0); // e.g. 2 of 3
  const [flash, setFlash] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ask for the upload key once, keep it in localStorage
  const keyRef = useRef<string>("");
  useEffect(() => {
    let k = localStorage.getItem("boothKey");
    if (!k) {
      k = window.prompt("Enter booth upload key") ?? "";
      if (k) localStorage.setItem("boothKey", k);
    }
    keyRef.current = k;
  }, []);

  const startCamera = useCallback(async () => {
    setStatus("starting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
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
    startCamera();
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
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
        if (!res.ok) throw new Error(res.status === 401 ? "Wrong upload key" : `Upload failed (${res.status})`);
        const { url } = await res.json();
        setLastUrl(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStatus("ready");
      }
    },
    [event]
  );

  // take the whole sequence for the chosen mode, composite, upload
  const run = useCallback(async () => {
    if (status !== "ready" || !mode) return;
    const t = TEMPLATES[mode];
    setStatus("running");
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
  }, [status, mode, grabFrame, upload]);

  // fallback: native file input (camera) when getUserMedia is blocked
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) await upload(file);
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
      <video
        ref={videoRef}
        className={`${styles.video} ${framed ? styles.framed : ""}`}
        style={framed ? { aspectRatio: String(previewAspect) } : undefined}
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
          <h1>Pick a style</h1>
          <div className={styles.choices}>
            {(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]).map((k) => {
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
            <img src={lastUrl} alt="last" className={styles.thumb} />
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

      {error && <div className={styles.error} onClick={() => setError(null)}>{error}</div>}
    </main>
  );
}
