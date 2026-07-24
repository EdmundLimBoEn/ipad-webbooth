import { describe, expect, test } from "bun:test";
import {
  BoothLifecycleCoordinator,
  usablePreflightFrames,
  type BoothLifecycleSession,
  type BoothCredentialHolder,
  type BoothPreflightResult,
} from "./lifecycle";
import { MemoryOutboxStore } from "./outbox";
import { BoothSession } from "./session";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FakeSession implements BoothLifecycleSession {
  readonly actions: string[] = [];
  recoverWork: Promise<void> = Promise.resolve();
  stopWork: Promise<void> = Promise.resolve();
  recoverResult = { authBlockedItemId: null as string | null };
  onResumeAuth: (itemId: string) => void = () => {};

  async recover() {
    this.actions.push("recover");
    await this.recoverWork;
    this.actions.push("recovered");
    return this.recoverResult;
  }

  start() {
    this.actions.push("start");
    return Promise.resolve();
  }

  async resumeAuth(itemId: string) {
    this.actions.push(`resume-auth:${itemId}`);
    this.onResumeAuth(itemId);
  }

  async stop() {
    this.actions.push("stop");
    await this.stopWork;
    this.actions.push("stopped");
  }
}

function harness(options: {
  stored?: Record<string, string>;
  preflight?: (
    event: string,
    key: string,
    signal: AbortSignal
  ) => Promise<BoothPreflightResult>;
} = {}) {
  const events: string[] = [];
  const access: string[] = [];
  const frames: Array<string[] | null> = [];
  const uploaded: string[] = [];
  const cleared: string[] = [];
  let cameraStarts = 0;
  let cameraStops = 0;
  let loads = 0;
  const coordinator = new BoothLifecycleCoordinator<{ url: string }>({
    preflight: options.preflight ?? (async () => ({ kind: "ready", frames: ["square"] })),
    loadCredential: (event) => {
      loads++;
      const key = options.stored?.[event];
      return key ? { key } : null;
    },
    clearCredential: (event) => cleared.push(event),
    onReset: (event) => events.push(event),
    onOutboxRecovered: () => events.push("outbox-recovered"),
    onAccess: (state, feedback) => access.push(`${state}:${feedback}`),
    onFrames: (next) => frames.push(next),
    onCameraStart: () => {
      cameraStarts++;
    },
    onCameraStop: () => {
      cameraStops++;
    },
    onUploaded: ({ url }) => uploaded.push(url),
  });
  return {
    coordinator,
    events,
    access,
    frames,
    uploaded,
    cleared,
    cameraStarts: () => cameraStarts,
    cameraStops: () => cameraStops,
    loads: () => loads,
  };
}

function credential(): BoothCredentialHolder {
  return { key: "" };
}

function activeCandidate(
  coordinator: BoothLifecycleCoordinator<{ url: string }>
) {
  return (coordinator as unknown as {
    active: { key: string } | null;
  }).active;
}

const photo = (name: string) => new Blob([name], { type: "image/jpeg" });

