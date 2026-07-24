import type { OutboxItem, OutboxStore } from "./outbox";
import type { CaptureMetadata } from "../../upload-contract";
import { classifyUploadFailure } from "./retry-policy";

export type UploadState = {
  status: "idle" | "uploading" | "failed";
  pendingCount: number;
  error: string | null;
  durable: boolean;
};

export type UploadResult = { url: string; key?: string; duplicate?: boolean };
export type Upload = (item: OutboxItem) => Promise<UploadResult>;

export type EnqueueCaptureOptions = {
  signal?: AbortSignal;
  metadata: Omit<CaptureMetadata, "capturedAt">;
  rehearsalId?: string;
};

export type BoothSessionOptions = {
  ownerId?: string;
  leaseTtlMs?: number;
  random?: () => number;
  onAuthRequired?: () => void | Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export class BoothSession {
  private state: UploadState = { status: "idle", pendingCount: 0, error: null, durable: true };
  private processing: Promise<void> | null = null;
  private wakeWork: Promise<void> | null = null;
  private lastCreatedAt = 0;
  private listeners = new Set<(state: UploadState) => void>();
  private started = false;
  private stopRequested = false;
  private leaseHeld = false;
  private leaseExpiresAt = 0;
  private retryAt: number | null = null;
  private timer: unknown = null;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;
  private readonly random: () => number;
  private readonly onAuthRequired: () => void | Promise<void>;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(
    private readonly event: string,
    private readonly store: OutboxStore,
    private readonly upload: Upload,
    private readonly onUploaded: (result: UploadResult) => void = () => {},
    private readonly makeId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = Date.now,
    options: BoothSessionOptions = {}
  ) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.onAuthRequired = options.onAuthRequired ?? (() => {});
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  subscribe(listener: (state: UploadState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private publish(next: UploadState) {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // State observers are UI-only and cannot affect durable queue state.
      }
    }
  }

  async recover() {
    const pending = await this.store.list(this.event);
    this.lastCreatedAt = pending.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
    this.publish({
      status: pending.some((item) => item.lastError) ? "failed" : "idle",
      pendingCount: pending.length,
      error: pending.find((item) => item.lastError)?.lastError ?? null,
      durable: this.store.isDurable(),
    });
  }

  start() {
    this.started = true;
    this.stopRequested = false;
    return this.process();
  }

  async stop() {
    this.started = false;
    this.stopRequested = true;
    this.cancelTimer();
    const wakeWork = this.wakeWork;
    const processing = this.processing;
    await Promise.allSettled([
      ...(wakeWork ? [wakeWork] : []),
      ...(processing ? [processing] : []),
    ]);
    await this.releaseLease();
  }

  async reconsider(_reason: "connectivity" | "foreground") {
    if (!this.started || this.stopRequested) return;
    const pending = await this.store.list(this.event);
    const first = pending[0];
    if (!first || first.failureKind !== "retryable") return;
    await this.store.put({ ...first, nextAttemptAt: this.now() });
    this.retryAt = this.now();
    this.cancelTimer();
    await this.process();
  }

  /** The capture adapter owns camera/file decoding; the session owns durable handoff. */
  async enqueueCapture(
    capture: (signal?: AbortSignal) => Promise<Blob>,
    options: EnqueueCaptureOptions
  ) {
    const blob = await capture(options.signal);
    if (options.signal?.aborted) throw abortError();
    // Preserve enqueue order even if two captures share a millisecond or the
    // device clock moves backwards while the booth is running. Reserve before
    // awaiting persistence so concurrent successful captures cannot share a
    // timestamp; a failed put may leave a harmless gap.
    const createdAt = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const item: OutboxItem = {
      id: this.makeId(),
      event: this.event,
      blob,
      createdAt,
      attempts: 0,
      metadata: { ...options.metadata, capturedAt: createdAt },
      ...(options.rehearsalId === undefined ? {} : { rehearsalId: options.rehearsalId }),
    };
    await this.store.put(item);
    const pending = await this.store.list(this.event);
    this.publish({
      status: this.state.status === "failed" ? "failed" : "idle",
      pendingCount: pending.length,
      error: this.state.status === "failed" ? this.state.error : null,
      durable: this.store.isDurable(),
    });
    if (this.started && !this.stopRequested) void this.process();
    return item;
  }

  process() {
    if (this.stopRequested) return Promise.resolve();
    if (!this.processing) {
      let run!: Promise<void>;
      run = this.drain().finally(async () => {
        if (!this.started) await this.releaseLease();
        if (this.processing === run) this.processing = null;
      });
      this.processing = run;
    }
    return this.processing;
  }

  async retry() {
    if (this.stopRequested) return;
    const pending = await this.store.list(this.event);
    const first = pending[0];
    if (first?.lastError || first?.failureKind) {
      const {
        lastError: _lastError,
        nextAttemptAt: _nextAttemptAt,
        failureKind: _failureKind,
        errorClass: _errorClass,
        ...ready
      } = first;
      await this.store.put(ready);
    }
    this.retryAt = null;
    this.cancelTimer();
    await this.process();
  }

  private async drain() {
    if (!await this.ensureLease()) return;
    let pending = await this.store.list(this.event);
    while (pending.length > 0) {
      const item = pending[0];
      if (item.failureKind === "retryable" && (item.nextAttemptAt ?? 0) > this.now()) {
        this.retryAt = item.nextAttemptAt ?? null;
        this.publish({
          status: "failed",
          pendingCount: pending.length,
          error: item.lastError ?? null,
          durable: this.store.isDurable(),
        });
        this.scheduleWake();
        return;
      }
      if (
        item.failureKind === "permanent" ||
        item.failureKind === "auth" ||
        (item.lastError && !item.failureKind)
      ) {
        this.retryAt = null;
        this.publish({
          status: "failed",
          pendingCount: pending.length,
          error: item.lastError ?? null,
          durable: this.store.isDurable(),
        });
        this.scheduleWake();
        return;
      }
      this.publish({
        status: "uploading",
        pendingCount: pending.length,
        error: null,
        durable: this.store.isDurable(),
      });
      let result: UploadResult;
      try {
        result = await this.upload(item);
        await this.store.remove(item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempt = item.attempts + 1;
        const disposition = classifyUploadFailure(error, attempt, this.now(), this.random);
        const failed: OutboxItem = {
          ...item,
          attempts: attempt,
          lastError: message,
          failureKind: disposition.kind === "auth-required" ? "auth" : disposition.kind,
          errorClass: disposition.errorClass,
          ...(disposition.kind === "retryable"
            ? { nextAttemptAt: this.now() + disposition.delayMs }
            : {}),
        };
        await this.store.put(failed);
        this.retryAt = disposition.kind === "retryable" ? failed.nextAttemptAt ?? null : null;
        this.publish({
          status: "failed",
          pendingCount: pending.length,
          error: message,
          durable: this.store.isDurable(),
        });
        if (disposition.kind === "auth-required") {
          try {
            await this.onAuthRequired();
          } catch {
            // Credential UI cannot affect the already-persisted queue state.
          }
        }
        this.scheduleWake();
        return;
      }

      // Everything below runs after the upload was acknowledged and the exact
      // item was removed. Post-ack failures may pause reconciliation, but can
      // never enter the retry path and recreate that item.
      try {
        this.onUploaded(result);
      } catch {
        // The next state publication still reconciles the Booth UI.
      }

      if (this.stopRequested) return;

      try {
        pending = await this.store.list(this.event);
      } catch (error) {
        this.publish({
          status: "failed",
          pendingCount: Math.max(0, pending.length - 1),
          error: error instanceof Error ? error.message : String(error),
          durable: this.store.isDurable(),
        });
        return;
      }
      this.publish({
        status: "idle",
        pendingCount: pending.length,
        error: null,
        durable: this.store.isDurable(),
      });
    }
    this.retryAt = null;
    this.scheduleWake();
  }

  private async ensureLease() {
    if (this.leaseHeld) {
      if (this.now() < this.leaseRenewAt()) return true;
      if (await this.renewLease()) return true;
      this.leaseHeld = false;
    }
    const acquired = await this.store.acquireLease(
      this.event,
      this.ownerId,
      this.now(),
      this.leaseTtlMs
    );
    if (!acquired) {
      if (this.started) {
        this.retryAt = this.now() + this.leaseTtlMs;
        this.scheduleWake();
      }
      return false;
    }
    this.leaseHeld = true;
    this.leaseExpiresAt = this.now() + this.leaseTtlMs;
    this.scheduleWake();
    return true;
  }

  private leaseRenewAt() {
    return this.leaseExpiresAt - Math.max(1, Math.floor(this.leaseTtlMs / 2));
  }

  private async renewLease() {
    if (!this.leaseHeld) return false;
    const renewed = await this.store.renewLease(
      this.event,
      this.ownerId,
      this.now(),
      this.leaseTtlMs
    );
    if (renewed) this.leaseExpiresAt = this.now() + this.leaseTtlMs;
    return renewed;
  }

  private async releaseLease() {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    this.leaseExpiresAt = 0;
    if (!this.started) this.cancelTimer();
    await this.store.releaseLease(this.event, this.ownerId);
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private scheduleWake() {
    if (this.stopRequested) return;
    const targets = [
      ...(this.leaseHeld ? [this.leaseRenewAt()] : []),
      ...(this.started && this.retryAt !== null ? [this.retryAt] : []),
    ];
    if (targets.length === 0) return;
    const wakeAt = Math.min(...targets);
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      let work!: Promise<void>;
      work = this.handleWake().finally(() => {
        if (this.wakeWork === work) this.wakeWork = null;
      });
      this.wakeWork = work;
    }, Math.max(0, wakeAt - this.now()));
  }

  private async handleWake() {
    if (this.stopRequested) return;
    if (this.leaseHeld && this.now() >= this.leaseRenewAt()) {
      if (!await this.renewLease()) this.leaseHeld = false;
    }
    if (!this.started || this.stopRequested) {
      if (this.leaseHeld && this.processing) this.scheduleWake();
      return;
    }
    if (!this.leaseHeld || (this.retryAt !== null && this.now() >= this.retryAt)) {
      if (this.retryAt !== null && this.now() >= this.retryAt) this.retryAt = null;
      await this.process();
    }
    this.scheduleWake();
  }
}

export function abortError() {
  return new DOMException("Capture cancelled", "AbortError");
}

export function abortableDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

export async function runCaptureSequence<T>(options: {
  shots: number;
  intervalMs: number;
  signal?: AbortSignal;
  captureFrame: () => T;
  onCountdown: (count: number, shot: number) => void;
  onFlash: (visible: boolean) => void;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  const delay = options.delay ?? abortableDelay;
  const frames: T[] = [];
  for (let i = 0; i < options.shots; i++) {
    const shot = options.shots > 1 ? i + 1 : 0;
    for (let n = Math.round(options.intervalMs / 1000); n >= 1; n--) {
      options.onCountdown(n, shot);
      await delay(1000, options.signal);
    }
    options.onCountdown(0, shot);
    if (options.signal?.aborted) throw abortError();
    options.onFlash(true);
    frames.push(options.captureFrame());
    await delay(300, options.signal);
    options.onFlash(false);
    if (i < options.shots - 1) await delay(400, options.signal);
  }
  return frames;
}
