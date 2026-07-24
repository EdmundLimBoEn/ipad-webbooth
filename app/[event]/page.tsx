"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import styles from "./booth.module.css";
import { TEMPLATES, availableTemplates, composite } from "../templates";
import { createOutboxStore, type OutboxItem } from "./booth-session/outbox";
import {
  BoothSession,
  runCaptureSequence,
  type UploadResult,
  type UploadState,
} from "./booth-session/session";
import { outboxUploadHeaders } from "./booth-session/upload";
import { HttpUploadError, type UploadErrorClass } from "./booth-session/retry-policy";
import { loadOrCreateDeviceId } from "./booth-session/device-identity";
import {
  BoothHeartbeatReporter,
  BoothStatePoller,
  createBoothOperationalSessionState,
  type BoothOperationalClientState,
} from "./booth-session/operational-client";
import {
  parseBoothOperationalState,
  type BoothErrorClass,
  type BoothHeartbeatInput,
} from "../booth-control";
import { BoothPauseBoundary } from "./booth-session/pause-boundary";
import type { BoothAccessState } from "./booth-session/access";
import {
  clearBoothCredential,
  loadBoothCredential,
  saveBoothCredential,
} from "./booth-session/credential";
import {
  boothPreflightResultFromPayload,
  BoothLifecycleCoordinator,
  type BoothAccessFeedback,
  type BoothCredentialHolder,
  type BoothPreflightResult,
} from "./booth-session/lifecycle";
import { BoothUnlock } from "./booth-unlock";

type Status = "starting" | "picking" | "ready" | "denied" | "running";
type OperationalState = BoothOperationalClientState;

const INITIAL_UPLOAD_STATE: UploadState = {
  status: "idle",
  pendingCount: 0,
  error: null,
  durable: true,
};

function uploadErrorClass(status: number): UploadErrorClass {
  if (status === 401) return "auth";
  if (status === 408 || status === 425 || status === 429) return "timeout";
  if (status >= 500) return "server";
  if (status === 400 || status === 403 || status === 413 || status === 415) return "payload";
  return "unknown";
}

function isInstalled() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches
    || navigatorWithStandalone.standalone === true;
}

function heartbeatCamera(status: Status, paused: boolean): BoothHeartbeatInput["camera"] {
  if (paused) return "stopped";
  if (status === "starting") return "starting";
  if (status === "denied") return "denied";
  if (status === "picking" || status === "ready" || status === "running") return "ready";
  return "stopped";
}

function heartbeatUpload(upload: UploadState): BoothHeartbeatInput["upload"] {
  if (upload.status === "uploading") return "uploading";
  if (upload.status === "failed") return "blocked";
  return "idle";
}

function heartbeatError(
  status: Status,
  cameraError: Extract<BoothErrorClass, "camera-permission" | "camera-unavailable"> | null,
  upload: UploadState
): BoothErrorClass | undefined {
  if (status === "denied") return cameraError ?? "camera-unavailable";
  if (upload.status === "failed") return "unknown";
  return undefined;
}

async function requestBoothPreflight(
  event: string,
  key: string,
  signal: AbortSignal
): Promise<BoothPreflightResult> {
  const response = await fetch(
    `/api/booth/preflight?event=${encodeURIComponent(event)}`,
    {
      method: "POST",
      headers: { "x-booth-key": key },
      signal,
    }
  );
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 409 || response.status === 503) {
    return { kind: "unavailable" };
  }
  if (!response.ok) return { kind: "recovery-only" };
  return boothPreflightResultFromPayload(await response.json());
}

