import { describe, expect, test } from "bun:test";
import { createOutboxStore, MemoryOutboxStore } from "./outbox";
import { BoothSession, runCaptureSequence } from "./session";

const photo = (name: string) => new Blob([name], { type: "image/jpeg" });
const text = (blob: Blob) => blob.text();

describe("BoothSession outbox", () => {
  test("retains an older failure when a later capture is queued, then recovers in order", async () => {
    const store = new MemoryOutboxStore();
    const attempted: string[] = [];
    let offline = true;
    let nextId = 0;
    const session = new BoothSession(
      "party",
      store,
      async (blob) => {
        attempted.push(await text(blob));
        if (offline) throw new Error("venue Wi-Fi offline");
        return { url: `/photos/${await text(blob)}` };
      },
      () => {},
      () => String(++nextId),
      () => nextId
    );

    await session.recover();
    await session.enqueueCapture(async () => photo("first"));
    await session.process();
    await session.enqueueCapture(async () => photo("second"));

    const failedQueue = await store.list("party");
    await expect(Promise.all(failedQueue.map((item) => text(item.blob)))).resolves.toEqual(["first", "second"]);
    expect(failedQueue[0].lastError).toBe("venue Wi-Fi offline");

    // A reload creates a new session over the same durable store.
    offline = false;
    const recoveredUrls: string[] = [];
    const recovered = new BoothSession("party", store, async (blob) => {
      attempted.push(await text(blob));
      return { url: `/photos/${await text(blob)}` };
    }, ({ url }) => recoveredUrls.push(url));
    const states: string[] = [];
    recovered.subscribe((state) => states.push(`${state.status}:${state.pendingCount}:${state.error ?? ""}`));
    await recovered.recover();
    await recovered.retry();

    expect(attempted).toEqual(["first", "first", "second"]);
    expect(recoveredUrls).toEqual(["/photos/first", "/photos/second"]);
    expect(await store.list("party")).toEqual([]);
    expect(states.at(-1)).toBe("idle:0:");
  });

  test("coalesces concurrent processors so an item uploads once", async () => {
    const store = new MemoryOutboxStore();
    let uploads = 0;
    const session = new BoothSession("party", store, async () => {
      uploads++;
      await Promise.resolve();
      return { url: "/photo" };
    });
    await session.enqueueCapture(async () => photo("one"));
    await Promise.all([session.process(), session.process(), session.process()]);
    expect(uploads).toBe(1);
  });

  test("memory store keeps events isolated and items ordered", async () => {
    const store = new MemoryOutboxStore();
    await store.put({ id: "b", event: "party", blob: photo("later"), createdAt: 2, attempts: 0 });
    await store.put({ id: "a", event: "other", blob: photo("other"), createdAt: 0, attempts: 0 });
    await store.put({ id: "c", event: "party", blob: photo("first"), createdAt: 1, attempts: 0 });
    expect((await store.list("party")).map((item) => item.id)).toEqual(["c", "b"]);
  });

  test("falls back to an in-memory queue when IndexedDB is unavailable", async () => {
    const store = createOutboxStore(null);
    const item = { id: "one", event: "party", blob: photo("safe"), createdAt: 1, attempts: 0 };
    await store.put(item);
    expect(await store.list("party")).toEqual([item]);
    expect(store.isDurable()).toBe(false);
    await store.remove(item.id);
    expect(await store.list("party")).toEqual([]);
  });
});

describe("runCaptureSequence", () => {
  test("sequences countdown, frames, and flashes", async () => {
    const events: string[] = [];
    let frame = 0;
    const frames = await runCaptureSequence({
      shots: 2,
      intervalMs: 1000,
      captureFrame: () => ++frame,
      onCountdown: (count, shot) => events.push(`count:${count}:${shot}`),
      onFlash: (visible) => events.push(`flash:${visible}`),
      delay: async (ms) => { events.push(`delay:${ms}`); },
    });
    expect(frames).toEqual([1, 2]);
    expect(events).toEqual([
      "count:1:1", "delay:1000", "count:0:1", "flash:true", "delay:300", "flash:false", "delay:400",
      "count:1:2", "delay:1000", "count:0:2", "flash:true", "delay:300", "flash:false",
    ]);
  });

  test("cancels before taking another frame", async () => {
    const controller = new AbortController();
    let frames = 0;
    const result = runCaptureSequence({
      shots: 2,
      intervalMs: 1000,
      signal: controller.signal,
      captureFrame: () => ++frames,
      onCountdown: () => {},
      onFlash: () => {},
      delay: async () => { controller.abort(); },
    });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(frames).toBe(0);
  });
});
