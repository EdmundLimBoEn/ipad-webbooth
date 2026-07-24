import { describe, expect, test } from "bun:test";
import type { BoothHeartbeatInput } from "../../booth-control";
import {
  BoothHeartbeatReporter,
  BoothStatePoller,
  createBoothOperationalSessionState,
  type FetchLike,
} from "./operational-client";

const EVENT = "launch";
const DEVICE_ID = "0f9c4f16-2f58-4ea3-88c0-c7a3f2c2b81a";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

class Timers {
  private nextId = 0;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  set = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.pending.set(id, { callback, delayMs });
    return id;
  };

  clear = (timer: unknown) => {
    this.pending.delete(timer as number);
  };

  delays() {
    return [...this.pending.values()].map(({ delayMs }) => delayMs);
  }

  runNext() {
    const [id, timer] = this.pending.entries().next().value as [
      number,
      { callback: () => void; delayMs: number },
    ];
    this.pending.delete(id);
    timer.callback();
  }
}

function heartbeat(changes: Partial<BoothHeartbeatInput> = {}): BoothHeartbeatInput {
  return {
    version: 1,
    deviceId: DEVICE_ID,
    sessionStartedAt: 100,
    pendingCount: 0,
    durableStorage: true,
    online: true,
    installed: false,
    camera: "ready",
    upload: "idle",
    buildId: "development",
    ...changes,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operationalState(paused: boolean) {
  return {
    version: 1,
    paused,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("BoothStatePoller", () => {
  test("polls immediately and schedules the next poll only after completion", async () => {
    const timers = new Timers();
    const calls: string[] = [];
    const states: Array<{ paused: boolean; connected: boolean }> = [];
    const fetch: FetchLike = async (input) => {
      calls.push(String(input));
      return response(operationalState(false));
    };
    const poller = new BoothStatePoller({
      event: EVENT,
      fetch,
      onState: (state) => states.push({ paused: state.paused, connected: state.connected }),
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    poller.start();
    await settle();

    expect(calls).toEqual(["/api/booth-state?event=launch"]);
    expect(states.at(-1)).toEqual({ paused: false, connected: true });
    expect(timers.delays()).toEqual([5_000]);

    timers.runNext();
    await settle();
    expect(calls).toHaveLength(2);
  });

  test("shares an in-flight request instead of overlapping state polls", async () => {
    const pending = deferred<Response>();
    let calls = 0;
    const poller = new BoothStatePoller({
      event: EVENT,
      fetch: () => {
        calls++;
        return pending.promise;
      },
    });

    const first = poller.refresh();
    const second = poller.refresh();
    expect(second).toBe(first);
    expect(calls).toBe(1);

    pending.resolve(response(operationalState(true)));
    await first;
  });

  test("retains the last pause value and reports disconnected after a poll failure", async () => {
    const states: Array<{ paused: boolean; connected: boolean }> = [];
    let attempt = 0;
    const poller = new BoothStatePoller({
      event: EVENT,
      fetch: async () => {
        attempt++;
        if (attempt === 1) return response(operationalState(true));
        throw new TypeError("offline");
      },
      onState: (state) => states.push({ paused: state.paused, connected: state.connected }),
    });

    await poller.refresh();
    await poller.refresh();

    expect(states.at(-1)).toEqual({ paused: true, connected: false });
  });

  test("rejects partial, incompatible, and unknown state fields without clearing pause", async () => {
    const states: Array<{ paused: boolean; connected: boolean }> = [];
    const replies = [
      operationalState(true),
      { paused: false },
      { ...operationalState(false), version: 2 },
      { ...operationalState(false), unexpected: true },
    ];
    const poller = new BoothStatePoller({
      event: EVENT,
      fetch: async () => response(replies.shift()),
      onState: (state) => states.push(state),
    });

    await poller.refresh();
    await poller.refresh();
    await poller.refresh();
    await poller.refresh();

    expect(states).toEqual([
      { paused: true, connected: true },
      { paused: true, connected: false },
      { paused: true, connected: false },
      { paused: true, connected: false },
    ]);
  });

  test.each(["success", "error"] as const)(
    "stop then start immediately polls a new generation and ignores delayed old %s",
    async (outcome) => {
      const timers = new Timers();
      const old = deferred<Response>();
      const current = deferred<Response>();
      const requests = [old, current];
      const states: Array<{ paused: boolean; connected: boolean }> = [];
      const poller = new BoothStatePoller({
        event: EVENT,
        fetch: () => requests.shift()!.promise,
        onState: (state) => states.push(state),
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      poller.start();
      poller.stop();
      poller.start();

      expect(requests).toHaveLength(0);
      current.resolve(response(operationalState(false)));
      await settle();
      if (outcome === "success") old.resolve(response(operationalState(true)));
      else old.reject(new TypeError("delayed offline"));
      await settle();

      expect(states).toEqual([{ paused: false, connected: true }]);
      expect(timers.delays()).toEqual([5_000]);
    }
  );
});

describe("BoothHeartbeatReporter", () => {
  test("sends immediately and schedules every heartbeat after the previous request settles", async () => {
    const timers = new Timers();
    const requests: RequestInit[] = [];
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        return response({ ok: true });
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    reporter.update(heartbeat());

    reporter.start();
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      headers: { "x-booth-key": "operator-key" },
    });
    expect(JSON.parse(String(requests[0].body))).toEqual(heartbeat());
    expect(timers.delays()).toEqual([15_000]);

    timers.runNext();
    await settle();
    expect(requests).toHaveLength(2);
  });

  test("coalesces state changes that occur during a heartbeat into one fresh report", async () => {
    const first = deferred<Response>();
    const sent: BoothHeartbeatInput[] = [];
    let calls = 0;
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as BoothHeartbeatInput);
        calls++;
        return calls === 1 ? first.promise : response({ ok: true });
      },
    });
    reporter.update(heartbeat({ pendingCount: 1 }));
    reporter.start();
    reporter.update(heartbeat({ pendingCount: 2 }));
    reporter.update(heartbeat({ pendingCount: 3, upload: "uploading" }));

    first.resolve(response({ ok: true }));
    await settle();

    expect(sent).toEqual([
      heartbeat({ pendingCount: 1 }),
      heartbeat({ pendingCount: 3, upload: "uploading" }),
    ]);
  });

  test("contains heartbeat failures so session work never rejects", async () => {
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: async () => { throw new TypeError("offline"); },
    });
    reporter.update(heartbeat());

    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  test("relocks through the auth callback when a heartbeat receives 401", async () => {
    let authRequired = 0;
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: async () => response({ error: "unauthorized" }, 401),
      onAuthRequired: () => { authRequired++; },
    });
    reporter.update(heartbeat());

    await reporter.flush();

    expect(authRequired).toBe(1);
  });

  test("stop aborts in-flight requests and clears completion timers", async () => {
    const timers = new Timers();
    let signal: AbortSignal | undefined;
    const pending = deferred<Response>();
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: (_input, init) => {
        signal = init?.signal ?? undefined;
        return pending.promise;
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    reporter.update(heartbeat());
    reporter.start();
    await settle();
    reporter.stop();

    expect(signal?.aborted).toBe(true);
    pending.resolve(response({ ok: true }));
    await settle();
    expect(timers.pending).toHaveLength(0);
  });

  test("stops an in-flight state poll and its timer", async () => {
    const timers = new Timers();
    let signal: AbortSignal | undefined;
    const pending = deferred<Response>();
    const poller = new BoothStatePoller({
      event: EVENT,
      fetch: (_input, init) => {
        signal = init?.signal ?? undefined;
        return pending.promise;
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    poller.start();
    await settle();
    poller.stop();

    expect(signal?.aborted).toBe(true);
    pending.resolve(response(operationalState(false)));
    await settle();
    expect(timers.pending).toHaveLength(0);
  });

  test.each(["success", "error"] as const)(
    "stop then start sends a new generation and ignores delayed old %s",
    async (outcome) => {
      const timers = new Timers();
      const old = deferred<Response>();
      const current = deferred<Response>();
      const requests = [old, current];
      const reporter = new BoothHeartbeatReporter({
        event: EVENT,
        boothKey: () => "operator-key",
        fetch: () => requests.shift()!.promise,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      reporter.update(heartbeat({ pendingCount: 1 }));
      reporter.start();
      reporter.stop();
      reporter.update(heartbeat({ pendingCount: 2 }));
      reporter.start();

      expect(requests).toHaveLength(0);
      current.resolve(response({ ok: true }));
      await settle();
      if (outcome === "success") old.resolve(response({ ok: true }));
      else old.reject(new TypeError("delayed offline"));
      await settle();

      expect(timers.delays()).toEqual([15_000]);
    }
  );

  test("a delayed old 401 cannot relock a restarted reporter", async () => {
    const old = deferred<Response>();
    const current = deferred<Response>();
    const requests = [old, current];
    let authRequired = 0;
    const reporter = new BoothHeartbeatReporter({
      event: EVENT,
      boothKey: () => "operator-key",
      fetch: () => requests.shift()!.promise,
      onAuthRequired: () => { authRequired++; },
    });
    reporter.update(heartbeat({ pendingCount: 1 }));
    reporter.start();
    reporter.stop();
    reporter.update(heartbeat({ pendingCount: 2 }));
    reporter.start();

    expect(requests).toHaveLength(0);
    old.resolve(response({ error: "unauthorized" }, 401));
    current.resolve(response({ ok: true }));
    await settle();

    expect(authRequired).toBe(0);
  });
});

describe("Booth operational Event reset", () => {
  test("navigation cannot carry Event A upload or pause state into Event B", () => {
    const eventA = createBoothOperationalSessionState(100);
    eventA.lastSuccessfulUploadAt = 150;
    eventA.operational = { paused: true, connected: true };
    eventA.cameraErrorClass = "camera-unavailable";

    const eventB = createBoothOperationalSessionState(200);

    expect(eventB).toEqual({
      sessionStartedAt: 200,
      lastSuccessfulUploadAt: null,
      operational: { paused: false, connected: false },
      cameraErrorClass: null,
    });
    expect(eventB).not.toEqual(eventA);
  });
});
