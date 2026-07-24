import type { OutboxItem, OutboxStore } from "./outbox";
import type { CaptureMetadata } from "../../upload-contract";

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

export class BoothSession {
  private state: UploadState = { status: "idle", pendingCount: 0, error: null, durable: true };
  private processing: Promise<void> | null = null;
  private lastCreatedAt = 0;
  private listeners = new Set<(state: UploadState) => void>();

  constructor(
    private readonly event: string,
    private readonly store: OutboxStore,
    private readonly upload: Upload,
    private readonly onUploaded: (result: UploadResult) => void = () => {},
    private readonly makeId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = Date.now
  ) {}

  subscribe(listener: (state: UploadState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private publish(next: UploadState) {
    this.state = next;
    this.listeners.forEach((listener) => listener(next));
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
    return item;
  }

  process() {
    if (!this.processing) {
      this.processing = this.drain().finally(() => {
        this.processing = null;
      });
    }
    return this.processing;
  }

  retry() {
    return this.process();
  }

  private async drain() {
    let pending = await this.store.list(this.event);
    while (pending.length > 0) {
      const item = pending[0];
      this.publish({
        status: "uploading",
        pendingCount: pending.length,
        error: null,
        durable: this.store.isDurable(),
      });
      try {
        const result = await this.upload(item);
        await this.store.remove(item.id);
        // Notification is outside the durable retry boundary. Storage already
        // acknowledged and the item is gone, so a UI callback failure must not
        // resurrect a duplicate upload.
        try {
          this.onUploaded(result);
        } catch {
          // The next state publication still reconciles the Booth UI.
        }
        pending = await this.store.list(this.event);
        this.publish({
          status: "idle",
          pendingCount: pending.length,
          error: null,
          durable: this.store.isDurable(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.put({ ...item, attempts: item.attempts + 1, lastError: message });
        this.publish({
          status: "failed",
          pendingCount: pending.length,
          error: message,
          durable: this.store.isDurable(),
        });
        return;
      }
    }
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
