import { describe, expect, test } from "bun:test";
import {
  BoothLifecycleCoordinator,
  usablePreflightFrames,
  type BoothLifecycleSession,
  type BoothPreflightResult,
} from "./lifecycle";

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
  onRetry: () => void = () => {};

  async recover() {
    this.actions.push("recover");
    await this.recoverWork;
    this.actions.push("recovered");
  }

  start() {
    this.actions.push("start");
    return Promise.resolve();
  }

  async retry() {
    this.actions.push("retry");
    this.onRetry();
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
  const credentials: string[] = [];
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
    onCredential: (key) => credentials.push(key),
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
    credentials,
    uploaded,
    cleared,
    cameraStarts: () => cameraStarts,
    cameraStops: () => cameraStops,
    loads: () => loads,
  };
}

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

    const entering = h.coordinator.beginEvent("launch", session);
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
    session.onRetry = () => h.coordinator.acceptUploaded(session, { url: "/acked" });
    await h.coordinator.beginEvent("launch", session);

    void h.coordinator.authRequired(session);
    expect(h.cleared).toEqual(["launch"]);
    expect(h.access.at(-1)).toBe("locked:rejected-key");
    expect(session.actions).toContain("stop");

    const unlocking = h.coordinator.unlock("correct-key");
    await Promise.resolve();
    expect(session.actions.filter((action) => action === "start")).toHaveLength(1);
    expect(session.actions).not.toContain("retry");
    expect(h.uploaded).toEqual([]);

    stopping.resolve();
    await unlocking;

    expect(session.actions.filter((action) => action === "start")).toHaveLength(2);
    expect(session.actions.at(-1)).toBe("retry");
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
    await h.coordinator.beginEvent("launch", session);

    const stale = h.coordinator.unlock("old-key");
    const current = h.coordinator.unlock("new-key");
    second.resolve({ kind: "ready", frames: ["square"] });
    await current;
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

    const entering = h.coordinator.beginEvent("launch", oldSession);
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
    await h.coordinator.beginEvent("first", first);
    h.coordinator.acceptUploaded(first, { url: "/first-before-switch" });

    await h.coordinator.beginEvent("second", second);
    h.coordinator.acceptUploaded(first, { url: "/stale" });
    h.coordinator.acceptUploaded(second, { url: "/second" });

    expect(h.events.filter((event) => event !== "outbox-recovered")).toEqual([
      "first",
      "second",
    ]);
    expect(h.uploaded).toEqual(["/first-before-switch", "/second"]);
    expect(h.credentials.at(-1)).toBe("");
    expect(h.frames.at(-1)).toBeNull();
    expect(h.cameraStops()).toBeGreaterThanOrEqual(2);
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
      await h.coordinator.beginEvent("launch", session);
      await h.coordinator.unlock("key");

      expect(h.access.at(-1)).toBe("unavailable:unavailable");
      expect(session.actions).not.toContain("start");
      expect(h.cameraStarts()).toBe(0);
    }
  );
});
