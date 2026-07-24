import { describe, expect, test } from "bun:test";
import { createOutboxStore, MemoryOutboxStore, type OutboxItem } from "./outbox";
import { BoothSession, runCaptureSequence } from "./session";
import { outboxUploadHeaders } from "./upload";

const photo = (name: string) => new Blob([name], { type: "image/jpeg" });
const text = (blob: Blob) => blob.text();

describe("BoothSession outbox", () => {
  test("reserves strictly increasing FIFO order across concurrent durable puts", async () => {
    let releasePuts!: () => void;
    const putBarrier = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    let waitingPuts = 0;
    class ConcurrentPutStore extends MemoryOutboxStore {
      override async put(item: OutboxItem) {
        waitingPuts++;
        if (waitingPuts === 2) releasePuts();
        await putBarrier;
        await super.put(item);
      }
    }

    const store = new ConcurrentPutStore();
    const ids = [
      "018f0000-0000-4000-8000-000000000002",
      "018f0000-0000-4000-8000-000000000001",
    ];
    const session = new BoothSession(
      "party",
      store,
      async () => ({ url: "/photo" }),
      () => {},
      () => ids.shift()!,
      () => 1753315200000
    );

    const [first, second] = await Promise.all([
      session.enqueueCapture(async () => photo("first"), {
        metadata: { source: "framed", frameKey: "square" },
      }),
      session.enqueueCapture(async () => photo("second"), {
        metadata: { source: "camera-fallback" },
      }),
    ]);

    expect([first.createdAt, second.createdAt]).toEqual([
      1753315200000,
      1753315200001,
    ]);
    expect(first.metadata?.capturedAt).toBe(first.createdAt);
    expect(second.metadata?.capturedAt).toBe(second.createdAt);
    const queued = await store.list("party");
    expect(queued.map((item) => item.id)).toEqual([first.id, second.id]);
    await expect(Promise.all(queued.map((item) => text(item.blob)))).resolves.toEqual([
      "first",
      "second",
    ]);
  });

  test("retains an older failure when a later capture is queued, then recovers in order", async () => {
    const store = new MemoryOutboxStore();
    const attempted: string[] = [];
    const uploadIdentities: Array<{ id: string; headers: Record<string, string> }> = [];
    let offline = true;
    let nextId = 0;
    const session = new BoothSession(
      "party",
      store,
      async (item) => {
        attempted.push(await text(item.blob));
        uploadIdentities.push({ id: item.id, headers: outboxUploadHeaders(item) });
        if (offline) throw new Error("venue Wi-Fi offline");
        return { url: `/photos/${await text(item.blob)}` };
      },
      () => {},
      () => `018f0000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
      () => 1753315200000 + nextId
    );

    await session.recover();
    const first = await session.enqueueCapture(async () => photo("first"), {
      metadata: { source: "framed", frameKey: "square" },
    });
    await session.process();
    const second = await session.enqueueCapture(async () => photo("second"), {
      metadata: { source: "camera-fallback" },
    });

    const failedQueue = await store.list("party");
    await expect(Promise.all(failedQueue.map((item) => text(item.blob)))).resolves.toEqual(["first", "second"]);
    expect(failedQueue[0].lastError).toBe("venue Wi-Fi offline");

    // A reload creates a new session over the same durable store.
    offline = false;
    const recoveredUrls: string[] = [];
    const recovered = new BoothSession("party", store, async (item) => {
      attempted.push(await text(item.blob));
      uploadIdentities.push({ id: item.id, headers: outboxUploadHeaders(item) });
      return { url: `/photos/${await text(item.blob)}` };
    }, ({ url }) => recoveredUrls.push(url));
    const states: string[] = [];
    recovered.subscribe((state) => states.push(`${state.status}:${state.pendingCount}:${state.error ?? ""}`));
    await recovered.recover();
    await recovered.retry();

    expect(attempted).toEqual(["first", "first", "second"]);
    expect(first.id).toBe(failedQueue[0].id);
    expect(second.id).toBe(failedQueue[1].id);
    expect(uploadIdentities).toEqual([
      { id: first.id, headers: outboxUploadHeaders(first) },
      { id: first.id, headers: outboxUploadHeaders(first) },
      { id: second.id, headers: outboxUploadHeaders(second) },
    ]);
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
    await session.enqueueCapture(async () => photo("one"), { metadata: { source: "camera-fallback" } });
    await Promise.all([session.process(), session.process(), session.process()]);
    expect(uploads).toBe(1);
  });

  test("does not resurrect an acknowledged item when its notification throws", async () => {
    const store = new MemoryOutboxStore();
    let uploads = 0;
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploads++;
        return { url: "/photo" };
      },
      () => {
        throw new Error("thumbnail render failed");
      }
    );
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await session.process();
    await session.retry();

    expect(uploads).toBe(1);
    expect(await store.list("party")).toEqual([]);
  });

  test("does not resurrect an acknowledged item when a state subscriber throws", async () => {
    const store = new MemoryOutboxStore();
    let uploads = 0;
    const session = new BoothSession("party", store, async () => {
      uploads++;
      return { url: "/photo" };
    });
    session.subscribe((state) => {
      if (uploads === 1 && state.status === "idle" && state.pendingCount === 0) {
        throw new Error("state render failed");
      }
    });
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await session.process();
    await session.retry();

    expect(uploads).toBe(1);
    expect(await store.list("party")).toEqual([]);
  });

  test("a post-ack list failure stops safely and retry continues with the next item", async () => {
    class FailingReconcileStore extends MemoryOutboxStore {
      private failNextList = false;

      override async remove(id: string) {
        await super.remove(id);
        this.failNextList = true;
      }

      override async list(event: string) {
        if (this.failNextList) {
          this.failNextList = false;
          throw new Error("outbox reconciliation failed");
        }
        return super.list(event);
      }
    }

    const store = new FailingReconcileStore();
    const uploads: string[] = [];
    const session = new BoothSession("party", store, async (item) => {
      uploads.push(await text(item.blob));
      return { url: "/photo" };
    });
    await session.enqueueCapture(async () => photo("first"), {
      metadata: { source: "camera-fallback" },
    });
    await session.enqueueCapture(async () => photo("second"), {
      metadata: { source: "camera-fallback" },
    });

    await session.process();
    await session.retry();

    expect(uploads).toEqual(["first", "second"]);
    expect(await store.list("party")).toEqual([]);
  });

  test("persists one identity and metadata before upload", async () => {
    const store = new MemoryOutboxStore();
    const seen: OutboxItem[] = [];
    const session = new BoothSession(
      "launch",
      store,
      async (item) => {
        seen.push(item);
        return { url: "/photo", key: "launch/photo.jpg" };
      },
      () => {},
      () => "018f0000-0000-4000-8000-000000000001",
      () => 1753315200000
    );

    const item = await session.enqueueCapture(
      async () => new Blob(["photo"], { type: "image/jpeg" }),
      { metadata: { source: "framed", frameKey: "square" } }
    );

    expect(item).toMatchObject({
      id: "018f0000-0000-4000-8000-000000000001",
      createdAt: 1753315200000,
      metadata: { capturedAt: 1753315200000, source: "framed", frameKey: "square" },
    });
    expect(await store.list("launch")).toEqual([item]);
    await session.process();
    expect(seen).toEqual([item]);
  });

  test("allocates identity only after capture succeeds", async () => {
    const store = new MemoryOutboxStore();
    let ids = 0;
    const session = new BoothSession(
      "launch",
      store,
      async () => ({ url: "/photo" }),
      () => {},
      () => {
        ids++;
        return "018f0000-0000-4000-8000-000000000001";
      }
    );

    await expect(session.enqueueCapture(
      async () => Promise.reject(new Error("composite failed")),
      { metadata: { source: "framed", frameKey: "square" } }
    )).rejects.toThrow("composite failed");

    expect(ids).toBe(0);
    expect(await store.list("launch")).toEqual([]);
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
