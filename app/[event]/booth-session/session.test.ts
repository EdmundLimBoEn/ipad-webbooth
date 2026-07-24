import { describe, expect, test } from "bun:test";
import { createOutboxStore, MemoryOutboxStore, type OutboxItem } from "./outbox";
import { BoothSession, runCaptureSequence } from "./session";
import { outboxUploadHeaders } from "./upload";
import { HttpUploadError } from "./retry-policy";

const photo = (name: string) => new Blob([name], { type: "image/jpeg" });
const text = (blob: Blob) => blob.text();

class ManualScheduler {
  private nextId = 0;
  readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  setTimer = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, delayMs });
    return id;
  };

  clearTimer = (id: unknown) => {
    this.timers.delete(id as number);
  };

  runNext() {
    const next = [...this.timers.entries()].sort((a, b) => a[0] - b[0])[0];
    if (!next) throw new Error("No scheduled BoothSession wake");
    this.timers.delete(next[0]);
    next[1].callback();
    return next[1].delayMs;
  }
}

function versionOneIndexedDb(rows: OutboxItem[]) {
  const names = new Set(["photo-outbox"]);
  const openedVersions: number[] = [];
  const createdStores: string[] = [];
  const oldOutboxWrites: string[] = [];

  type FakeRequest<T> = {
    result: T;
    error: Error | null;
    onsuccess: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
  };
  type FakeTransaction = {
    oncomplete: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
    onabort: ((event: Event) => void) | null;
    objectStore: (name: string) => IDBObjectStore;
  };

  const transaction = (): IDBTransaction => {
    const fake: FakeTransaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => ({
        getAll: () => {
          const request: FakeRequest<OutboxItem[]> = {
            result: rows,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => {
            request.onsuccess?.(new Event("success"));
            queueMicrotask(() => fake.oncomplete?.(new Event("complete")));
          });
          return request as unknown as IDBRequest<OutboxItem[]>;
        },
        put: () => {
          oldOutboxWrites.push("put");
          throw new Error("v1 rows must not be rewritten during upgrade");
        },
        delete: () => {
          oldOutboxWrites.push("delete");
          throw new Error("v1 rows must not be deleted during upgrade");
        },
      } as unknown as IDBObjectStore),
    };
    return fake as unknown as IDBTransaction;
  };
  const database = {
    objectStoreNames: { contains: (name: string) => names.has(name) },
    createObjectStore: (name: string) => {
      createdStores.push(name);
      names.add(name);
      return {} as IDBObjectStore;
    },
    transaction: () => transaction(),
  } as unknown as IDBDatabase;
  const factory = {
    open: (_name: string, version?: number) => {
      openedVersions.push(version ?? 0);
      const request = {
        result: database,
        error: null as Error | null,
        onupgradeneeded: null as ((event: Event) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onblocked: null as ((event: Event) => void) | null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.(new Event("upgradeneeded"));
        queueMicrotask(() => request.onsuccess?.(new Event("success")));
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return { factory, openedVersions, createdStores, oldOutboxWrites };
}

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

  test("upgrades IndexedDB v1 by adding only the lease store without rewriting old rows", async () => {
    const legacy = {
      id: "legacy",
      event: "party",
      blob: photo("legacy"),
      createdAt: 1,
      attempts: 2,
      lastError: "offline",
    };
    const fake = versionOneIndexedDb([legacy]);
    const store = createOutboxStore(fake.factory);

    expect(await store.list("party")).toEqual([legacy]);
    expect(fake.openedVersions).toEqual([2]);
    expect(fake.createdStores).toEqual(["photo-outbox-leases"]);
    expect(fake.oldOutboxWrites).toEqual([]);
  });

  test("persists retry eligibility and failure classification across Session reload", async () => {
    const store = new MemoryOutboxStore();
    let now = 10_000;
    const first = new BoothSession(
      "party",
      store,
      async () => {
        throw new HttpUploadError(503, null, "server");
      },
      () => {},
      () => "018f0000-0000-4000-8000-000000000001",
      () => now,
      { random: () => 0.5 }
    );
    await first.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });
    await first.process();

    expect(await store.list("party")).toMatchObject([{
      attempts: 1,
      failureKind: "retryable",
      errorClass: "server",
      nextAttemptAt: 11_000,
    }]);

    const states: string[] = [];
    const reloaded = new BoothSession(
      "party",
      store,
      async () => ({ url: "/photo" }),
      () => {},
      undefined,
      () => now
    );
    reloaded.subscribe((state) => states.push(`${state.status}:${state.error ?? ""}`));
    await reloaded.recover();

    expect(states.at(-1)).toBe("failed:upload failed with status 503");
    expect(await store.list("party")).toMatchObject([{
      failureKind: "retryable",
      errorClass: "server",
      nextAttemptAt: 11_000,
    }]);
  });

  test("the oldest blocked item prevents later uploads until manual retry", async () => {
    const store = new MemoryOutboxStore();
    await store.put({
      id: "oldest",
      event: "party",
      blob: photo("oldest"),
      createdAt: 1,
      attempts: 1,
      lastError: "invalid payload",
      failureKind: "permanent",
      errorClass: "payload",
    });
    await store.put({
      id: "later",
      event: "party",
      blob: photo("later"),
      createdAt: 2,
      attempts: 0,
    });
    const uploads: string[] = [];
    const session = new BoothSession("party", store, async (item) => {
      uploads.push(await text(item.blob));
      return { url: "/photo" };
    });

    await session.process();
    expect(uploads).toEqual([]);
    expect((await store.list("party")).map((item) => item.id)).toEqual(["oldest", "later"]);

    await session.retry();
    expect(uploads).toEqual(["oldest", "later"]);
    expect(await store.list("party")).toEqual([]);
  });

  test("connectivity and foreground wakes immediately reconsider an oldest retryable item", async () => {
    for (const reason of ["connectivity", "foreground"] as const) {
      const store = new MemoryOutboxStore();
      await store.put({
        id: `oldest-${reason}`,
        event: "party",
        blob: photo(reason),
        createdAt: 1,
        attempts: 1,
        lastError: "offline",
        nextAttemptAt: 50_000,
        failureKind: "retryable",
        errorClass: "network",
      });
      const uploads: string[] = [];
      const session = new BoothSession(
        "party",
        store,
        async (item) => {
          uploads.push(await text(item.blob));
          return { url: "/photo" };
        },
        () => {},
        undefined,
        () => 10_000
      );

      await session.start();
      expect(uploads).toEqual([]);
      await session.reconsider(reason);
      expect(uploads).toEqual([reason]);
      await session.stop();
    }
  });

  test("automatic wakes retry the oldest retryable item when it becomes eligible", async () => {
    const store = new MemoryOutboxStore();
    const scheduler = new ManualScheduler();
    let now = 1_000;
    let uploads = 0;
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploads++;
        if (uploads === 1) throw new TypeError("offline");
        return { url: "/photo" };
      },
      () => {},
      () => "018f0000-0000-4000-8000-000000000001",
      () => now,
      {
        random: () => 0.5,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
        leaseTtlMs: 60_000,
      }
    );
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await session.start();
    expect(uploads).toBe(1);
    expect([...scheduler.timers.values()].map((timer) => timer.delayMs)).toContain(1_000);

    now = 2_000;
    scheduler.runNext();
    await session.process();

    expect(uploads).toBe(2);
    expect(await store.list("party")).toEqual([]);
    await session.stop();
  });

  test("permanent and auth failures do not automatically restart on environmental wakes", async () => {
    for (const failureKind of ["permanent", "auth"] as const) {
      const store = new MemoryOutboxStore();
      await store.put({
        id: failureKind,
        event: "party",
        blob: photo(failureKind),
        createdAt: 1,
        attempts: 1,
        lastError: failureKind,
        failureKind,
        errorClass: failureKind === "auth" ? "auth" : "payload",
      });
      let uploads = 0;
      const session = new BoothSession("party", store, async () => {
        uploads++;
        return { url: "/photo" };
      });

      await session.start();
      await session.reconsider("connectivity");
      await session.reconsider("foreground");
      expect(uploads).toBe(0);
      await session.stop();
    }
  });

  test("persists auth failure before notifying the credential owner", async () => {
    const store = new MemoryOutboxStore();
    let persistedBeforeCallback = false;
    const session = new BoothSession(
      "party",
      store,
      async () => {
        throw new HttpUploadError(401, null, "auth");
      },
      () => {},
      () => "018f0000-0000-4000-8000-000000000001",
      () => 1_000,
      {
        onAuthRequired: async () => {
          const [item] = await store.list("party");
          persistedBeforeCallback =
            item.failureKind === "auth" && item.errorClass === "auth";
        },
      }
    );
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await session.process();

    expect(persistedBeforeCallback).toBe(true);
    expect(await store.list("party")).toMatchObject([{
      attempts: 1,
      failureKind: "auth",
      errorClass: "auth",
    }]);
  });

  test("one Event lease prevents two Sessions from draining simultaneously", async () => {
    const store = new MemoryOutboxStore();
    await store.put({
      id: "one",
      event: "party",
      blob: photo("one"),
      createdAt: 1,
      attempts: 0,
    });
    let releaseUpload!: () => void;
    const uploadBarrier = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let firstUploads = 0;
    let secondUploads = 0;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = new BoothSession(
      "party",
      store,
      async () => {
        firstUploads++;
        firstStarted();
        await uploadBarrier;
        return { url: "/photo" };
      },
      () => {},
      undefined,
      () => 1_000,
      { ownerId: "first" }
    );
    const second = new BoothSession(
      "party",
      store,
      async () => {
        secondUploads++;
        return { url: "/photo" };
      },
      () => {},
      undefined,
      () => 1_000,
      { ownerId: "second" }
    );

    const firstDrain = first.process();
    await started;
    await second.process();
    expect(firstUploads).toBe(1);
    expect(secondUploads).toBe(0);

    releaseUpload();
    await firstDrain;
    await Promise.all([first.stop(), second.stop()]);
  });

  test("keeps lease renewal scheduled while an automatic retry upload is running", async () => {
    const store = new MemoryOutboxStore();
    const scheduler = new ManualScheduler();
    let now = 0;
    let releaseUpload!: () => void;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let retryUploadStarted!: () => void;
    const retryUpload = new Promise<void>((resolve) => {
      retryUploadStarted = resolve;
    });
    let uploads = 0;
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploads++;
        if (uploads === 1) throw new TypeError("offline");
        retryUploadStarted();
        await uploadBlocked;
        return { url: "/photo" };
      },
      () => {},
      undefined,
      () => now,
      {
        ownerId: "first",
        leaseTtlMs: 2_000,
        random: () => 0,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
      }
    );
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });
    await session.start();

    try {
      now = 500;
      scheduler.runNext();
      await retryUpload;
      expect([...scheduler.timers.values()].map((timer) => timer.delayMs)).toContain(500);

      now = 1_000;
      scheduler.runNext();
      await Promise.resolve();
      await Promise.resolve();
      now = 2_001;
      expect(await store.acquireLease("party", "second", now, 2_000)).toBe(false);
    } finally {
      releaseUpload();
      await session.stop();
    }
  });

  test("continues renewing while stop waits for a long-running upload", async () => {
    const store = new MemoryOutboxStore();
    const scheduler = new ManualScheduler();
    let now = 0;
    let releaseUpload!: () => void;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    await store.put({ id: "one", event: "party", blob: photo("one"), createdAt: 1, attempts: 0 });
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploadStarted();
        await uploadBlocked;
        return { url: "/photo" };
      },
      () => {},
      undefined,
      () => now,
      {
        ownerId: "first",
        leaseTtlMs: 100,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
      }
    );

    const drain = session.start();
    await started;
    const stopping = session.stop();
    try {
      expect([...scheduler.timers.values()].map((timer) => timer.delayMs)).toContain(50);
      now = 50;
      scheduler.runNext();
      await Promise.resolve();
      await Promise.resolve();
      now = 101;
      expect(await store.acquireLease("party", "second", now, 100)).toBe(false);
    } finally {
      releaseUpload();
      await Promise.all([drain, stopping]);
    }
  });

  test("does not resurrect an item removed between a manual retry read and lease acquisition", async () => {
    class NoLeaseStore extends MemoryOutboxStore {
      override async acquireLease() {
        return false;
      }
    }

    const store = new NoLeaseStore();
    await store.put({
      id: "oldest",
      event: "party",
      blob: photo("oldest"),
      createdAt: 1,
      attempts: 1,
      lastError: "bad payload",
      failureKind: "permanent",
      errorClass: "payload",
    });
    const session = new BoothSession("party", store, async () => ({ url: "/photo" }));

    const retry = session.retry();
    await store.remove("oldest");
    await retry;

    expect(await store.list("party")).toEqual([]);
  });

  test("does not recreate a row when a stale owner fails after another owner takes over", async () => {
    const store = new MemoryOutboxStore();
    let now = 0;
    let releaseFailure!: () => void;
    const failureBlocked = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    await store.put({ id: "one", event: "party", blob: photo("one"), createdAt: 1, attempts: 0 });
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploadStarted();
        await failureBlocked;
        throw new TypeError("offline");
      },
      () => {},
      undefined,
      () => now,
      { ownerId: "first", leaseTtlMs: 100, random: () => 0 }
    );

    const drain = session.process();
    await started;
    now = 101;
    expect(await store.acquireLease("party", "second", now, 100)).toBe(true);
    await store.remove("one");
    releaseFailure();
    await drain;

    expect(await store.list("party")).toEqual([]);
    await store.releaseLease("party", "second");
  });

  test("does not classify an acknowledged upload as failed when outbox cleanup fails", async () => {
    class RemoveFailsStore extends MemoryOutboxStore {
      override async remove() {
        throw new Error("outbox cleanup failed");
      }
    }

    const store = new RemoveFailsStore();
    const session = new BoothSession("party", store, async () => ({ url: "/photo" }));
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await session.process();

    const [queued] = await store.list("party");
    expect(queued.attempts).toBe(0);
    expect(queued).not.toHaveProperty("lastError");
    expect(queued).not.toHaveProperty("failureKind");
    expect(queued).not.toHaveProperty("errorClass");
  });

  test("does not deadlock when auth recovery awaits stop", async () => {
    const store = new MemoryOutboxStore();
    let session!: BoothSession;
    session = new BoothSession(
      "party",
      store,
      async () => {
        throw new HttpUploadError(401, null, "auth");
      },
      () => {},
      undefined,
      () => 1_000,
      { onAuthRequired: () => session.stop() }
    );
    await session.enqueueCapture(async () => photo("one"), {
      metadata: { source: "camera-fallback" },
    });

    await expect(Promise.race([
      session.process(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("auth deadlock")), 100)),
    ])).resolves.toBeUndefined();
    expect(await store.list("party")).toMatchObject([{ failureKind: "auth" }]);
  });

  test("renews a long-running direct drain lease before another owner can acquire it", async () => {
    const store = new MemoryOutboxStore();
    const scheduler = new ManualScheduler();
    let now = 0;
    let releaseUpload!: () => void;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    await store.put({
      id: "one",
      event: "party",
      blob: photo("one"),
      createdAt: 1,
      attempts: 0,
    });
    const session = new BoothSession(
      "party",
      store,
      async () => {
        uploadStarted();
        await uploadBlocked;
        return { url: "/photo" };
      },
      () => {},
      undefined,
      () => now,
      {
        ownerId: "first",
        leaseTtlMs: 100,
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
      }
    );

    const drain = session.process();
    await started;
    expect([...scheduler.timers.values()].map((timer) => timer.delayMs)).toContain(50);

    now = 50;
    scheduler.runNext();
    await Promise.resolve();
    await Promise.resolve();
    now = 101;
    expect(await store.acquireLease("party", "second", now, 100)).toBe(false);

    releaseUpload();
    await drain;
  });

  test("an expired lease can be acquired by another owner and Events stay independent", async () => {
    const store = new MemoryOutboxStore();

    expect(await store.acquireLease("party", "first", 1_000, 500)).toBe(true);
    expect(await store.acquireLease("party", "second", 1_499, 500)).toBe(false);
    expect(await store.acquireLease("other", "second", 1_499, 500)).toBe(true);
    expect(await store.acquireLease("party", "second", 1_500, 500)).toBe(true);
    expect(await store.renewLease("party", "first", 1_501, 500)).toBe(false);
    await store.releaseLease("party", "first");
    expect(await store.acquireLease("party", "third", 1_600, 500)).toBe(false);
    await store.releaseLease("party", "second");
    expect(await store.acquireLease("party", "third", 1_600, 500)).toBe(true);
  });

  test("stop clears scheduled work and releases only its own lease", async () => {
    const store = new MemoryOutboxStore();
    const scheduler = new ManualScheduler();
    await store.put({
      id: "one",
      event: "party",
      blob: photo("one"),
      createdAt: 1,
      attempts: 1,
      lastError: "offline",
      nextAttemptAt: 50_000,
      failureKind: "retryable",
      errorClass: "network",
    });
    const session = new BoothSession(
      "party",
      store,
      async () => ({ url: "/photo" }),
      () => {},
      undefined,
      () => 1_000,
      {
        ownerId: "first",
        setTimer: scheduler.setTimer,
        clearTimer: scheduler.clearTimer,
      }
    );

    await session.start();
    expect(scheduler.timers.size).toBe(1);
    expect(await store.acquireLease("party", "second", 1_000, 30_000)).toBe(false);

    await session.stop();

    expect(scheduler.timers.size).toBe(0);
    expect(await store.acquireLease("party", "second", 1_000, 30_000)).toBe(true);
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