export default function Booth() {
  const { event } = useParams<{ event: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<BoothSession | null>(null);
  const statePollerRef = useRef<BoothStatePoller | null>(null);
  const heartbeatReporterRef = useRef<BoothHeartbeatReporter | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const cameraRequestRef = useRef(0);
  const unmountedRef = useRef(false);
  const deviceIdRef = useRef("");
  const sessionStartedAtRef = useRef(0);
  const operationalRef = useRef<OperationalState>({ paused: false, connected: false });
  const uploadStateRef = useRef<UploadState>(INITIAL_UPLOAD_STATE);
  const [status, setStatus] = useState<Status>("starting");
  const [accessState, setAccessState] = useState<BoothAccessState>("locked");
  const [accessFeedback, setAccessFeedback] =
    useState<BoothAccessFeedback>("recovering");
  const [outboxRecovered, setOutboxRecovered] = useState(false);
  const [mode, setMode] = useState<keyof typeof TEMPLATES | null>(null);
  const [count, setCount] = useState(0);
  const [shot, setShot] = useState(0); // e.g. 2 of 3
  const [flash, setFlash] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [lastSuccessfulUploadAt, setLastSuccessfulUploadAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraErrorClass, setCameraErrorClass] = useState<
    Extract<BoothErrorClass, "camera-permission" | "camera-unavailable"> | null
  >(null);
  const [operational, setOperational] = useState<OperationalState>({
    paused: false,
    connected: false,
  });
  const [online, setOnline] = useState(false);
  const [uploadState, setUploadState] =
    useState<UploadState>(INITIAL_UPLOAD_STATE);
  // Frames remain unavailable until authenticated preflight returns the safe
  // Event experience. `null` is never shown while the Booth is locked.
  const [enabled, setEnabled] = useState<string[] | null>(null);

  const startCamera = useCallback(async () => {
    if (operationalRef.current.paused || unmountedRef.current) return;
    const request = ++cameraRequestRef.current;
    setStatus("starting");
    setError(null);
    setCameraErrorClass(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // unmounted while getUserMedia was pending: stop the tracks now or the
      // camera light stays on with nothing to clean it up
      if (
        unmountedRef.current
        || operationalRef.current.paused
        || request !== cameraRequestRef.current
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (
        unmountedRef.current
        || operationalRef.current.paused
        || request !== cameraRequestRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
      setStatus("picking");
    } catch (e) {
      if (unmountedRef.current || request !== cameraRequestRef.current) return;
      setStatus("denied");
      setCameraErrorClass(
        e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
          ? "camera-permission"
          : "camera-unavailable"
      );
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopCamera = useCallback(() => {
    cameraRequestRef.current++;
    captureRef.current?.abort();
    captureRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const clearFrame = useCallback(() => {
    setMode(null);
    setShot(0);
    setCount(0);
    setFlash(false);
    setStatus("picking");
  }, []);

  const pauseBoundary = useMemo(
    () => new BoothPauseBoundary({
      clearFrame,
      stopCamera,
      startCamera: () => {
        void startCamera();
      },
    }),
    [clearFrame, startCamera, stopCamera]
  );

  const applyOperationalState = useCallback((next: OperationalState) => {
    operationalRef.current = next;
    setOperational(next);
    pauseBoundary.observe(next.paused);
  }, [pauseBoundary]);

  const lifecycle = useMemo(
    () => new BoothLifecycleCoordinator<UploadResult>({
      preflight: requestBoothPreflight,
      loadCredential: (nextEvent) =>
        loadBoothCredential(
          nextEvent,
          window.sessionStorage,
          window.localStorage
        ),
      clearCredential: (nextEvent) =>
        clearBoothCredential(
          nextEvent,
          window.sessionStorage,
          window.localStorage
        ),
      onReset: () => {
        const initial = createBoothOperationalSessionState(Date.now());
        pauseBoundary.reset();
        operationalRef.current = initial.operational;
        uploadStateRef.current = INITIAL_UPLOAD_STATE;
        deviceIdRef.current = loadOrCreateDeviceId(window.localStorage);
        sessionStartedAtRef.current = initial.sessionStartedAt;
        setStatus("starting");
        setMode(null);
        setLastUrl(null);
        setError(null);
        setCount(0);
        setShot(0);
        setFlash(false);
        setEnabled(null);
        setOutboxRecovered(false);
        setLastSuccessfulUploadAt(initial.lastSuccessfulUploadAt);
        setCameraErrorClass(initial.cameraErrorClass);
        setOperational(operationalRef.current);
        setOnline(navigator.onLine);
        setUploadState(INITIAL_UPLOAD_STATE);
      },
      onOutboxRecovered: () => setOutboxRecovered(true),
      onAccess: (state, feedback) => {
        if (state === "locked" && feedback === "rejected-key") {
          setStatus("starting");
          setMode(null);
          setError(null);
          setCount(0);
          setShot(0);
          setFlash(false);
        }
        setAccessState(state);
        setAccessFeedback(feedback);
      },
      onFrames: setEnabled,
      onOperationalState: (value) => {
        const state = parseBoothOperationalState(value);
        if (state) {
          applyOperationalState({ paused: state.paused, connected: true });
        }
      },
      onCameraStart: () => {
        const reporter = heartbeatReporterRef.current;
        if (reporter && deviceIdRef.current && sessionStartedAtRef.current) {
          const upload = uploadStateRef.current;
          reporter.update({
            version: 1,
            deviceId: deviceIdRef.current,
            sessionStartedAt: sessionStartedAtRef.current,
            pendingCount: upload.pendingCount,
            durableStorage: upload.durable,
            online: navigator.onLine,
            installed: isInstalled(),
            camera: operationalRef.current.paused ? "stopped" : "starting",
            upload: heartbeatUpload(upload),
            ...(heartbeatError("starting", null, upload) === undefined
              ? {}
              : { errorClass: heartbeatError("starting", null, upload) }),
            buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "development",
          });
          reporter.start();
        }
        statePollerRef.current?.start();
        if (!operationalRef.current.paused) void startCamera();
      },
      onCameraStop: () => {
        statePollerRef.current?.stop();
        heartbeatReporterRef.current?.stop();
        pauseBoundary.reset();
        stopCamera();
      },
      onUploaded: ({ url }) => {
        setLastUrl(url);
        setLastSuccessfulUploadAt(Date.now());
      },
    }),
    [applyOperationalState, pauseBoundary, startCamera, stopCamera]
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopCamera();
    };
  }, [stopCamera]);

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

  useEffect(() => {
    const credential: BoothCredentialHolder = { key: "" };
    const uploadOne = async (item: OutboxItem) => {
      const res = await fetch(`/api/upload?event=${encodeURIComponent(event)}`, {
        method: "POST",
        headers: {
          "x-booth-key": credential.key,
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
    };
    let session!: BoothSession;
    session = new BoothSession(
      event,
      createOutboxStore(),
      uploadOne,
      (result) => lifecycle.acceptUploaded(session, result),
      undefined,
      undefined,
      {
        onAuthRequired: (itemId) => lifecycle.authRequired(session, itemId),
      }
    );
    sessionRef.current = session;
    const poller = new BoothStatePoller({
      event,
      initialPaused: () => operationalRef.current.paused,
      onState: applyOperationalState,
    });
    statePollerRef.current = poller;
    const reporter = new BoothHeartbeatReporter({
      event,
      boothKey: () => credential.key,
      onAuthRequired: () => lifecycle.authRequired(session, ""),
    });
    heartbeatReporterRef.current = reporter;
    const entering = lifecycle.beginEvent(event, session, credential);
    const unsubscribe = session.subscribe((next) => {
      if (lifecycle.isActive(session)) {
        uploadStateRef.current = next;
        setUploadState(next);
      }
    });
    const reconsiderConnectivity = () => {
      setOnline(navigator.onLine);
      void session.reconsider("connectivity");
    };
    const reconsiderForeground = () => {
      if (document.visibilityState === "visible") void session.reconsider("foreground");
    };
    window.addEventListener("online", reconsiderConnectivity);
    window.addEventListener("offline", reconsiderConnectivity);
    document.addEventListener("visibilitychange", reconsiderForeground);
    void entering;
    return () => {
      unsubscribe();
      window.removeEventListener("online", reconsiderConnectivity);
      window.removeEventListener("offline", reconsiderConnectivity);
      document.removeEventListener("visibilitychange", reconsiderForeground);
      if (sessionRef.current === session) sessionRef.current = null;
      if (statePollerRef.current === poller) statePollerRef.current = null;
      if (heartbeatReporterRef.current === reporter) heartbeatReporterRef.current = null;
      void lifecycle.leaveEvent(session);
    };
  }, [applyOperationalState, event, lifecycle]);

  useEffect(() => {
    const reporter = heartbeatReporterRef.current;
    if (!reporter || !deviceIdRef.current || !sessionStartedAtRef.current) return;
    const errorClass = heartbeatError(status, cameraErrorClass, uploadState);
    reporter.update({
      version: 1,
      deviceId: deviceIdRef.current,
      sessionStartedAt: sessionStartedAtRef.current,
      pendingCount: uploadState.pendingCount,
      durableStorage: uploadState.durable,
      online,
      installed: isInstalled(),
      camera: heartbeatCamera(status, operational.paused),
      upload: heartbeatUpload(uploadState),
      ...(lastSuccessfulUploadAt === null ? {} : { lastSuccessfulUploadAt }),
      ...(errorClass === undefined ? {} : { errorClass }),
      buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "development",
    });
  }, [
    cameraErrorClass,
    lastSuccessfulUploadAt,
    online,
    operational.paused,
    status,
    uploadState,
  ]);

  const unlock = useCallback((key: string, remember: boolean) => {
    saveBoothCredential(
      event,
      key,
      remember,
      window.sessionStorage,
      window.localStorage
    );
    void lifecycle.unlock(key);
  }, [event, lifecycle]);

  const retryPreflight = useCallback(() => {
    void lifecycle.retryPreflight();
  }, [lifecycle]);

  const retryUpload = useCallback(() => {
    if (accessState !== "ready" || !uploadState.pendingCount) return;
    void sessionRef.current?.retry();
  }, [accessState, uploadState.pendingCount]);

  // take the whole sequence for the chosen mode, composite, upload
  const run = useCallback(async () => {
    if (
      accessState !== "ready"
      || operationalRef.current.paused
      || status !== "ready"
      || !mode
      || !pauseBoundary.beginOperation()
    ) return;
    const t = TEMPLATES[mode];
    setStatus("running");
    const controller = new AbortController();
    captureRef.current = controller;
    const session = sessionRef.current;
    try {
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
          },
        }
      );
      if (controller.signal.aborted || !lifecycle.isActive(session)) return;
      // Durable handoff is complete. Return to the picker before uploading so
      // the next guest is never trapped on the previous guest's frame.
      setError(null);
      if (!pauseBoundary.completeOperation()) clearFrame();
      // Pause gates new capture only. It never interrupts the ordered Outbox.
      void session.process();
    } catch (e) {
      if (controller.signal.aborted || !session || !lifecycle.isActive(session)) return;
      // composite (frame art fetch, toBlob) failed — surface it and recover
      // instead of leaving the booth stuck in "running" until a reload
      setError(e instanceof Error ? e.message : String(e));
      setShot(0);
      setCount(0);
      setFlash(false);
      if (!pauseBoundary.completeOperation()) {
        setMode(null);
        setStatus(streamRef.current ? "picking" : "denied");
      }
    } finally {
      if (captureRef.current === controller) captureRef.current = null;
    }
  }, [
    accessState,
    status,
    mode,
    grabFrame,
    lifecycle,
    clearFrame,
    pauseBoundary,
  ]);

  // fallback: native file input (camera) when getUserMedia is blocked.
  // Re-encode to a real JPEG first — iPhones hand back HEIC, and the stored
  // key/content-type is always .jpg / image/jpeg.
  // ponytail: fallback photos stay frameless; compositing needs the live capture flow.
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (accessState !== "ready" || operationalRef.current.paused) {
        e.target.value = "";
        return;
      }
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !pauseBoundary.beginOperation()) return;
      const controller = new AbortController();
      captureRef.current = controller;
      const session = sessionRef.current;
      try {
        if (!session) throw new Error("Photo queue is still starting — please try again");
        await session.enqueueCapture(async (signal) => {
          if (signal?.aborted) throw new DOMException("Capture aborted", "AbortError");
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
          signal: controller.signal,
          metadata: {
            source: "camera-fallback",
          },
        });
        if (controller.signal.aborted || !lifecycle.isActive(session)) return;
        setError(null);
        pauseBoundary.completeOperation();
        void session.process();
      } catch (uploadError) {
        if (controller.signal.aborted || !session || !lifecycle.isActive(session)) return;
        setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
        pauseBoundary.completeOperation();
      } finally {
        if (captureRef.current === controller) captureRef.current = null;
      }
    },
    [accessState, lifecycle, pauseBoundary]
  );

  const pick = (m: keyof typeof TEMPLATES) => {
    if (accessState !== "ready" || operationalRef.current.paused) return;
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

      {accessState === "ready" && status === "picking" && (
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
                <button
                  key={k}
                  className={styles.choice}
                  onClick={() => pick(k)}
                  disabled={operational.paused}
                >
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

      {accessState === "ready" && status === "denied" && (
        <div className={styles.picker}>
          <p>Camera unavailable. Use your device camera instead:</p>
          <label className={styles.fileBtn}>
            Take a photo
            <input
              type="file"
              accept="image/*"
              capture="user"
              onChange={onFile}
              disabled={accessState !== "ready" || operational.paused}
              hidden
            />
          </label>
        </div>
      )}

      {accessState === "ready" && (status === "ready" || status === "running") && (
        <div className={styles.bottom}>
          {lastUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastUrl} alt="Last photo" className={styles.thumb} />
          )}
          <button
            className={styles.shutter}
            onClick={run}
            disabled={accessState !== "ready" || operational.paused || status !== "ready"}
            aria-label="Start"
          >
            {status === "running" ? "" : mode && TEMPLATES[mode].shots > 1 ? "▶" : ""}
          </button>
          <button
            className={styles.change}
            onClick={() => setStatus("picking")}
            disabled={accessState !== "ready" || operational.paused || status !== "ready"}
          >
            {mode && TEMPLATES[mode].label} · change
          </button>
          <a className={styles.liveLink} href={`/${event}/live`} target="_blank" rel="noreferrer">
            Live →
          </a>
        </div>
      )}

      {accessState === "ready" && uploadState.pendingCount > 0 && status !== "running" && (
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
      {accessState !== "ready" && accessState !== "exited" && (
        <BoothUnlock
          key={event}
          event={event}
          state={accessState}
          feedback={accessFeedback}
          pendingCount={uploadState.pendingCount}
          durable={uploadState.durable}
          outboxRecovered={outboxRecovered}
          onUnlock={unlock}
          onRetry={retryPreflight}
        />
      )}
      {accessState === "ready" && (error || uploadState.error) && (
        <div className={styles.error} onClick={() => setError(null)}>
          {error || uploadState.error}
        </div>
      )}
      {accessState === "ready" && !uploadState.durable && (
        <div className={styles.storageWarning} role="status">
          Offline photo storage is unavailable. Pending photos may be lost if this page reloads.
        </div>
      )}
      {accessState === "ready" && !operational.connected && (
        <div className={styles.connectivity} role="status" aria-live="polite">
          Checking Event connection. The last pause state stays in effect.
        </div>
      )}
      {accessState === "ready" && operational.paused && (
        <section className={styles.operationalPause} aria-labelledby="booth-paused-title">
          <div className={styles.operationalPausePanel} role="status" aria-live="polite">
            <p className={styles.operationalEyebrow}>Event operator</p>
            <h1 id="booth-paused-title">Booth paused</h1>
            <p>Finishing any photo already in progress. This Booth will resume when the Event is ready.</p>
          </div>
        </section>
      )}
    </main>
  );
}
