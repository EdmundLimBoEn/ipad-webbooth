export type WakeLockSentinelLike = {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener?(
    type: "release",
    listener: () => void,
    options?: { once?: boolean }
  ): void;
};

export type WakeLockProviderLike = {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
};

export type WakeRequestState = "active" | "unsupported" | "denied";

export function isStandalone(
  matchMedia: (query: string) => { matches: boolean },
  navigatorStandalone = false
): boolean {
  return matchMedia("(display-mode: standalone)").matches
    || navigatorStandalone === true;
}

export function shouldWarnBeforeUnload(input: {
  captureActive: boolean;
  durableHandoffActive: boolean;
  pendingCount: number;
}): boolean {
  return input.captureActive
    || input.durableHandoffActive
    || input.pendingCount > 0;
}

export class ScreenWakeController {
  private sentinel: WakeLockSentinelLike | null = null;
  private requesting: Promise<WakeRequestState> | null = null;

  constructor(private readonly provider?: WakeLockProviderLike) {}

  request(): Promise<WakeRequestState> {
    if (!this.provider) return Promise.resolve("unsupported");
    if (this.sentinel && !this.sentinel.released) return Promise.resolve("active");
    if (this.requesting) return this.requesting;

    const work = this.provider.request("screen")
      .then((sentinel) => {
        this.sentinel = sentinel;
        sentinel.addEventListener?.("release", () => {
          if (this.sentinel === sentinel) this.sentinel = null;
        }, { once: true });
        return "active" as const;
      })
      .catch(() => "denied" as const)
      .finally(() => {
        if (this.requesting === work) this.requesting = null;
      });
    this.requesting = work;
    return work;
  }

  async release(): Promise<void> {
    const requesting = this.requesting;
    if (requesting) await requesting;
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (!sentinel || sentinel.released) return;
    try {
      await sentinel.release();
    } catch {
      // Releasing wake is best-effort during teardown. The controller forgets
      // the old sentinel so a later explicit request cannot reuse stale state.
    }
  }

  handleVisibilityChange(
    visibilityState: DocumentVisibilityState
  ): Promise<WakeRequestState | undefined> {
    if (visibilityState !== "visible") return Promise.resolve(undefined);
    return this.request();
  }
}
