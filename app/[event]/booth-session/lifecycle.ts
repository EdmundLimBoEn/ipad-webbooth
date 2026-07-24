import { availableTemplates } from "../../templates";
import { parseBoothOperationalState } from "../../booth-control";
import {
  parseEventConfig,
  projectEventExperience,
  type EventExperience,
} from "../../event-config";
import type { BoothAccessState } from "./access";
import type { OutboxItem } from "./outbox";

export type BoothAccessFeedback =
  | "recovering"
  | "locked"
  | "checking"
  | "network"
  | "unavailable"
  | "rejected-key"
  | "ready";

export type BoothPreflightResult =
  | {
      kind: "ready";
      frames: unknown;
      experience?: EventExperience;
      operationalState?: unknown;
    }
  | { kind: "unauthorized" }
  | { kind: "unavailable" }
  | { kind: "recovery-only" };

export type BoothSessionRecovery = {
  authBlockedItemId: string | null;
  items?: readonly OutboxItem[];
};

export interface BoothLifecycleSession {
  recover(): Promise<BoothSessionRecovery>;
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
  onOutboxRecovered: (recovery: BoothSessionRecovery) => void;
  onAccess: (state: BoothAccessState, feedback: BoothAccessFeedback) => void;
  onFrames: (frames: string[] | null) => void;
  onExperience?: (experience: EventExperience | null) => void;
  onOperationalState: (state: unknown) => void;
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

export function boothPreflightResultFromPayload(value: unknown): BoothPreflightResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "recovery-only" };
  }
  const payload = value as {
    experience?: unknown;
    operationalState?: unknown;
  };
  const operationalState = parseBoothOperationalState(payload.operationalState);
  if (!operationalState) return { kind: "recovery-only" };
  const experience = payload.experience;
  const config = parseEventConfig(
    experience && typeof experience === "object" && !Array.isArray(experience)
      ? { ...experience, version: 1 }
      : null,
  );
  if (!config) return { kind: "recovery-only" };
  const validatedExperience = projectEventExperience(config);
  return {
    kind: "ready",
    frames: validatedExperience.frames,
    experience: validatedExperience,
    operationalState,
  };
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
      previous.key = "";
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
    this.deps.onExperience?.(null);
    this.deps.onAccess("locked", "recovering");

    let recovery: BoothSessionRecovery;
    try {
      recovery = await session.recover();
    } catch {
      if (!this.isCurrent(active)) return;
      this.deps.onOutboxRecovered({ authBlockedItemId: null, items: [] });
      this.deps.onAccess("recovery-only", "network");
      return;
    }
    if (!this.isCurrent(active)) return;
    active.authBlockedItemId = recovery.authBlockedItemId;

    this.deps.onOutboxRecovered(recovery);
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
    active.key = "";
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

  authRequired(session: BoothLifecycleSession, itemId?: string) {
    const active = this.active;
    if (!active || active.session !== session) return Promise.resolve();
    if (itemId !== undefined) active.authBlockedItemId = itemId;
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
    this.deps.onExperience?.(null);
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
    if (result.operationalState !== undefined) {
      this.deps.onOperationalState(result.operationalState);
    }
    this.deps.onFrames(frames);
    this.deps.onExperience?.(result.experience ?? { frames });
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