describe("Booth lifecycle coordination", () => {
  test("completes Outbox recovery before reading a stored credential or preflighting", async () => {
    const recovery = deferred<void>();
    const calls: string[] = [];
    const session = new FakeSession();
    session.recoverWork = recovery.promise;
    const h = harness({
      stored: { launch: "stored-key" },
      preflight: async () => {
        calls.push("preflight");
        return { kind: "ready", frames: ["square"] };
      },
    });

    const entering = h.coordinator.beginEvent("launch", session, credential());
    expect(session.actions).toEqual(["recover"]);
    expect(h.loads()).toBe(0);
    expect(calls).toEqual([]);
    expect(h.cameraStarts()).toBe(0);

    recovery.resolve();
    await entering;

    expect(h.loads()).toBe(1);
    expect(calls).toEqual(["preflight"]);
    expect(session.actions).toEqual(["recover", "recovered", "start"]);
    expect(h.cameraStarts()).toBe(1);
  });

  test("awaits the owning stop, then automatically retries an auth-blocked photo", async () => {
    const stopping = deferred<void>();
    const session = new FakeSession();
    session.stopWork = stopping.promise;
    const h = harness({ stored: { launch: "first-key" } });
    const sessionCredential = credential();
    session.onResumeAuth = () => h.coordinator.acceptUploaded(session, { url: "/acked" });
    await h.coordinator.beginEvent("launch", session, sessionCredential);
    expect(sessionCredential.key).toBe("first-key");

    void h.coordinator.authRequired(session, "auth-photo");
    expect(sessionCredential.key).toBe("");
    expect(h.cleared).toEqual(["launch"]);
    expect(h.access.at(-1)).toBe("locked:rejected-key");
    expect(session.actions).toContain("stop");

    const unlocking = h.coordinator.unlock("correct-key");
    await Promise.resolve();
    expect(sessionCredential.key).toBe("");
    expect(session.actions.filter((action) => action === "start")).toHaveLength(1);
    expect(session.actions).not.toContain("resume-auth:auth-photo");
    expect(h.uploaded).toEqual([]);

    stopping.resolve();
    await unlocking;

    expect(sessionCredential.key).toBe("correct-key");
    expect(session.actions.filter((action) => action === "start")).toHaveLength(2);
    expect(session.actions.at(-1)).toBe("resume-auth:auth-photo");
    expect(h.uploaded).toEqual(["/acked"]);
    expect(h.cameraStarts()).toBe(2);
  });

  test("ignores an out-of-order rejected preflight after a newer success", async () => {
    const first = deferred<BoothPreflightResult>();
    const second = deferred<BoothPreflightResult>();
    let attempts = 0;
    const h = harness({
      preflight: async () => (++attempts === 1 ? first.promise : second.promise),
    });
    const session = new FakeSession();
    const sessionCredential = credential();
    await h.coordinator.beginEvent("launch", session, sessionCredential);

    const stale = h.coordinator.unlock("old-key");
    const current = h.coordinator.unlock("new-key");
    expect(sessionCredential.key).toBe("");
    second.resolve({ kind: "ready", frames: ["square"] });
    await current;
    expect(sessionCredential.key).toBe("new-key");
    first.resolve({ kind: "unauthorized" });
    await stale;

    expect(h.access.at(-1)).toBe("ready:ready");
    expect(h.cleared).toEqual([]);
    expect(session.actions.filter((action) => action === "start")).toHaveLength(1);
    expect(h.cameraStarts()).toBe(1);
  });

  test("StrictMode-style cleanup prevents deferred recovery from starting old work", async () => {
    const recovery = deferred<void>();
    const oldSession = new FakeSession();
    oldSession.recoverWork = recovery.promise;
    const h = harness({ stored: { launch: "stored-key" } });

    const entering = h.coordinator.beginEvent("launch", oldSession, credential());
    await h.coordinator.leaveEvent(oldSession);
    recovery.resolve();
    await entering;

    expect(h.loads()).toBe(0);
    expect(oldSession.actions).toEqual(["recover", "stop", "stopped", "recovered"]);
    expect(h.cameraStarts()).toBe(0);
  });

  test("Event switch fences stale upload callbacks and starts with a full reset", async () => {
    const h = harness();
    const first = new FakeSession();
    const second = new FakeSession();
    const firstCredential = credential();
    await h.coordinator.beginEvent("first", first, firstCredential);
    h.coordinator.acceptUploaded(first, { url: "/first-before-switch" });

    const secondCredential = credential();
    await h.coordinator.beginEvent("second", second, secondCredential);
    h.coordinator.acceptUploaded(first, { url: "/stale" });
    h.coordinator.acceptUploaded(second, { url: "/second" });

    expect(h.events.filter((event) => event !== "outbox-recovered")).toEqual([
      "first",
      "second",
    ]);
    expect(h.uploaded).toEqual(["/first-before-switch", "/second"]);
    expect(firstCredential.key).toBe("");
    expect(secondCredential.key).toBe("");
    expect(h.frames.at(-1)).toBeNull();
    expect(h.cameraStops()).toBeGreaterThanOrEqual(2);
  });

  test("an old deferred upload can never observe the next Event credential", async () => {
    const uploadGate = deferred<void>();
    const sent: Array<{ event: string; key: string }> = [];
    const firstCredential = credential();
    const secondCredential = credential();
    const h = harness();
    const first = new FakeSession();
    const second = new FakeSession();

    await h.coordinator.beginEvent("first", first, firstCredential);
    await h.coordinator.unlock("first-key");
    const oldUpload = (async () => {
      await uploadGate.promise;
      sent.push({ event: "first", key: firstCredential.key });
    })();

    await h.coordinator.beginEvent("second", second, secondCredential);
    await h.coordinator.unlock("second-key");
    uploadGate.resolve();
    await oldUpload;

    expect(firstCredential.key).toBe("");
    expect(secondCredential.key).toBe("second-key");
    expect(sent).toEqual([{ event: "first", key: "" }]);
    expect(sent.some(({ key }) => key === "second-key")).toBe(false);
  });

  test("uses a fresh stop epoch for each auth failure and serializes each resume", async () => {
    const firstStop = deferred<void>();
    const secondStop = deferred<void>();
    const session = new FakeSession();
    const h = harness();
    await h.coordinator.beginEvent("launch", session, credential());
    await h.coordinator.unlock("initial-key");

    session.stopWork = firstStop.promise;
    void h.coordinator.authRequired(session, "first-auth");
    const firstUnlock = h.coordinator.unlock("first-replacement");
    await Promise.resolve();
    expect(session.actions.filter((action) => action === "stop")).toHaveLength(1);
    expect(session.actions).not.toContain("resume-auth:first-auth");
    firstStop.resolve();
    await firstUnlock;
    expect(session.actions.at(-1)).toBe("resume-auth:first-auth");

    session.stopWork = secondStop.promise;
    void h.coordinator.authRequired(session, "second-auth");
    const secondUnlock = h.coordinator.unlock("second-replacement");
    await Promise.resolve();
    expect(session.actions.filter((action) => action === "stop")).toHaveLength(2);
    expect(session.actions).not.toContain("resume-auth:second-auth");
    secondStop.resolve();
    await secondUnlock;

    expect(session.actions.at(-1)).toBe("resume-auth:second-auth");
    expect(session.actions.filter((action) => action.startsWith("resume-auth:"))).toEqual([
      "resume-auth:first-auth",
      "resume-auth:second-auth",
    ]);
  });

  test("fresh-page recovery resumes a persisted auth oldest item and drains FIFO", async () => {
    const store = new MemoryOutboxStore();
    await store.put({
      id: "persisted-auth",
      event: "launch",
      blob: photo("auth"),
      createdAt: 1,
      attempts: 1,
      lastError: "expired key",
      failureKind: "auth",
      errorClass: "auth",
    });
    await store.put({
      id: "ready-next",
      event: "launch",
      blob: photo("next"),
      createdAt: 2,
      attempts: 0,
    });
    const uploads: string[] = [];
    const session = new BoothSession("launch", store, async (item) => {
      uploads.push(item.id);
      return { url: `/${item.id}` };
    });
    const h = harness({ stored: { launch: "restored-key" } });

    await h.coordinator.beginEvent("launch", session, credential());

    expect(uploads).toEqual(["persisted-auth", "ready-next"]);
    expect(await store.list("launch")).toEqual([]);
    await session.stop();
  });

  test("fresh-page recovery leaves a persisted permanent oldest item paused", async () => {
    const store = new MemoryOutboxStore();
    await store.put({
      id: "persisted-permanent",
      event: "launch",
      blob: photo("permanent"),
      createdAt: 1,
      attempts: 1,
      lastError: "invalid photo",
      failureKind: "permanent",
      errorClass: "payload",
    });
    await store.put({
      id: "ready-next",
      event: "launch",
      blob: photo("next"),
      createdAt: 2,
      attempts: 0,
    });
    const uploads: string[] = [];
    const session = new BoothSession("launch", store, async (item) => {
      uploads.push(item.id);
      return { url: `/${item.id}` };
    });
    const h = harness({ stored: { launch: "restored-key" } });

    await h.coordinator.beginEvent("launch", session, credential());
    await session.process();

    expect(uploads).toEqual([]);
    expect(await store.list("launch")).toMatchObject([
      { id: "persisted-permanent", failureKind: "permanent" },
      { id: "ready-next" },
    ]);
    await session.stop();
  });

  test("zeros the previous candidate key immediately when replacing an Event", async () => {
    const nextRecovery = deferred<void>();
    const first = new FakeSession();
    const second = new FakeSession();
    second.recoverWork = nextRecovery.promise;
    const h = harness({ stored: { first: "first-key" } });
    await h.coordinator.beginEvent("first", first, credential());
    const previous = activeCandidate(h.coordinator);
    expect(previous?.key).toBe("first-key");

    const switching = h.coordinator.beginEvent("second", second, credential());

    expect(previous?.key).toBe("");
    nextRecovery.resolve();
    await switching;
  });

  test("zeros the active candidate key immediately when leaving an Event", async () => {
    const stopping = deferred<void>();
    const session = new FakeSession();
    session.stopWork = stopping.promise;
    const h = harness({ stored: { launch: "stored-key" } });
    await h.coordinator.beginEvent("launch", session, credential());
    const leavingActive = activeCandidate(h.coordinator);
    expect(leavingActive?.key).toBe("stored-key");

    const leaving = h.coordinator.leaveEvent(session);

    expect(leavingActive?.key).toBe("");
    stopping.resolve();
    await leaving;
  });
});

describe("preflight Frame validation", () => {
  test("keeps only current usable Frames", () => {
    expect(usablePreflightFrames(["unknown", "square"])).toEqual(["square"]);
  });

  test.each([
    { value: null },
    { value: {} },
    { value: [] },
    { value: ["unknown"] },
    { value: ["square", 42] },
  ])("rejects malformed, empty, or unknown-only Frames: $value", ({ value }) => {
    expect(usablePreflightFrames(value)).toBeNull();
  });

  test.each([
    { kind: "ready", frames: [] },
    { kind: "ready", frames: ["unknown"] },
    { kind: "ready", frames: { square: true } },
  ] satisfies BoothPreflightResult[])(
    "does not start Session or camera for unusable successful preflight %#",
    async (reply) => {
      const h = harness({ preflight: async () => reply });
      const session = new FakeSession();
      await h.coordinator.beginEvent("launch", session, credential());
      await h.coordinator.unlock("key");

      expect(h.access.at(-1)).toBe("unavailable:unavailable");
      expect(session.actions).not.toContain("start");
      expect(h.cameraStarts()).toBe(0);
    }
  );
});
