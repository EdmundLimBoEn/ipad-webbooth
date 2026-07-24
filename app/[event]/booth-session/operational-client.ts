import type { BoothHeartbeatInput } from "../../booth-control";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type Timer = unknown;
type SetTimer = (callback: () => void, delayMs: number) => Timer;
type ClearTimer = (timer: Timer) => void;

export type BoothOperationalClientState = {
  paused: boolean;
  connected: boolean;
};

export type BoothStatePollerOptions = {
  event: string;
  fetch?: FetchLike;
  onState?: (state: BoothOperationalClientState) => void;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
};

export type BoothHeartbeatReporterOptions = {
  event: string;
  boothKey: () => string;
  fetch?: FetchLike;
  onAuthRequired?: () => void | Promise<void>;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
};

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

const defaultSetTimer: SetTimer = (callback, delayMs) => setTimeout(callback, delayMs);
const defaultClearTimer: ClearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>);

/** Polls public pause state, never replacing a known state with a failed fetch. */
export class BoothStatePoller {
  private readonly fetch: FetchLike;
  private readonly onState: (state: BoothOperationalClientState) => void;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: Timer | null = null;
  private started = false;
  private stopped = false;
  private paused = false;

  constructor(private readonly options: BoothStatePollerOptions) {
    this.fetch = options.fetch ?? fetch;
    this.onState = options.onState ?? (() => {});
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    const controller = new AbortController();
    this.controller = controller;
    let work!: Promise<void>;
    work = (async () => {
      try {
        const response = await this.fetch(
          `/api/booth-state?event=${encodeURIComponent(this.options.event)}`,
          { signal: controller.signal, cache: "no-store" }
        );
        if (!response.ok) throw new TypeError("Booth state request failed");
        const body: unknown = await response.json();
        if (!isOperationalState(body)) throw new TypeError("Invalid Booth state response");
        this.paused = body.paused;
        if (!this.stopped) this.onState({ paused: this.paused, connected: true });
      } catch {
        if (!this.stopped) this.onState({ paused: this.paused, connected: false });
      } finally {
        if (this.controller === controller) this.controller = null;
        if (this.inFlight === work) this.inFlight = null;
        if (this.started && !this.stopped) this.schedule();
      }
    })();
    this.inFlight = work;
    return work;
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.cancelTimer();
  }

  private schedule() {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

/** Reports one bounded private Booth snapshot without affecting capture or uploads. */
export class BoothHeartbeatReporter {
  private readonly fetch: FetchLike;
  private readonly onAuthRequired: () => void | Promise<void>;
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private snapshot: BoothHeartbeatInput | null = null;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: Timer | null = null;
  private started = false;
  private stopped = false;
  private dirty = false;

  constructor(private readonly options: BoothHeartbeatReporterOptions) {
    this.fetch = options.fetch ?? fetch;
    this.onAuthRequired = options.onAuthRequired ?? (() => {});
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.flush();
  }

  update(snapshot: BoothHeartbeatInput): void {
    this.snapshot = copySnapshot(snapshot);
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    if (this.started && !this.stopped) void this.flush();
  }

  flush(): Promise<void> {
    if (this.stopped || !this.snapshot) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    const snapshot = this.snapshot;
    this.dirty = false;
    const controller = new AbortController();
    this.controller = controller;
    let work!: Promise<void>;
    work = (async () => {
      try {
        const response = await this.fetch(
          `/api/booths?event=${encodeURIComponent(this.options.event)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-booth-key": this.options.boothKey(),
            },
            body: JSON.stringify(copySnapshot(snapshot)),
            signal: controller.signal,
          }
        );
        if (response.status === 401) {
          try {
            await this.onAuthRequired();
          } catch {
            // Relocking is a UI concern; its failure cannot affect the Session.
          }
        }
      } catch {
        // Heartbeats are observational. Network and server failures stay out of capture.
      } finally {
        if (this.controller === controller) this.controller = null;
        if (this.inFlight === work) this.inFlight = null;
        if (!this.started || this.stopped) return;
        if (this.dirty) {
          this.dirty = false;
          void this.flush();
          return;
        }
        this.schedule();
      }
    })();
    this.inFlight = work;
    return work;
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    this.dirty = false;
    this.controller?.abort();
    this.controller = null;
    this.cancelTimer();
  }

  private schedule() {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

function isOperationalState(value: unknown): value is { paused: boolean } {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { paused?: unknown }).paused === "boolean";
}

// Enumerating these fields prevents browser details, arbitrary exception
// messages, and credentials from entering the private heartbeat payload.
function copySnapshot(snapshot: BoothHeartbeatInput): BoothHeartbeatInput {
  return {
    version: 1,
    deviceId: snapshot.deviceId,
    sessionStartedAt: snapshot.sessionStartedAt,
    pendingCount: snapshot.pendingCount,
    durableStorage: snapshot.durableStorage,
    online: snapshot.online,
    installed: snapshot.installed,
    camera: snapshot.camera,
    upload: snapshot.upload,
    ...(snapshot.lastSuccessfulUploadAt === undefined
      ? {}
      : { lastSuccessfulUploadAt: snapshot.lastSuccessfulUploadAt }),
    ...(snapshot.errorClass === undefined ? {} : { errorClass: snapshot.errorClass }),
    buildId: snapshot.buildId,
  };
}
