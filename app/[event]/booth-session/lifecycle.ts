import { availableTemplates } from "../../templates";
import type { BoothAccessState } from "./access";

export type BoothAccessFeedback =
  | "recovering"
  | "locked"
  | "checking"
  | "network"
  | "unavailable"
  | "rejected-key"
  | "ready";

export type BoothPreflightResult =
  | { kind: "ready"; frames: unknown }
  | { kind: "unauthorized" }
  | { kind: "unavailable" }
  | { kind: "recovery-only" };

export interface BoothLifecycleSession {
  recover(): Promise<void>;
  start(): Promise<void> | void;
  resumeAuth(itemId: string): Promise<void>;
  stop(): Promise<void>;
}

export type BoothCredentialHolder = {
  key: string;
};

type ActiveSession = {
  id: number;
  event: string;
  session: BoothLifecycleSession;
  credential: BoothCredentialHolder;
  key: string;
  authBlockedItemId: string | null;
  stopPromise?: Promise<void>;
};

type BoothLifecycleDependencies<Result> = {
  preflight: (
    event: string,
    key: string,
    signal: AbortSignal
  ) => Promise<BoothPreflightResult>;
  loadCredential: (event: string) => { key: string } | null;
  clearCredential: (event: string) => void;
  onReset: (event: string) => void;
  onOutboxRecovered: () => void;
  onAccess: (state: BoothAccessState, feedback: BoothAccessFeedback) => void;
  onFrames: (frames: string[] | null) => void;
  onCameraStart: () => void;
  onCameraStop: () => void;
  onUploaded: (result: Result) => void;
};

export function usablePreflightFrames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((frame) => typeof frame === "string")) {
    return null;
  }
  const usable = availableTemplates(value);
  return usable.length > 0 ? usable : null;
}

export class BoothLifecycleCoordinator<Result> {
  private active: ActiveSession | null = null;
  private nextSessionId = 0;
  private nextPreflightId = 0;
  private preflightController: AbortController | null = null;

  constructor(private readonly deps: BoothLifecycleDependencies<Result>) {}

  isActive(session: BoothLifecycleSession) {
    return this.active?.session === session;
  }

  async beginEvent(
    event: string,
    session: BoothLifecycleSession,
    credential: BoothCredentialHolder
  ) {
    const previous = this.active;
    this.preflightController?.abort();
    if (previous) {
      previous.credential.key = "";
      void this.ensureStopped(previous);
    }
    this.deps.onCameraStop();
    credential.key = "";

    const active: ActiveSession = {
      id: ++this.nextSessionId,
      event,
      session,
      credential,
      key: "",
      authBlockedItemId: null,
    };
    this.active = active;
    this.deps.onReset(event);
    this.deps.onFrames(null);
    this.deps.onAccess("locked", "recovering");

    try {
      await session.recover();
    } catch {
      if (!this.isCurrent(active)) return;
      this.deps.onOutboxRecovered();
      this.deps.onAccess("recovery-only", "network");
      return;
    }
    if (!this.isCurrent(active)) return;

    this.deps.onOutboxRecovered();
    this.deps.onAccess("locked", "locked");
    const stored = this.deps.loadCredential(event);
    if (!stored) return;
    active.key = stored.key;
    await this.checkCredential(active, stored.key);
  }

  async leaveEvent(session: BoothLifecycleSession) {
    const active = this.active;
    if (!active || active.session !== session) return;
    this.active = null;
    this.preflightController?.abort();
    active.credential.key = "";
    this.deps.onCameraStop();
    await this.ensureStopped(active);
  }

  unlock(key: string) {
    const active = this.active;
    if (!active || !key) return Promise.resolve();
    active.key = key;
    return this.checkCredential(active, key);
  }

  retryPreflight() {
    const active = this.active;
    if (!active || !active.key) return Promise.resolve();
    return this.checkCredential(active, active.key);
  }

  authRequired(session: BoothLifecycleSession, itemId: string) {
    const active = this.active;
    if (!active || active.session !== session) return Promise.resolve();
    active.authBlockedItemId = itemId;
    return this.relock(active);
  }

  acceptUploaded(session: BoothLifecycleSession, result: Result) {
    if (this.active?.session === session) this.deps.onUploaded(result);
  }

  private isCurrent(active: ActiveSession, preflightId?: number) {
    return this.active === active
      && (preflightId === undefined || preflightId === this.nextPreflightId);
  }

  private ensureStopped(active: ActiveSession) {
    if (!active.stopPromise) {
      try {
        active.stopPromise = Promise.resolve(active.session.stop()).catch(() => {
          // A stopped Session cannot mutate the active Event. A later
          // authenticated start remains the only path back to capture.
        });
      } catch {
        active.stopPromise = Promise.resolve();
      }
    }
    return active.stopPromise;
  }

  private relock(active: ActiveSession) {
    if (!this.isCurrent(active)) return Promise.resolve();
    this.preflightController?.abort();
    active.key = "";
    active.credential.key = "";
    this.deps.clearCredential(active.event);
    this.deps.onFrames(null);
    this.deps.onCameraStop();
    this.deps.onAccess("locked", "rejected-key");
    return this.ensureStopped(active);
  }

  private async checkCredential(active: ActiveSession, key: string) {
    if (!this.isCurrent(active)) return;
    this.preflightController?.abort();
    const controller = new AbortController();
    this.preflightController = controller;
    const preflightId = ++this.nextPreflightId;
    this.deps.onAccess("checking", "checking");

    let result: BoothPreflightResult;
    try {
      result = await this.deps.preflight(active.event, key, controller.signal);
    } catch {
      if (controller.signal.aborted || !this.isCurrent(active, preflightId)) return;
      this.deps.onAccess("recovery-only", "network");
      return;
    }
    if (controller.signal.aborted || !this.isCurrent(active, preflightId)) return;

    if (result.kind === "unauthorized") {
      void this.relock(active);
      return;
    }
    if (result.kind === "unavailable") {
      this.deps.onAccess("unavailable", "unavailable");
      return;
    }
    if (result.kind === "recovery-only") {
      this.deps.onAccess("recovery-only", "network");
      return;
    }

    const frames = usablePreflightFrames(result.frames);
    if (!frames) {
      this.deps.onFrames(null);
      this.deps.onAccess("unavailable", "unavailable");
      return;
    }

    const stopPromise = active.stopPromise;
    if (stopPromise) {
      await stopPromise;
    }
    if (!this.isCurrent(active, preflightId)) return;

    active.credential.key = key;
    this.deps.onFrames(frames);
    this.deps.onAccess("ready", "ready");
    let startWork: Promise<void> | void;
    try {
      startWork = active.session.start();
    } catch {
      return;
    }
    if (stopPromise && active.stopPromise === stopPromise) {
      active.stopPromise = undefined;
    }
    void Promise.resolve(startWork).catch(() => {
      // Session state reports upload failures without invalidating preflight.
    });
    this.deps.onCameraStart();
    const authBlockedItemId = active.authBlockedItemId;
    if (authBlockedItemId) {
      active.authBlockedItemId = null;
      await active.session.resumeAuth(authBlockedItemId);
    }
  }
}
