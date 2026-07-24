"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useParams } from "next/navigation";
import styles from "./booth.module.css";
import {
  TEMPLATES,
  availableTemplates,
  composeToCanvas,
  encodeCanvas,
} from "../templates";
import { frameLabel } from "../frame-packs/catalog";
import { createOutboxStore, type OutboxItem } from "./booth-session/outbox";
import {
  BoothSession,
  runCaptureSequence,
  type UploadAcknowledgement,
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
  stopBoothOperationalClients,
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
import {
  ScreenWakeController,
  isStandalone,
  shouldWarnBeforeUnload,
  type WakeLockProviderLike,
  type WakeRequestState,
} from "./booth-session/installed-mode";
import {
  OperatorControls,
  performVerifiedOperatorExit,
  type OperatorExitResult,
} from "./operator-controls";
import { CaptureReview } from "./capture-review";
import { CountdownToneController } from "./booth-session/countdown-audio";
import {
  INITIAL_CAPTURE_FLOW_STATE,
  reduceCaptureFlow,
  type ReviewCandidate,
} from "./booth-session/capture-flow";
import { decodePhotoFileToCanvas } from "./booth-session/capture-candidate";
import {
  applyAcknowledgement,
  beginHandoff,
  type CurrentHandoff,
} from "./booth-session/handoff";
import { HandoffPanel } from "./handoff-panel";
import {
  applyDocumentLocale,
  deviceLocaleStorageKey,
  resolveDeviceLocale,
  resolveEnabledLocales,
  saveDeviceLocale,
} from "../i18n/locale";
import {
  message,
  type SupportedLocale,
} from "../i18n/catalog";
import type { EventExperience } from "../event-config";

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
  const shutterRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<BoothSession | null>(null);
  const statePollerRef = useRef<BoothStatePoller | null>(null);
  const heartbeatReporterRef = useRef<BoothHeartbeatReporter | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const cameraRequestRef = useRef(0);
  const unmountedRef = useRef(false);
  const deviceIdRef = useRef("");
  const credentialRef = useRef<BoothCredentialHolder | null>(null);
  const sessionStartedAtRef = useRef(0);
  const operationalRef = useRef<OperationalState>({ paused: false, connected: false });
  const uploadStateRef = useRef<UploadState>(INITIAL_UPLOAD_STATE);
  const wakeController = useMemo(() => {
    if (typeof navigator === "undefined") return new ScreenWakeController();
    const provider = (navigator as Navigator & {
      wakeLock?: WakeLockProviderLike;
    }).wakeLock;
    return new ScreenWakeController(provider);
  }, []);
  const captureFlowRef = useRef(INITIAL_CAPTURE_FLOW_STATE);
  const acceptingCandidatesRef = useRef(new Set<string>());
  const tonesRef = useRef(new CountdownToneController());
  const [status, setStatus] = useState<Status>("starting");
  const [accessState, setAccessState] = useState<BoothAccessState>("locked");
  const [accessFeedback, setAccessFeedback] =
    useState<BoothAccessFeedback>("recovering");
  const [outboxRecovered, setOutboxRecovered] = useState(false);
  const [mode, setMode] = useState<keyof typeof TEMPLATES | null>(null);
  const [captureFlow, dispatchCapture] = useReducer(
    reduceCaptureFlow,
    INITIAL_CAPTURE_FLOW_STATE,
  );
  captureFlowRef.current = captureFlow;
  const [handoff, setHandoff] = useState<CurrentHandoff | null>(null);
  const [experience, setExperience] = useState<EventExperience | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>("en");
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
  const [wakeState, setWakeState] =
    useState<WakeRequestState | "idle">("idle");
  const [durableHandoffActive, setDurableHandoffActive] = useState(false);
  // Frames remain unavailable until authenticated preflight returns the safe
  // Event experience. `null` is never shown while the Booth is locked.
  const [enabled, setEnabled] = useState<string[] | null>(null);

  const enabledLocales = useMemo(
    () => resolveEnabledLocales(experience?.locales),
    [experience?.locales],
  );
  const reviewEnabled = experience?.capture?.reviewEnabled ?? true;
  const autoAcceptSeconds = experience?.capture?.autoAcceptSeconds ?? 5;
  const countdownAudioEnabled =
    experience?.capture?.countdownAudioDefault ?? false;
  const label = useCallback(
    (key: Parameters<typeof message>[1], values?: Record<string, string | number>) =>
      message(locale, key, values),
    [locale],
  );

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

  const requestWake = useCallback(async () => {
    const next = await wakeController.request();
    setWakeState(next);
    return next;
  }, [wakeController]);

  const clearFrame = useCallback(() => {
    const candidate = captureFlowRef.current.candidate;
    if (candidate) {
      candidate.canvas.width = 0;
      candidate.canvas.height = 0;
      acceptingCandidatesRef.current.delete(candidate.id);
    }
    dispatchCapture({ type: "reset" });
    setHandoff(null);
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
        clearFrame();
        operationalRef.current = initial.operational;
        uploadStateRef.current = INITIAL_UPLOAD_STATE;
        deviceIdRef.current = loadOrCreateDeviceId(window.localStorage);
        sessionStartedAtRef.current = initial.sessionStartedAt;
        setStatus("starting");
        setExperience(null);
        acceptingCandidatesRef.current.clear();
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
          clearFrame();
          setStatus("starting");
          setError(null);
        }
        setAccessState(state);
        setAccessFeedback(feedback);
      },
      onFrames: setEnabled,
      onExperience: (nextExperience) => {
        setExperience(nextExperience);
        if (!nextExperience) return;
        let storedLocale: string | null = null;
        try {
          storedLocale = window.localStorage.getItem(
            deviceLocaleStorageKey(event),
          );
        } catch {
          // Locale persistence is best-effort.
        }
        const nextLocale = resolveDeviceLocale({
          event,
          configured: nextExperience.locales,
          defaultLocale: nextExperience.defaultLocale,
          storedLocale,
          navigatorLanguages: navigator.languages,
        });
        setLocale(nextLocale);
        applyDocumentLocale(document.documentElement, nextLocale);
      },
      onOperationalState: (value) => {
        const state = parseBoothOperationalState(value);
        if (state) {
          applyOperationalState({ paused: state.paused, connected: true });
        }
      },
      onCameraStart: () => {
        // Stored credentials can complete preflight without a fresh tap.
        // Attempt wake anyway; gesture-restricted browsers report the visible
        // Auto-Lock fallback instead of silently leaving the Booth unprotected.
        void requestWake();
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
            installed: isStandalone(
              window.matchMedia.bind(window),
              (navigator as Navigator & { standalone?: boolean }).standalone
            ),
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
        void wakeController.release().then(() => setWakeState("idle"));
      },
      onUploaded: ({ url }) => {
        setLastUrl(url);
        setLastSuccessfulUploadAt(Date.now());
      },
    }),
    [
      applyOperationalState,
      clearFrame,
      event,
      pauseBoundary,
      requestWake,
      startCamera,
      stopCamera,
      wakeController,
    ]
  );

  useEffect(() => {
    unmountedRef.current = false;
    const tones = new CountdownToneController();
    tonesRef.current = tones;
    return () => {
      unmountedRef.current = true;
      stopCamera();
      void tones.dispose();
    };
  }, [stopCamera]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (accessState !== "ready") return;
      void wakeController.handleVisibilityChange(document.visibilityState)
        .then((next) => {
          if (next) setWakeState(next);
        });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [accessState, wakeController]);

  useEffect(() => {
    if (!shouldWarnBeforeUnload({
      captureActive: status === "running",
      durableHandoffActive,
      pendingCount: uploadState.pendingCount,
    })) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [durableHandoffActive, status, uploadState.pendingCount]);

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
    credentialRef.current = credential;
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
    const acknowledge = (acknowledgement: UploadAcknowledgement) => {
      if (!lifecycle.isActive(session)) return;
      lifecycle.acceptUploaded(session, acknowledgement.result);
      setHandoff((current) =>
        applyAcknowledgement(
          current,
          acknowledgement,
          window.location.origin,
        )
      );
    };
    session = new BoothSession(
      event,
      createOutboxStore(),
      uploadOne,
      acknowledge,
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
      onAuthRequired: () => lifecycle.authRequired(session),
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
      stopBoothOperationalClients(poller, reporter);
      if (credentialRef.current === credential) credentialRef.current = null;
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
      installed: isStandalone(
        window.matchMedia.bind(window),
        (navigator as Navigator & { standalone?: boolean }).standalone
      ),
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
    void requestWake();
    saveBoothCredential(
      event,
      key,
      remember,
      window.sessionStorage,
      window.localStorage
    );
    void lifecycle.unlock(key);
  }, [event, lifecycle, requestWake]);

  const retryPreflight = useCallback(() => {
    void lifecycle.retryPreflight();
  }, [lifecycle]);

  const retryUpload = useCallback(() => {
    if (accessState !== "ready" || !uploadState.pendingCount) return;
    void sessionRef.current?.retry();
  }, [accessState, uploadState.pendingCount]);

  const acceptCandidate = useCallback(async (
    candidate: ReviewCandidate,
    fromReview = true,
  ) => {
    // This identity guard runs before any await, so an automatic timer and a
    // button can never encode or enqueue the same candidate twice.
    if (acceptingCandidatesRef.current.has(candidate.id)) return;
    acceptingCandidatesRef.current.add(candidate.id);
    if (fromReview) {
      dispatchCapture({ type: "accept", candidateId: candidate.id });
    }
    const session = sessionRef.current;
    const controller = captureRef.current;
    try {
      if (!session) throw new Error(label("queueStarting"));
      const blob = await encodeCanvas(candidate.canvas);
      const item = await session.enqueueCapture(
        async () => blob,
        {
          signal: controller?.signal,
          metadata: {
            source: candidate.source,
            ...(candidate.frameKey ? { frameKey: candidate.frameKey } : {}),
          },
        },
      );
      if (
        controller?.signal.aborted
        || unmountedRef.current
        || !lifecycle.isActive(session)
      ) {
        return;
      }

      // Establish correlation before upload processing can acknowledge.
      setHandoff(beginHandoff(item));
      dispatchCapture({
        type: "enqueue-succeeded",
        candidateId: candidate.id,
      });
      setError(null);
      setMode(null);
      setStatus("picking");
      setCount(0);
      setShot(0);
      setFlash(false);
      candidate.canvas.width = 0;
      candidate.canvas.height = 0;
      if (captureRef.current === controller) captureRef.current = null;
      pauseBoundary.completeOperation();
      // Pause never interrupts this ordered Outbox drain.
      void session.process();
    } catch {
      if (
        controller?.signal.aborted
        || unmountedRef.current
        || !session
        || !lifecycle.isActive(session)
      ) {
        return;
      }
      acceptingCandidatesRef.current.delete(candidate.id);
      dispatchCapture({
        type: "accept-failed",
        candidateId: candidate.id,
        error: label("saveFailed"),
      });
    }
  }, [label, lifecycle, pauseBoundary]);

  const retakeCandidate = useCallback((candidate: ReviewCandidate) => {
    if (acceptingCandidatesRef.current.has(candidate.id)) return;
    acceptingCandidatesRef.current.add(candidate.id);
    dispatchCapture({ type: "retake", candidateId: candidate.id });
    candidate.canvas.width = 0;
    candidate.canvas.height = 0;
    captureRef.current?.abort();
    captureRef.current = null;
    setError(null);
    setCount(0);
    setShot(0);
    setFlash(false);
    const pausedAtBoundary = pauseBoundary.completeOperation();
    if (!pausedAtBoundary) {
      setStatus(candidate.frameKey ? "ready" : "denied");
      if (candidate.frameKey) {
        requestAnimationFrame(() => shutterRef.current?.focus());
      }
    }
  }, [pauseBoundary]);

  // Take the whole sequence, then keep the exact unencoded composite for review.
  const run = useCallback(async () => {
    if (
      accessState !== "ready"
      || operationalRef.current.paused
      || status !== "ready"
      || !mode
      || !pauseBoundary.beginOperation()
    ) return;
    const toneActivation = countdownAudioEnabled
      ? tonesRef.current.activate()
      : Promise.resolve(false);
    const t = TEMPLATES[mode];
    const attemptId = crypto.randomUUID();
    dispatchCapture({ type: "start-capture", attemptId });
    setStatus("running");
    const controller = new AbortController();
    captureRef.current = controller;
    const session = sessionRef.current;
    try {
      if (!session) throw new Error(label("queueStarting"));
      await toneActivation;
      const frames = await runCaptureSequence({
        shots: t.shots,
        intervalMs: t.intervalMs,
        signal: controller.signal,
        captureFrame: grabFrame,
        onCountdown: (nextCount, nextShot) => {
          setCount(nextCount);
          setShot(nextShot);
          tonesRef.current.tick(nextCount);
        },
        onFlash: (visible) => {
          setFlash(visible);
          if (visible) tonesRef.current.captured();
        },
      });
      const canvas = await composeToCanvas(
        frames,
        frames.map((frame) => ({ w: frame.width, h: frame.height })),
        t,
      );
      setDurableHandoffActive(false);
      if (controller.signal.aborted || !lifecycle.isActive(session)) return;
      const candidate: ReviewCandidate = {
        id: crypto.randomUUID(),
        source: "framed",
        frameKey: mode,
        canvas,
      };
      dispatchCapture({
        type: "capture-complete",
        attemptId,
        candidate,
        reviewEnabled,
      });
      setError(null);
      setCount(0);
      setShot(0);
      setFlash(false);
      if (!reviewEnabled) void acceptCandidate(candidate, false);
    } catch {
      if (controller.signal.aborted || !session || !lifecycle.isActive(session)) return;
      const captureMessage = label("captureFailed");
      dispatchCapture({
        type: "capture-failed",
        attemptId,
        error: captureMessage,
      });
      setError(captureMessage);
      setShot(0);
      setCount(0);
      setFlash(false);
      if (!pauseBoundary.completeOperation()) setStatus("ready");
      if (captureRef.current === controller) captureRef.current = null;
    }
  }, [
    accessState,
    status,
    mode,
    grabFrame,
    label,
    lifecycle,
    pauseBoundary,
    reviewEnabled,
    acceptCandidate,
    countdownAudioEnabled,
  ]);

  // File-camera fallback decodes to a canvas and joins the same exact review.
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (accessState !== "ready" || operationalRef.current.paused) {
        e.target.value = "";
        return;
      }
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !pauseBoundary.beginOperation()) return;
      const attemptId = crypto.randomUUID();
      dispatchCapture({ type: "start-fallback-capture", attemptId });
      setStatus("running");
      const controller = new AbortController();
      captureRef.current = controller;
      const session = sessionRef.current;
      try {
        if (!session) throw new Error(label("queueStarting"));
        const canvas = await decodePhotoFileToCanvas(file);
        if (controller.signal.aborted || !lifecycle.isActive(session)) return;
        const candidate: ReviewCandidate = {
          id: crypto.randomUUID(),
          source: "camera-fallback",
          canvas,
        };
        dispatchCapture({
          type: "capture-complete",
          attemptId,
          candidate,
          reviewEnabled,
        });
        setError(null);
        if (!reviewEnabled) void acceptCandidate(candidate, false);
      } catch {
        if (controller.signal.aborted || !session || !lifecycle.isActive(session)) return;
        const captureMessage = label("decodeFailed");
        dispatchCapture({
          type: "capture-failed",
          attemptId,
          error: captureMessage,
        });
        setError(captureMessage);
        if (!pauseBoundary.completeOperation()) setStatus("denied");
        if (captureRef.current === controller) captureRef.current = null;
      }
    },
    [
      acceptCandidate,
      accessState,
      label,
      lifecycle,
      pauseBoundary,
      reviewEnabled,
    ]
  );

  const pick = (m: keyof typeof TEMPLATES) => {
    if (accessState !== "ready" || operationalRef.current.paused) return;
    dispatchCapture({ type: "select-frame", frameKey: m });
    setMode(m);
    setError(null);
    setStatus("ready");
  };

  const operatorExit = useCallback(async (
    freshKey: string
  ): Promise<OperatorExitResult> => performVerifiedOperatorExit(freshKey, {
    verify: async (key) => {
      const result = await requestBoothPreflight(
        event,
        key,
        new AbortController().signal
      );
      return result.kind === "ready";
    },
    stopCamera,
    releaseWake: async () => {
      await wakeController.release();
      setWakeState("idle");
    },
    stopHeartbeat: () => heartbeatReporterRef.current?.stop(),
    stopPoller: () => statePollerRef.current?.stop(),
    stopSession: async () => {
      const session = sessionRef.current;
      if (session) await lifecycle.leaveEvent(session);
    },
    clearCredentials: () => clearBoothCredential(
      event,
      window.sessionStorage,
      window.localStorage
    ),
    clearActiveCredential: () => {
      if (credentialRef.current) credentialRef.current.key = "";
    },
    markExited: () => {
      pauseBoundary.reset();
      setDurableHandoffActive(false);
      setEnabled(null);
      setMode(null);
      setStatus("starting");
      setAccessFeedback("locked");
      setAccessState("exited");
    },
  }), [event, lifecycle, pauseBoundary, stopCamera, wakeController]);

  const changeLocale = (nextLocale: SupportedLocale) => {
    if (!enabledLocales.includes(nextLocale)) return;
    setLocale(nextLocale);
    try {
      saveDeviceLocale(event, nextLocale, window.localStorage);
    } catch {
      // Accessing storage itself can be denied in a restricted browser.
    }
    applyDocumentLocale(document.documentElement, nextLocale);
  };

  const changeFrame = () => {
    dispatchCapture({ type: "reset" });
    setMode(null);
    setError(null);
    setStatus("picking");
  };

  const continueFromHandoff = () => {
    setHandoff(null);
    dispatchCapture({ type: "handoff-complete" });
    setError(null);
    setStatus(streamRef.current ? "picking" : "denied");
  };

  // preview crops to the chosen frame's photo aspect (w/h of its first slot),
  // so guests see exactly what will be captured. Fullscreen until a mode is set.
  const previewAspect = mode ? TEMPLATES[mode].slots[0].w / TEMPLATES[mode].slots[0].h : null;
  const framed = mode !== null && status !== "picking";

  return (
    <>
      <link rel="manifest" href={`/${event}/manifest.webmanifest`} />
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
        <div
          className={styles.count}
          role="status"
          aria-live="assertive"
          aria-atomic="true"
        >
          {count}
          {shot > 0 && (
            <span className={styles.shot}>
              {label("countdownShot", {
                shot,
                total: mode ? TEMPLATES[mode].shots : shot,
              })}
            </span>
          )}
        </div>
      )}

      {accessState === "ready" && status === "picking" && !handoff && (
        <div className={styles.picker}>
          {lastUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastUrl} alt={label("lastPhoto")} className={styles.thumb} />
          )}
          {enabledLocales.length > 1 && (
            <label className={styles.localePicker}>
              <span>{label("language")}</span>
              <select
                value={locale}
                onChange={(event) =>
                  changeLocale(event.target.value as SupportedLocale)}
              >
                {enabledLocales.map((availableLocale) => (
                  <option key={availableLocale} value={availableLocale}>
                    {availableLocale === "en"
                      ? "English"
                      : availableLocale === "zh-SG"
                        ? "简体中文"
                        : "العربية"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <h1>{label("pickStyle")}</h1>
          {availableTemplates(enabled).length === 0 && (
            <p>{label("noFrames")}</p>
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
                  {frameLabel(t, locale)}
                  <small>
                    {t.shots === 1
                      ? label("onePhoto")
                      : label("photoCount", { count: t.shots })}
                  </small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {accessState === "ready" && status === "denied" && !handoff && (
        <div className={styles.picker}>
          <p>{label("cameraUnavailable")}</p>
          <label className={styles.fileBtn}>
            {label("takePhoto")}
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

      {accessState === "ready"
        && !captureFlow.candidate
        && (status === "ready" || status === "running") && (
        <div className={styles.bottom}>
          {lastUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastUrl} alt={label("lastPhoto")} className={styles.thumb} />
          )}
          <button
            ref={shutterRef}
            className={styles.shutter}
            onClick={run}
            disabled={accessState !== "ready" || operational.paused || status !== "ready"}
            aria-label={label("startCapture")}
          >
            {status === "running" ? "" : mode && TEMPLATES[mode].shots > 1 ? "▶" : ""}
          </button>
          <button
            className={styles.change}
            onClick={changeFrame}
            disabled={accessState !== "ready" || operational.paused || status !== "ready"}
          >
            {mode && label("changeFrame", {
              frame: frameLabel(TEMPLATES[mode], locale),
            })}
          </button>
          <a className={styles.liveLink} href={`/${event}/live`} target="_blank" rel="noreferrer">
            {label("liveGallery")} →
          </a>
        </div>
      )}

      {accessState === "ready"
        && captureFlow.candidate
        && (captureFlow.phase === "reviewing"
          || captureFlow.phase === "accepting") && (
        <CaptureReview
          canvas={captureFlow.candidate.canvas}
          autoAcceptSeconds={autoAcceptSeconds}
          accepting={captureFlow.phase === "accepting"}
          error={captureFlow.error}
          labels={{
            usePhoto: label("usePhoto"),
            retake: label("retake"),
            moreTime: label("moreTime"),
            accepting: label("accepting"),
            preview: label("preview"),
          }}
          onAccept={() => void acceptCandidate(captureFlow.candidate!)}
          onRetake={() => retakeCandidate(captureFlow.candidate!)}
          onMoreTime={() => dispatchCapture({
            type: "more-time",
            candidateId: captureFlow.candidate!.id,
          })}
        />
      )}

      {accessState === "ready" && handoff && (
        <HandoffPanel
          handoff={handoff}
          labels={{
            queued: label("queued"),
            title: label("handoffTitle"),
            body: label("handoffBody"),
            viewPhoto: label("viewPhoto"),
            continue: label("continue"),
          }}
          onContinue={continueFromHandoff}
        />
      )}

      {accessState === "ready"
        && uploadState.pendingCount > 0
        && status !== "running"
        && !handoff && (
        <button
          className={styles.retry}
          onClick={retryUpload}
          disabled={uploadState.status === "uploading"}
          aria-live="polite"
        >
          {uploadState.status === "uploading"
            ? label("uploading", { count: uploadState.pendingCount })
            : `⟳ ${label("retryPending", { count: uploadState.pendingCount })}`}
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
      {accessState === "ready" && !captureFlow.candidate && error && (
        <button
          type="button"
          className={styles.error}
          onClick={() => setError(null)}
          aria-label={label("dismissError")}
        >
          {error}
        </button>
      )}
      {accessState === "ready" && uploadState.error && (
        <div className={styles.uploadError} role="alert">
          {uploadState.error}
        </div>
      )}
      {accessState === "ready" && !uploadState.durable && (
        <div className={styles.storageWarning} role="status">
          {label("offlineStorageUnavailable")}
        </div>
      )}
      {accessState === "ready" && !operational.connected && (
        <div className={styles.connectivity} role="status" aria-live="polite">
          {label("checkingConnection")}
        </div>
      )}
      {accessState === "ready"
        && operational.paused
        && !(captureFlow.phase === "reviewing" && captureFlow.candidate) && (
        <section className={styles.operationalPause} aria-labelledby="booth-paused-title">
          <div className={styles.operationalPausePanel} role="status" aria-live="polite">
            <p className={styles.operationalEyebrow}>{label("eventOperator")}</p>
            <h1 id="booth-paused-title">{label("pausedTitle")}</h1>
            <p>{label("pausedBody")}</p>
          </div>
        </section>
      )}
      {accessState === "ready" && (
        <OperatorControls
          event={event}
          pendingCount={uploadState.pendingCount}
          onOperatorGesture={() => {
            void requestWake();
          }}
          onExit={operatorExit}
        />
      )}
      {accessState === "ready"
        && (wakeState === "unsupported" || wakeState === "denied") && (
        <div className={styles.wakeFallback} role="status">
          Screen Wake Lock is unavailable. In iPad Settings, set Display &amp;
          Brightness → Auto-Lock to Never for Booth operation.
        </div>
      )}
      {accessState === "exited" && (
        <section className={styles.exited} aria-labelledby="booth-exited-title">
          <div>
            <p className={styles.operatorEyebrow}>Event operator · {event}</p>
            <h1 id="booth-exited-title">Booth exited</h1>
            <p>Camera and Booth activity are stopped.</p>
            <strong>
              {uploadState.pendingCount} pending photo
              {uploadState.pendingCount === 1 ? "" : "s"} remain in the Photo Outbox.
            </strong>
            <p>Reload this canonical Event address to unlock the Booth again.</p>
          </div>
        </section>
      )}
      </main>
    </>
  );
}
