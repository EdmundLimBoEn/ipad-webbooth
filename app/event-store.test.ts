import { describe, expect, test } from "bun:test";
import {
  canonicalEvent,
  ConfigConflictError,
  ConfigMutationConflictError,
  ConfigRevisionNotFoundError,
  EventStore,
  InMemoryObjectStore,
  InvalidEventSlugError,
  InvalidStoredModerationPhotoError,
  InvalidPhotoIndexRebuildStateError,
  InvalidPhotoCursorError,
  InvalidStoredConfigRevisionError,
  eventConfigKey,
  eventConfigMutationKey,
  eventConfigRevisionKey,
  boothHeartbeatKey,
  boothOperationalStateKey,
  legacyEventConfigKey,
  PhotoIndexWriteError,
  photoFeedCommittedKey,
  photoFeedHeadKey,
  photoFeedMarkerKey,
  photoIndexKey,
  photoIndexRebuildCheckpointKey,
  photoIndexRebuildCompleteKey,
  photoReceiptKey,
  type ListOptions,
  type ListResult,
  type StoredObjectBody,
} from "./event-store";
import type { BoothHeartbeatInput } from "./booth-control";
import { InvalidPhotoReceiptError } from "./photo-metadata";

class FailPrivatePhotoWriteStore extends InMemoryObjectStore {
  private writesFail = true;

  constructor(private readonly failingPrefix: string) {
    super();
  }

  allowWrites(): void {
    this.writesFail = false;
  }

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (this.writesFail && key.startsWith(this.failingPrefix)) {
      throw new Error(`simulated private write failure for ${key}`);
    }
    return super.compareAndSwap(key, expectedEtag, value);
  }
}

class CappedListStore extends InMemoryObjectStore {
  constructor(private readonly cap: number) {
    super();
  }

  override list(options: ListOptions = {}): Promise<ListResult> {
    return super.list({ ...options, limit: Math.min(options.limit ?? this.cap, this.cap) });
  }
}

class FailNextIndexCreateStore extends InMemoryObjectStore {
  fail = true;

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (this.fail && key.includes("/photo-index/v1/")) {
      this.fail = false;
      throw new Error("simulated index write failure");
    }
    return super.compareAndSwap(key, expectedEtag, value);
  }
}

class MissingDuringRebuildStore extends InMemoryObjectStore {
  override async get(key: string): Promise<StoredObjectBody | null> {
    if (key === "launch/1753315200000-gone.jpg") {
      await this.delete(key);
      return null;
    }
    return super.get(key);
  }
}

class CrashBeforeCompleteMarkerStore extends InMemoryObjectStore {
  crash = true;

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (this.crash && key === photoIndexRebuildCompleteKey("launch")) {
      this.crash = false;
      throw new Error("simulated crash before complete marker");
    }
    return super.compareAndSwap(key, expectedEtag, value);
  }
}

class GuardedPhotoListStore extends InMemoryObjectStore {
  rejectPhotoLists = false;

  override async list(options: ListOptions = {}): Promise<ListResult> {
    if (this.rejectPhotoLists && options.prefix === "launch/") {
      throw new Error("incremental feed must not list PHOTOS");
    }
    return super.list(options);
  }
}

class WaterlinePhotoStore extends InMemoryObjectStore {
  private hook: (() => Promise<void>) | null = null;

  setFirstPhotoListHook(hook: () => Promise<void>): void {
    this.hook = hook;
  }

  override async list(options: ListOptions = {}): Promise<ListResult> {
    if (options.prefix === "launch/" && this.hook) {
      const hook = this.hook;
      this.hook = null;
      await hook();
    }
    return super.list(options);
  }
}

class PagedExportPhotoStore extends InMemoryObjectStore {
  photoLists = 0;

  override async list(options: ListOptions = {}): Promise<ListResult> {
    if (options.prefix === "launch/") {
      this.photoLists += 1;
      return super.list({ ...options, limit: 1 });
    }
    return super.list(options);
  }
}

class FailingReceiptReadStore extends InMemoryObjectStore {
  override async get(key: string): Promise<StoredObjectBody | null> {
    if (key.includes("/photo-metadata/")) throw new Error("private STATE unavailable");
    return super.get(key);
  }
}

class MissingDuplicatePhotoMetadataStore extends InMemoryObjectStore {
  hideExistingPhoto = false;

  override async get(key: string): Promise<StoredObjectBody | null> {
    if (this.hideExistingPhoto && key.startsWith("launch/")) return null;
    return super.get(key);
  }
}

class ExactPhotoReadStore extends InMemoryObjectStore {
  readonly reads: string[] = [];

  override async get(key: string): Promise<StoredObjectBody | null> {
    this.reads.push(key);
    return super.get(key);
  }

  resetReads(): void {
    this.reads.length = 0;
  }
}

class InstrumentedStateStore extends InMemoryObjectStore {
  reads = 0;

  override async get(key: string): Promise<StoredObjectBody | null> {
    this.reads += 1;
    return super.get(key);
  }

  resetReads(): void {
    this.reads = 0;
  }
}

class BoothStateAccessStore extends InMemoryObjectStore {
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly lists: ListOptions[] = [];

  override async get(key: string): Promise<StoredObjectBody | null> {
    this.reads.push(key);
    return super.get(key);
  }

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<void> {
    this.writes.push(key);
    return super.put(key, value);
  }

  override async list(options: ListOptions = {}): Promise<ListResult> {
    this.lists.push({ ...options });
    return super.list(options);
  }
}

class LongBoothCursorStore extends InMemoryObjectStore {
  readonly opaqueCursor: string;

  constructor(
    private readonly boothPrefix: string,
    private readonly firstKey: string,
    opaqueCursor = `r2:${"x".repeat(3_000)}`
  ) {
    super();
    this.opaqueCursor = opaqueCursor;
  }

  override async list(options: ListOptions = {}): Promise<ListResult> {
    if (options.prefix !== this.boothPrefix) return super.list(options);
    if (options.cursor === undefined) {
      const page = await super.list({ ...options, limit: 1 });
      return { objects: page.objects, truncated: true, cursor: this.opaqueCursor };
    }
    if (options.cursor !== this.opaqueCursor) throw new Error("opaque cursor changed");
    return super.list({
      prefix: options.prefix,
      startAfter: this.firstKey,
      limit: options.limit,
    });
  }
}

class CrashAfterSuccessfulCasStore extends InMemoryObjectStore {
  private crashed = false;

  constructor(private readonly crashPrefix: string) {
    super();
  }

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    const written = await super.compareAndSwap(key, expectedEtag, value);
    if (written && !this.crashed && key.startsWith(this.crashPrefix)) {
      this.crashed = true;
      throw new Error(`simulated crash after durable CAS for ${key}`);
    }
    return written;
  }
}

function decodePhotoFeedCursor(cursor: string): Record<string, unknown> {
  const encoded = cursor.slice("pf1.".length).replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

class FailNextConfigHeadCasStore extends InMemoryObjectStore {
  private failNextConfigHeadCas = true;

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (this.failNextConfigHeadCas && key === eventConfigKey("launch")) {
      this.failNextConfigHeadCas = false;
      return false;
    }
    return super.compareAndSwap(key, expectedEtag, value);
  }
}

class FailArmedRevisionAppendStore extends InMemoryObjectStore {
  private revisionKeyToFail: string | null = null;

  failNextRevisionAppend(key: string): void {
    this.revisionKeyToFail = key;
  }

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (key === this.revisionKeyToFail) {
      this.revisionKeyToFail = null;
      throw new Error("simulated revision append failure");
    }
    return super.compareAndSwap(key, expectedEtag, value);
  }
}

class GateFirstConfigHeadWriteStore extends InMemoryObjectStore {
  private gateOpen = false;
  private gated = false;
  private readonly blocked: Promise<void>;
  private markBlocked!: () => void;
  private readonly released: Promise<void>;
  private releaseGate!: () => void;

  constructor() {
    super();
    this.blocked = new Promise((resolve) => {
      this.markBlocked = resolve;
    });
    this.released = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  waitUntilBlocked(): Promise<void> {
    return this.blocked;
  }

  release(): void {
    this.gateOpen = true;
    this.releaseGate();
  }

  override async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<void> {
    await this.gateConfigHeadWrite(key);
    return super.put(key, value);
  }

  override async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    await this.gateConfigHeadWrite(key);
    return super.compareAndSwap(key, expectedEtag, value);
  }

  private async gateConfigHeadWrite(key: string): Promise<void> {
    if (this.gated || key !== eventConfigKey("launch")) return;
    this.gated = true;
    this.markBlocked();
    if (!this.gateOpen) await this.released;
  }
}

function stateWithUnfinishedMutation(mutationId: string): InMemoryObjectStore {
  return new InMemoryObjectStore({
    [eventConfigMutationKey("launch", mutationId)]: JSON.stringify({
      version: 1,
      config: { frames: ["one"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: null,
      reason: "save",
    }),
  });
}

async function saveSameContentHistory(
  store: EventStore,
  firstMutationId: string,
  secondMutationId: string
) {
  const first = await store.saveConfigRevision("launch", {
    config: { frames: ["same"] },
    baseRevisionId: null,
    mutationId: firstMutationId,
  });
  const second = await store.saveConfigRevision("launch", {
    config: { frames: ["same"] },
    baseRevisionId: first.revision.id,
    mutationId: secondMutationId,
  });
  return { first, second };
}

function boothHeartbeat(
  deviceId: string,
  changes: Partial<BoothHeartbeatInput> = {}
): BoothHeartbeatInput {
  return {
    version: 1,
    deviceId,
    sessionStartedAt: 1753315200000,
    pendingCount: 0,
    durableStorage: true,
    online: true,
    installed: true,
    camera: "ready",
    upload: "idle",
    buildId: "release_1",
    ...changes,
  };
}

describe("ObjectStore", () => {
  test("compareAndSwap rejects a stale etag", async () => {
    const state = new InMemoryObjectStore();
    expect(await state.compareAndSwap("head", null, "one")).toBe(true);
    const first = await state.get("head");
    expect(await state.compareAndSwap("head", "stale", "two")).toBe(false);
    expect(await state.compareAndSwap("head", first!.etag, "two")).toBe(true);
    expect(await first!.text()).toBe("one");
    expect(await (await state.get("head"))!.text()).toBe("two");
  });
});

describe("canonical event identity", () => {
  test("accepts canonical slugs and keeps the default event", () => {
    expect(canonicalEvent("launch-2026")).toBe("launch-2026");
    expect(canonicalEvent(null)).toBe("event");
  });

  test("rejects aliases instead of silently targeting another event", () => {
    expect(() => canonicalEvent("Launch 2026")).toThrow("canonical lowercase slug");
    expect(() => canonicalEvent("launch--2026")).toThrow();
    expect(() => canonicalEvent("_config")).toThrow();
  });
});

describe("EventStore", () => {
  test("migrates legacy public config into versioned private state", async () => {
    const photos = new InMemoryObjectStore({
      [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["one"], boothKeyHash: "hash" }),
    });
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");

    expect(await store.readConfig("launch")).toEqual({ frames: ["one"], boothKeyHash: "hash" });
    expect(state.has(eventConfigKey("launch"))).toBe(true);
    // The public legacy record remains during the rollback window. Cleanup is
    // an explicit, exact-key operator action after the new release is proven.
    expect(photos.has(legacyEventConfigKey("launch"))).toBe(true);
    const migrated = await state.get(eventConfigKey("launch"));
    expect(await migrated?.json<{ version: number; frames: string[]; boothKeyHash: string }>()).toEqual({
      version: 1,
      frames: ["one"],
      boothKeyHash: "hash",
    });
  });

  test("prefers private config over a stale legacy copy", async () => {
    const photos = new InMemoryObjectStore({ [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["old"] }) });
    const state = new InMemoryObjectStore({ [eventConfigKey("launch")]: JSON.stringify({ version: 1, frames: ["new"] }) });
    const store = new EventStore(photos, state, "https://photos.example/");
    expect(await store.readConfig("launch")).toEqual({ frames: ["new"] });
  });

  test("does not overwrite an unsupported future config with stale legacy state", async () => {
    const photos = new InMemoryObjectStore({ [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["old"] }) });
    const state = new InMemoryObjectStore({ [eventConfigKey("launch")]: JSON.stringify({ version: 2, frames: ["future"] }) });
    const store = new EventStore(photos, state, "https://photos.example");
    await expect(store.readConfig("launch")).rejects.toThrow("unsupported version");
    expect(await (await state.get(eventConfigKey("launch")))?.json<{ version: number; frames: string[] }>()).toEqual({
      version: 2,
      frames: ["future"],
    });
  });

  test("lazy legacy migration cannot overwrite a concurrent revision save", async () => {
    const photos = new InMemoryObjectStore({
      [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["legacy"] }),
    });
    const state = new GateFirstConfigHeadWriteStore();
    const store = new EventStore(photos, state, "https://photos.example");

    const migrating = store.readConfig("launch");
    await state.waitUntilBlocked();
    const saved = await store.saveConfigRevision("launch", {
      config: { frames: ["saved"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000020",
    });
    state.release();

    expect(await migrating).toEqual(saved.config);
    expect(await store.readConfig("launch")).toEqual(saved.config);
    expect((await store.readConfig("launch"))?.currentRevisionId).toBe(saved.revision.id);
  });

  test("first revision save appends baseline and preserves booth key", async () => {
    const state = new InMemoryObjectStore({
      [eventConfigKey("launch")]: JSON.stringify({ version: 1, frames: ["old"], boothKeyHash: "hash" }),
    });
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));
    const result = await store.saveConfigRevision("launch", {
      config: { frames: ["new"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000002",
    });
    expect(result.config.boothKeyHash).toBe("hash");
    expect(result.revision.parentRevisionId).not.toBeNull();
    expect(result.idempotent).toBe(false);
    expect((await store.readConfig("launch"))?.currentRevisionId).toBe(result.revision.id);
    const baseline = await state.get(eventConfigRevisionKey("launch", result.revision.parentRevisionId!));
    expect(await baseline?.json()).toMatchObject({
      reason: "baseline",
      config: { frames: ["old"] },
    });
    expect(await baseline!.text()).not.toContain("boothKeyHash");
  });

  test("stale save conflicts and an identical mutation retry is idempotent", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const input = {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000003",
    };
    expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(false);
    expect(await (await store.state.get(eventConfigMutationKey("launch", input.mutationId)))?.json<{
      version: number;
      config: { frames: string[] };
      baseRevisionId: string | null;
      boothKeyMutationFingerprint: null;
      reason: "save";
    }>()).toEqual({
      version: 1,
      config: { frames: ["one"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: null,
      reason: "save",
    });
    expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(true);
    await expect(store.saveConfigRevision("launch", {
      ...input,
      mutationId: "018f0000-0000-7000-8000-000000000004",
    })).rejects.toBeInstanceOf(ConfigConflictError);
  });

  test("only one concurrent save advances the head", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const results = await Promise.allSettled([
      store.saveConfigRevision("launch", {
        config: { frames: ["one"] },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000005",
      }),
      store.saveConfigRevision("launch", {
        config: { frames: ["two"] },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000006",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(ConfigConflictError) });
    const winner = fulfilled[0];
    if (!winner || winner.status !== "fulfilled") throw new Error("expected a winning save");
    expect((await store.readConfig("launch"))?.currentRevisionId).toBe(winner.value.revision.id);
  });

  test("an orphaned concurrent revision stays outside the later head chain", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const mutationIds = [
      "018f0000-0000-7000-8000-000000000007",
      "018f0000-0000-7000-8000-000000000008",
    ] as const;
    const results = await Promise.allSettled(mutationIds.map((mutationId, index) =>
      store.saveConfigRevision("launch", {
        config: { frames: [`concurrent-${index}`] },
        baseRevisionId: null,
        mutationId,
      })
    ));
    const winner = results.find((result) => result.status === "fulfilled");
    expect(winner?.status).toBe("fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("expected a winning save");
    const orphanId = mutationIds.find((id) => id !== winner.value.revision.id)!;
    expect(state.has(eventConfigRevisionKey("launch", orphanId))).toBe(true);

    const later = await store.saveConfigRevision("launch", {
      config: { frames: ["later"] },
      baseRevisionId: winner.value.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000009",
    });
    expect(later.revision.parentRevisionId).toBe(winner.value.revision.id);
    expect(later.revision.parentRevisionId).not.toBe(orphanId);
  });

  test("reusing a mutation ID with different config conflicts", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const mutationId = "018f0000-0000-7000-8000-00000000000a";
    await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId,
    });
    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: null,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
  });

  test("stores a credential-free mutation intent and rejects fingerprint reuse", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const mutationId = "018f0000-0000-7000-8000-000000000021";
    const fingerprint = "a".repeat(64);
    const input = {
      config: { frames: ["one"], boothKeyHash: "replacement-hash" },
      baseRevisionId: null,
      mutationId,
      boothKeyMutationFingerprint: fingerprint,
    };

    expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(false);
    expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(true);
    const intent = await state.get(eventConfigMutationKey("launch", mutationId));
    expect(await intent?.json<{
      version: number;
      config: { frames: string[] };
      baseRevisionId: string | null;
      boothKeyMutationFingerprint: string;
      reason: "save";
    }>()).toEqual({
      version: 1,
      config: { frames: ["one"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: fingerprint,
      reason: "save",
    });
    expect(await intent!.text()).not.toContain("replacement-hash");
    expect(await intent!.text()).not.toContain("boothKeyHash");

    await expect(store.saveConfigRevision("launch", {
      ...input,
      boothKeyMutationFingerprint: "b".repeat(64),
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
    await expect(store.saveConfigRevision("launch", {
      config: { frames: input.config.frames },
      baseRevisionId: input.baseRevisionId,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
  });

  test("only one concurrent credential mutation intent wins", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const mutationId = "018f0000-0000-7000-8000-000000000022";
    const results = await Promise.allSettled([
      store.saveConfigRevision("launch", {
        config: { frames: ["one"], boothKeyHash: "hash-one" },
        baseRevisionId: null,
        mutationId,
        boothKeyMutationFingerprint: "a".repeat(64),
      }),
      store.saveConfigRevision("launch", {
        config: { frames: ["one"], boothKeyHash: "hash-two" },
        baseRevisionId: null,
        mutationId,
        boothKeyMutationFingerprint: "b".repeat(64),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(ConfigMutationConflictError) });
  });

  test("an unfinished mutation intent rejects a changed experience without writing a revision", async () => {
    const mutationId = "018f0000-0000-7000-8000-000000000027";
    const state = stateWithUnfinishedMutation(mutationId);
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: null,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(false);
    expect(state.has(eventConfigKey("launch"))).toBe(false);
  });

  test("an unfinished mutation intent rejects a changed base without writing a revision", async () => {
    const mutationId = "018f0000-0000-7000-8000-000000000028";
    const state = stateWithUnfinishedMutation(mutationId);
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: "018f0000-0000-7000-8000-000000000099",
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(false);
    expect(state.has(eventConfigKey("launch"))).toBe(false);
  });

  test("an unfinished identical mutation intent proceeds to the revision and head", async () => {
    const mutationId = "018f0000-0000-7000-8000-000000000029";
    const state = stateWithUnfinishedMutation(mutationId);
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    const recovered = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId,
    });
    expect(recovered).toMatchObject({
      config: { frames: ["one"], currentRevisionId: mutationId },
      revision: { id: mutationId, parentRevisionId: null },
      idempotent: false,
    });
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(true);
  });

  test("invalid mutation IDs and credential fingerprints write nothing", async () => {
    const invalidInputs = [
      {
        config: { frames: ["one"] },
        baseRevisionId: null,
        mutationId: "not-a-revision-id",
      },
      {
        config: { frames: ["one"], boothKeyHash: "hash" },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000023",
      },
      {
        config: { frames: ["one"] },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000024",
        boothKeyMutationFingerprint: "a".repeat(64),
      },
      {
        config: { frames: ["one"], boothKeyHash: "hash" },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000025",
        boothKeyMutationFingerprint: "A".repeat(64),
      },
      {
        config: { frames: ["one"], boothKeyHash: "hash" },
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000026",
        boothKeyMutationFingerprint: "a".repeat(63),
      },
      {
        config: { frames: ["one"] },
        baseRevisionId: "not-a-revision-id",
        mutationId: "018f0000-0000-7000-8000-00000000002a",
      },
    ];

    for (const input of invalidInputs) {
      const state = new InMemoryObjectStore();
      const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
      await expect(store.saveConfigRevision("launch", input)).rejects.toBeInstanceOf(TypeError);
      expect((await state.list()).objects).toHaveLength(0);
    }
  });

  test("an invalid base does not poison a corrected retry of the same mutation", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const mutationId = "018f0000-0000-7000-8000-00000000002b";

    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: "not-a-revision-id",
      mutationId,
    })).rejects.toBeInstanceOf(TypeError);
    expect((await state.list()).objects).toHaveLength(0);

    const saved = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId,
    });
    expect(saved.revision.id).toBe(mutationId);
    expect(saved.config.currentRevisionId).toBe(mutationId);
  });

  test("reusing a mutation ID with a different base revision conflicts", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const first = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-00000000000b",
    });
    const mutationId = "018f0000-0000-7000-8000-00000000000c";
    await store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: first.revision.id,
      mutationId,
    });

    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: null,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
  });

  test("a mutation key containing a revision with another ID conflicts", async () => {
    const state = new InMemoryObjectStore();
    const mutationId = "018f0000-0000-7000-8000-00000000000e";
    state.set(eventConfigRevisionKey("launch", mutationId), JSON.stringify({
      version: 1,
      id: "018f0000-0000-7000-8000-00000000000f",
      createdAt: "2026-07-24T00:00:00Z",
      parentRevisionId: null,
      reason: "save",
      config: { frames: ["one"] },
    }));
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
  });

  test("an identical retry finishes a legacy save after the revision append succeeds", async () => {
    const state = new FailNextConfigHeadCasStore({
      [eventConfigKey("launch")]: JSON.stringify({
        version: 1,
        frames: ["old"],
        boothKeyHash: "hash",
      }),
    });
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const input = {
      config: { frames: ["new"], boothKeyHash: "new-hash" },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-00000000000d",
      boothKeyMutationFingerprint: "c".repeat(64),
    };

    await expect(store.saveConfigRevision("launch", input)).rejects.toBeInstanceOf(ConfigConflictError);
    expect(state.has(eventConfigRevisionKey("launch", input.mutationId))).toBe(true);
    expect((await store.readConfig("launch"))?.currentRevisionId).toBeUndefined();

    const recovered = await store.saveConfigRevision("launch", input);
    expect(recovered.idempotent).toBe(true);
    expect(recovered.config).toMatchObject({
      frames: ["new"],
      boothKeyHash: "new-hash",
      currentRevisionId: input.mutationId,
    });
    expect(recovered.revision.parentRevisionId).not.toBeNull();
    expect(await (await state.get(eventConfigMutationKey("launch", input.mutationId)))?.json<{
      version: number;
      config: { frames: string[] };
      baseRevisionId: string | null;
      boothKeyMutationFingerprint: string;
      reason: "save";
    }>()).toEqual({
      version: 1,
      config: { frames: ["new"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: input.boothKeyMutationFingerprint,
      reason: "save",
    });
  });

  test("history follows only the reachable head chain and restore appends", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const first = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000010",
    });
    const second = await store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: first.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000011",
    });
    state.set(eventConfigRevisionKey("launch", "018f0000-0000-7000-8000-000000000099"), JSON.stringify({
      version: 1,
      id: "018f0000-0000-7000-8000-000000000099",
      createdAt: "2026-07-24T00:00:00Z",
      parentRevisionId: null,
      reason: "save",
      config: { frames: ["orphan"] },
    }));

    expect((await store.readConfigHistory("launch")).revisions.map((revision) => revision.id)).toEqual([
      second.revision.id,
      first.revision.id,
    ]);
    const restored = await store.restoreConfigRevision("launch", {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000012",
    });
    expect(restored.config.frames).toEqual(["one"]);
    expect(restored.revision).toMatchObject({
      reason: "restore",
      sourceRevisionId: first.revision.id,
      parentRevisionId: second.revision.id,
    });
    expect((await store.readConfigHistory("launch")).revisions.map((revision) => revision.id)).toEqual([
      restored.revision.id,
      second.revision.id,
      first.revision.id,
    ]);
  });

  test("restore rejects missing and unreachable source revisions", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const current = await store.saveConfigRevision("launch", {
      config: { frames: ["current"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000030",
    });
    const orphanId = "018f0000-0000-7000-8000-000000000031";
    state.set(eventConfigRevisionKey("launch", orphanId), JSON.stringify({
      version: 1,
      id: orphanId,
      createdAt: "2026-07-24T00:00:00Z",
      parentRevisionId: null,
      reason: "save",
      config: { frames: ["orphan"] },
    }));
    const attempts = [
      {
        revisionId: "018f0000-0000-7000-8000-000000000098",
        mutationId: "018f0000-0000-7000-8000-000000000032",
      },
      {
        revisionId: orphanId,
        mutationId: "018f0000-0000-7000-8000-000000000046",
      },
    ];

    for (const attempt of attempts) {
      await expect(store.restoreConfigRevision("launch", {
        ...attempt,
        baseRevisionId: current.revision.id,
      })).rejects.toBeInstanceOf(ConfigRevisionNotFoundError);
      expect(state.has(eventConfigMutationKey("launch", attempt.mutationId))).toBe(false);
      expect(state.has(eventConfigRevisionKey("launch", attempt.mutationId))).toBe(false);
    }
  });

  test("history rejects corrupt and unsupported reachable revisions", async () => {
    const corruptId = "018f0000-0000-7000-8000-000000000033";
    const futureId = "018f0000-0000-7000-8000-000000000034";
    const invalidValues = [
      [corruptId, "{not-json"],
      [futureId, JSON.stringify({
        version: 2,
        id: futureId,
        createdAt: "2026-07-24T00:00:00Z",
        parentRevisionId: null,
        reason: "save",
        config: { frames: ["future"] },
      })],
    ] as const;

    for (const [revisionId, value] of invalidValues) {
      const state = new InMemoryObjectStore({
        [eventConfigKey("launch")]: JSON.stringify({
          version: 1,
          frames: ["current"],
          currentRevisionId: revisionId,
        }),
        [eventConfigRevisionKey("launch", revisionId)]: value,
      });
      const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
      await expect(store.readConfigHistory("launch")).rejects.toBeInstanceOf(InvalidStoredConfigRevisionError);
    }
  });

  test("history rejects a missing reachable parent", async () => {
    const headId = "018f0000-0000-7000-8000-000000000035";
    const missingParentId = "018f0000-0000-7000-8000-000000000036";
    const state = new InMemoryObjectStore({
      [eventConfigKey("launch")]: JSON.stringify({
        version: 1,
        frames: ["head"],
        currentRevisionId: headId,
      }),
      [eventConfigRevisionKey("launch", headId)]: JSON.stringify({
        version: 1,
        id: headId,
        createdAt: "2026-07-24T00:00:00Z",
        parentRevisionId: missingParentId,
        reason: "save",
        config: { frames: ["head"] },
      }),
    });
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    await expect(store.readConfigHistory("launch")).rejects.toBeInstanceOf(InvalidStoredConfigRevisionError);
  });

  test("history rejects a cycle in the reachable chain", async () => {
    const firstId = "018f0000-0000-7000-8000-000000000037";
    const secondId = "018f0000-0000-7000-8000-000000000038";
    const state = new InMemoryObjectStore({
      [eventConfigKey("launch")]: JSON.stringify({
        version: 1,
        frames: ["first"],
        currentRevisionId: firstId,
      }),
      [eventConfigRevisionKey("launch", firstId)]: JSON.stringify({
        version: 1,
        id: firstId,
        createdAt: "2026-07-24T00:00:00Z",
        parentRevisionId: secondId,
        reason: "save",
        config: { frames: ["first"] },
      }),
      [eventConfigRevisionKey("launch", secondId)]: JSON.stringify({
        version: 1,
        id: secondId,
        createdAt: "2026-07-23T00:00:00Z",
        parentRevisionId: firstId,
        reason: "save",
        config: { frames: ["second"] },
      }),
    });
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");

    await expect(store.readConfigHistory("launch")).rejects.toBeInstanceOf(InvalidStoredConfigRevisionError);
  });

  test("stale restore conflicts without appending a revision", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const first = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-000000000039",
    });
    const second = await store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: first.revision.id,
      mutationId: "018f0000-0000-7000-8000-00000000003a",
    });
    const mutationId = "018f0000-0000-7000-8000-00000000003b";

    await expect(store.restoreConfigRevision("launch", {
      revisionId: first.revision.id,
      baseRevisionId: first.revision.id,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await store.readConfig("launch"))?.currentRevisionId).toBe(second.revision.id);
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(false);
  });

  test("an identical restore retry is idempotent", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const first = await store.saveConfigRevision("launch", {
      config: { frames: ["one"] },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-00000000003c",
    });
    const second = await store.saveConfigRevision("launch", {
      config: { frames: ["two"] },
      baseRevisionId: first.revision.id,
      mutationId: "018f0000-0000-7000-8000-00000000003d",
    });
    const input = {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId: "018f0000-0000-7000-8000-00000000003e",
    };

    expect((await store.restoreConfigRevision("launch", input)).idempotent).toBe(false);
    const retried = await store.restoreConfigRevision("launch", input);
    expect(retried.idempotent).toBe(true);
    expect(retried.revision).toMatchObject({
      id: input.mutationId,
      reason: "restore",
      sourceRevisionId: first.revision.id,
    });
  });

  test("an unfinished restore intent rejects a different same-content source", async () => {
    const state = new FailArmedRevisionAppendStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const { first, second } = await saveSameContentHistory(
      store,
      "018f0000-0000-7000-8000-00000000004a",
      "018f0000-0000-7000-8000-00000000004b"
    );
    const mutationId = "018f0000-0000-7000-8000-00000000004c";
    state.failNextRevisionAppend(eventConfigRevisionKey("launch", mutationId));

    await expect(store.restoreConfigRevision("launch", {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId,
    })).rejects.toThrow("simulated revision append failure");
    await expect(store.restoreConfigRevision("launch", {
      revisionId: second.revision.id,
      baseRevisionId: second.revision.id,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(false);
  });

  test("an unfinished restore mutation cannot be reused as an equivalent save", async () => {
    const state = new FailArmedRevisionAppendStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const { first, second } = await saveSameContentHistory(
      store,
      "018f0000-0000-7000-8000-00000000004d",
      "018f0000-0000-7000-8000-00000000004e"
    );
    const mutationId = "018f0000-0000-7000-8000-00000000004f";
    state.failNextRevisionAppend(eventConfigRevisionKey("launch", mutationId));

    await expect(store.restoreConfigRevision("launch", {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId,
    })).rejects.toThrow("simulated revision append failure");
    await expect(store.saveConfigRevision("launch", {
      config: { frames: ["same"] },
      baseRevisionId: second.revision.id,
      mutationId,
    })).rejects.toBeInstanceOf(ConfigMutationConflictError);
    expect(state.has(eventConfigRevisionKey("launch", mutationId))).toBe(false);
  });

  test("an identical unfinished restore intent recovers idempotently", async () => {
    const state = new FailArmedRevisionAppendStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const { first, second } = await saveSameContentHistory(
      store,
      "018f0000-0000-7000-8000-000000000050",
      "018f0000-0000-7000-8000-000000000051"
    );
    const input = {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000052",
    };
    state.failNextRevisionAppend(eventConfigRevisionKey("launch", input.mutationId));

    await expect(store.restoreConfigRevision("launch", input)).rejects.toThrow("simulated revision append failure");
    expect(await (await state.get(eventConfigMutationKey("launch", input.mutationId)))?.json<{
      version: number;
      config: { frames: string[] };
      baseRevisionId: string;
      boothKeyMutationFingerprint: null;
      reason: "restore";
      sourceRevisionId: string;
    }>()).toEqual({
      version: 1,
      config: { frames: ["same"] },
      baseRevisionId: second.revision.id,
      boothKeyMutationFingerprint: null,
      reason: "restore",
      sourceRevisionId: first.revision.id,
    });

    expect((await store.restoreConfigRevision("launch", input)).idempotent).toBe(false);
    expect((await store.restoreConfigRevision("launch", input)).idempotent).toBe(true);
  });

  test("an identical retry finishes a restore after the revision append succeeds", async () => {
    const firstId = "018f0000-0000-7000-8000-000000000047";
    const secondId = "018f0000-0000-7000-8000-000000000048";
    const state = new FailNextConfigHeadCasStore({
      [eventConfigKey("launch")]: JSON.stringify({
        version: 1,
        frames: ["two"],
        boothKeyHash: "current-hash",
        currentRevisionId: secondId,
      }),
      [eventConfigRevisionKey("launch", firstId)]: JSON.stringify({
        version: 1,
        id: firstId,
        createdAt: "2026-07-23T00:00:00Z",
        parentRevisionId: null,
        reason: "save",
        config: { frames: ["one"] },
      }),
      [eventConfigRevisionKey("launch", secondId)]: JSON.stringify({
        version: 1,
        id: secondId,
        createdAt: "2026-07-24T00:00:00Z",
        parentRevisionId: firstId,
        reason: "save",
        config: { frames: ["two"] },
      }),
    });
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const input = {
      revisionId: firstId,
      baseRevisionId: secondId,
      mutationId: "018f0000-0000-7000-8000-000000000049",
    };

    await expect(store.restoreConfigRevision("launch", input)).rejects.toBeInstanceOf(ConfigConflictError);
    expect(state.has(eventConfigRevisionKey("launch", input.mutationId))).toBe(true);
    expect((await store.readConfigHistory("launch")).revisions.map((revision) => revision.id)).toEqual([
      secondId,
      firstId,
    ]);

    const recovered = await store.restoreConfigRevision("launch", input);
    expect(recovered).toMatchObject({
      config: {
        frames: ["one"],
        boothKeyHash: "current-hash",
        currentRevisionId: input.mutationId,
      },
      revision: {
        id: input.mutationId,
        parentRevisionId: secondId,
        reason: "restore",
        sourceRevisionId: firstId,
      },
      idempotent: true,
    });
  });

  test("restore preserves the current Booth Key without writing it to immutable records", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const first = await store.saveConfigRevision("launch", {
      config: { frames: ["one"], boothKeyHash: "old-hash" },
      baseRevisionId: null,
      mutationId: "018f0000-0000-7000-8000-00000000003f",
      boothKeyMutationFingerprint: "d".repeat(64),
    });
    const second = await store.saveConfigRevision("launch", {
      config: { frames: ["two"], boothKeyHash: "current-hash" },
      baseRevisionId: first.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000040",
      boothKeyMutationFingerprint: "e".repeat(64),
    });

    const restored = await store.restoreConfigRevision("launch", {
      revisionId: first.revision.id,
      baseRevisionId: second.revision.id,
      mutationId: "018f0000-0000-7000-8000-000000000041",
    });
    expect(restored.config.boothKeyHash).toBe("current-hash");
    expect(await (await state.get(eventConfigRevisionKey("launch", restored.revision.id)))?.text()).not.toContain("current-hash");
    expect(await (await state.get(eventConfigMutationKey("launch", restored.revision.id)))?.text()).not.toContain("current-hash");
  });

  test("invalid restore revision IDs write nothing", async () => {
    const invalidInputs = [
      {
        revisionId: "not-a-revision-id",
        baseRevisionId: null,
        mutationId: "018f0000-0000-7000-8000-000000000042",
      },
      {
        revisionId: "018f0000-0000-7000-8000-000000000043",
        baseRevisionId: "not-a-revision-id",
        mutationId: "018f0000-0000-7000-8000-000000000044",
      },
      {
        revisionId: "018f0000-0000-7000-8000-000000000045",
        baseRevisionId: null,
        mutationId: "not-a-revision-id",
      },
    ];

    for (const input of invalidInputs) {
      const state = new InMemoryObjectStore();
      const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
      await expect(store.restoreConfigRevision("launch", input)).rejects.toBeInstanceOf(TypeError);
      expect((await state.list()).objects).toHaveLength(0);
    }
  });

  test("stable ingest creates one immutable photo across retries", async () => {
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));
    const upload = {
      captureId: "018f0000-0000-4000-8000-000000000001",
      capturedAt: 1753315200000,
      source: "framed" as const,
      frameKey: "square",
    };

    const first = await store.putPhoto("launch", new TextEncoder().encode("first").buffer, { upload });
    const retry = await store.putPhoto("launch", new TextEncoder().encode("replacement").buffer, { upload });

    expect(first).toMatchObject({
      key: "launch/1753315200000-018f0000-0000-4000-8000-000000000001.jpg",
      duplicate: false,
      indexStored: true,
      receiptStored: true,
    });
    expect(retry).toMatchObject({ key: first.key, url: first.url, duplicate: true, indexStored: true, receiptStored: true });
    expect(await (await photos.get(first.key))!.text()).toBe("first");
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
    expect(state.has(photoIndexKey("launch", first.key, upload.capturedAt))).toBe(true);
    expect(state.has(photoReceiptKey("launch", first.key))).toBe(true);
  });

  test("concurrent stable attempts produce one public image", async () => {
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");
    const upload = {
      captureId: "018f0000-0000-4000-8000-000000000002",
      capturedAt: 1753315200001,
    };

    const results = await Promise.all([
      store.putPhoto("launch", new Uint8Array([1]).buffer, { upload }),
      store.putPhoto("launch", new Uint8Array([2]).buffer, { upload }),
    ]);

    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
    expect((await state.list({ prefix: "events/launch/photo-feed/v1/nodes/" })).objects).toHaveLength(1);
  });

  test("a stable retry repairs a missing index without another public photo", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-index/");
    const store = new EventStore(photos, state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000003", capturedAt: 1753315200002 };

    const first = store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    await expect(first).rejects.toBeInstanceOf(PhotoIndexWriteError);
    const key = "launch/1753315200002-018f0000-0000-4000-8000-000000000003.jpg";
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
    expect(state.has(photoIndexKey("launch", key, upload.capturedAt))).toBe(false);

    state.allowWrites();
    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).resolves.toMatchObject({
      key,
      duplicate: true,
      indexStored: true,
    });
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
  });

  test("a stable upload does not acknowledge until its private arrival record is durable", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-feed/");
    const store = new EventStore(photos, state, "https://photos.example");
    const before = await store.listPhotos("launch");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000110", capturedAt: 1753315200005 };

    await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);

    state.allowWrites();
    const repaired = await store.putPhoto("launch", new Uint8Array([2]).buffer, { upload });
    const delta = await store.listPhotos("launch", before.cursor);

    expect(repaired).toMatchObject({ duplicate: true, indexStored: true });
    expect(delta.photos.map((photo) => photo.key)).toEqual([repaired.key]);
  });

  test("a missing-marker retry stays bounded after 50 intervening arrivals", async () => {
    const state = new InstrumentedStateStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000111", capturedAt: 1753315200006 };

    const first = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    for (let index = 0; index < 50; index += 1) {
      await store.putPhoto("launch", new Uint8Array([index]).buffer, {
        upload: {
          captureId: `018f0000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
          capturedAt: 1753315200100 + index,
        },
      });
    }
    await state.delete(photoFeedMarkerKey("launch", first.key));
    state.resetReads();

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).resolves.toMatchObject({ duplicate: true });
    expect(state.reads).toBeLessThanOrEqual(15);
  });

  for (const crashPoint of ["claims/", "head.json", "committed/", "markers/"] as const) {
    test(`an identical retry finalizes a lost acknowledgement after ${crashPoint}`, async () => {
      const state = new CrashAfterSuccessfulCasStore(`events/launch/photo-feed/v1/${crashPoint}`);
      const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
      const before = await store.listPhotos("launch");
      const crashIndex = ["claims/", "head.json", "committed/", "markers/"].indexOf(crashPoint);
      const upload = {
        captureId: `018f0000-0000-4000-8000-${String(120 + crashIndex).padStart(12, "0")}`,
        capturedAt: 1753315200020 + crashIndex,
      };

      await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload }))
        .rejects.toBeInstanceOf(PhotoIndexWriteError);
      const retry = await store.putPhoto("launch", new Uint8Array([2]).buffer, { upload });
      const delta = await store.listPhotos("launch", before.cursor);

      expect(retry).toMatchObject({ duplicate: true, indexStored: true });
      expect(delta.photos.map((photo) => photo.key)).toEqual([retry.key]);
      expect(decodePhotoFeedCursor(delta.cursor!).sequence).toBe(1);
    });
  }

  test("replaces an exact stale claim after another arrival wins its sequence", async () => {
    const state = new CrashAfterSuccessfulCasStore("events/launch/photo-feed/v1/claims/");
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const before = await store.listPhotos("launch");
    const interruptedUpload = {
      captureId: "018f0000-0000-4000-8000-000000000130",
      capturedAt: 1753315200030,
    };

    await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload: interruptedUpload }))
      .rejects.toBeInstanceOf(PhotoIndexWriteError);
    const winner = await store.putPhoto("launch", new Uint8Array([2]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000131", capturedAt: 1753315200031 },
    });
    const recovered = await store.putPhoto("launch", new Uint8Array([3]).buffer, { upload: interruptedUpload });
    const delta = await store.listPhotos("launch", before.cursor);

    expect(delta.photos.map((photo) => photo.key)).toEqual([recovered.key, winner.key]);
    expect(decodePhotoFeedCursor(delta.cursor!).sequence).toBe(2);
  });

  test("a corrupt exact claim fails closed without advancing the Event head", async () => {
    const state = new CrashAfterSuccessfulCasStore("events/launch/photo-feed/v1/claims/");
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const upload = {
      captureId: "018f0000-0000-4000-8000-000000000132",
      capturedAt: 1753315200032,
    };

    await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload }))
      .rejects.toBeInstanceOf(PhotoIndexWriteError);
    const claimObject = (await state.list({
      prefix: "events/launch/photo-feed/v1/claims/",
    })).objects[0]!;
    const claim = await (await state.get(claimObject.key))!.json<Record<string, unknown>>();
    state.set(claimObject.key, JSON.stringify({
      ...claim,
      sequence: 2,
      previousNodeKey: null,
    }));

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload }))
      .rejects.toBeInstanceOf(PhotoIndexWriteError);
    expect(state.has(photoFeedHeadKey("launch"))).toBe(false);
  });

  test("receipt failure is observable but does not reject an acknowledged stable photo", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-metadata/");
    const store = new EventStore(photos, state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000004", capturedAt: 1753315200003 };

    await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload })).resolves.toMatchObject({
      duplicate: false,
      indexStored: true,
      receiptStored: false,
    });
  });

  test("legacy uploads keep random keys and acknowledge private derived-write failures", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-");
    const store = new EventStore(photos, state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));

    const first = await store.putPhoto("launch", new Uint8Array([1]).buffer);
    const retry = await store.putPhoto("launch", new Uint8Array([2]).buffer);

    expect(first).toMatchObject({ duplicate: false, indexStored: false, receiptStored: false });
    expect(retry).toMatchObject({ duplicate: false, indexStored: false, receiptStored: false });
    expect(first.key).not.toBe(retry.key);
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(2);
  });

  test("stable identities are event-isolated and private records contain no credentials", async () => {
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));
    const upload = {
      captureId: "018f0000-0000-4000-8000-000000000005",
      capturedAt: 1753315200004,
      source: "camera-fallback" as const,
      frameKey: "square",
      configRevisionId: "018f0000-0000-7000-8000-000000000006",
    };

    const launch = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    const other = await store.putPhoto("other", new Uint8Array([2]).buffer, { upload });
    expect(launch.key).not.toBe(other.key);
    expect((await photos.list()).objects).toHaveLength(2);

    const index = await (await state.get(photoIndexKey("launch", launch.key, upload.capturedAt)))!.json<Record<string, unknown>>();
    const receipt = await (await state.get(photoReceiptKey("launch", launch.key)))!.json<Record<string, unknown>>();
    const feedRecords = await Promise.all((await state.list({ prefix: "events/launch/photo-feed/" })).objects.map(async (object) =>
      (await state.get(object.key))!.json<Record<string, unknown>>()
    ));
    for (const record of [index, receipt, ...feedRecords]) {
      expect(record).not.toHaveProperty("boothKeyHash");
      expect(record).not.toHaveProperty("boothKey");
      expect(record).not.toHaveProperty("credential");
      expect(JSON.stringify(record)).not.toContain("hash");
    }
  });

  test("uses private server-arrival records so delayed and future-skewed captures both arrive after a cursor", async () => {
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");
    const future = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000101", capturedAt: 9999999999999 },
    });
    const initial = await store.listPhotos("launch");

    const delayed = await store.putPhoto("launch", new Uint8Array([2]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000102", capturedAt: 1000000000000 },
    });
    const delta = await store.listPhotos("launch", initial.cursor);

    expect(initial.photos.map((photo) => photo.key)).toEqual([future.key]);
    expect(delta.photos.map((photo) => photo.key)).toEqual([delayed.key]);
    expect(state.has(photoFeedHeadKey("launch"))).toBe(true);
  });

  test("records concurrent equal-time stable uploads once each in arrival order", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const before = await store.listPhotos("launch");
    const uploads = await Promise.all([
      store.putPhoto("launch", new Uint8Array([1]).buffer, {
        upload: { captureId: "018f0000-0000-4000-8000-000000000103", capturedAt: 1753315200000 },
      }),
      store.putPhoto("launch", new Uint8Array([2]).buffer, {
        upload: { captureId: "018f0000-0000-4000-8000-000000000104", capturedAt: 1753315200000 },
      }),
    ]);

    const delta = await store.listPhotos("launch", before.cursor);
    expect(delta.photos.map((photo) => photo.key)).toEqual(expect.arrayContaining(uploads.map((upload) => upload.key)));
    expect(new Set(delta.photos.map((photo) => photo.key)).size).toBe(2);
  });

  test("commits nine concurrent distinct arrivals without exhausting the append budget", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const before = await store.listPhotos("launch");

    const uploads = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      store.putPhoto("launch", new Uint8Array([index]).buffer, {
        upload: {
          captureId: `018f0000-0000-4000-8000-${String(140 + index).padStart(12, "0")}`,
          capturedAt: 1753315200040 + index,
        },
      })
    ));
    const delta = await store.listPhotos("launch", before.cursor);
    const committed = await state.list({
      prefix: "events/launch/photo-feed/v1/committed/",
    });

    expect(delta.photos).toHaveLength(9);
    expect(new Set(delta.photos.map((photo) => photo.key))).toEqual(
      new Set(uploads.map((photo) => photo.key))
    );
    expect(decodePhotoFeedCursor(delta.cursor!).sequence).toBe(9);
    expect(committed.objects).toHaveLength(9);
  });

  test("takes a feed-head waterline before the initial public scan", async () => {
    const photos = new WaterlinePhotoStore();
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    let duringSnapshot: Awaited<ReturnType<EventStore["putPhoto"]>> | null = null;
    photos.setFirstPhotoListHook(async () => {
      duringSnapshot = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
        upload: { captureId: "018f0000-0000-4000-8000-000000000105", capturedAt: 1000000000000 },
      });
    });

    const initial = await store.listPhotos("launch");
    const delta = await store.listPhotos("launch", initial.cursor);

    // A concurrent post-waterline photo may be in the public snapshot. The
    // next sequence delta deliberately repeats it so no arrival can be missed;
    // Gallery clients already deduplicate exact keys.
    expect(initial.photos.map((photo) => photo.key)).toEqual([duringSnapshot!.key]);
    expect(delta.photos.map((photo) => photo.key)).toEqual([duringSnapshot!.key]);
  });

  test("opaque cursors expose only an Event-bound bounded sequence", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000112", capturedAt: 1753315200007 },
    });

    const feed = await store.listPhotos("launch");
    const decoded = decodePhotoFeedCursor(feed.cursor!);

    expect(decoded).toEqual({ version: 1, event: "launch", sequence: 1 });
    expect(JSON.stringify(decoded)).not.toContain("events/");
    expect(decoded).not.toHaveProperty("nodeKey");
  });

  test("fails closed on a fabricated head in bounded work", async () => {
    const state = new InstrumentedStateStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const before = await store.listPhotos("launch");
    state.set(photoFeedHeadKey("launch"), JSON.stringify({
      version: 1,
      sequence: 1_000_000,
      nodeKey: "events/launch/photo-feed/v1/nodes/fabricated.json",
    }));
    state.resetReads();

    await expect(store.listPhotos("launch", before.cursor)).rejects.toThrow(
      "photo feed state for launch is corrupt"
    );
    expect(state.reads).toBeLessThanOrEqual(3);
  });

  test("pages more than one feed page without gaps or duplicate keys", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const before = await store.listPhotos("launch");
    const uploaded: string[] = [];
    for (let index = 1; index <= 1002; index += 1) {
      const photo = await store.putPhoto("launch", new Uint8Array([index % 255]).buffer, {
        upload: {
          captureId: `018f0000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          capturedAt: 1753315300000 + index,
        },
      });
      uploaded.push(photo.key);
    }

    const first = await store.listPhotos("launch", before.cursor);
    const second = await store.listPhotos("launch", first.cursor);
    const keys = [...first.photos, ...second.photos].map((photo) => photo.key);

    expect(first).toMatchObject({ truncated: true, unchanged: false });
    expect(first.photos).toHaveLength(1000);
    expect(decodePhotoFeedCursor(first.cursor!).sequence).toBe(1000);
    expect(second).toMatchObject({ truncated: false, unchanged: false });
    expect(second.photos).toHaveLength(2);
    expect(decodePhotoFeedCursor(second.cursor!).sequence).toBe(1002);
    expect(new Set(keys).size).toBe(1002);
    expect(keys).toEqual([...uploaded.slice(0, 1000).reverse(), ...uploaded.slice(1000).reverse()]);
  });

  test("a read repairs a stable head commit before it can advance the cursor", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-feed/v1/committed/");
    const store = new EventStore(photos, state, "https://photos.example");
    const before = await store.listPhotos("launch");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000113", capturedAt: 1753315200008 };

    await expect(store.putPhoto("launch", new Uint8Array([1]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
    await expect(store.listPhotos("launch", before.cursor)).rejects.toThrow(
      "simulated private write failure"
    );

    state.allowWrites();
    const delta = await store.listPhotos("launch", before.cursor);
    const repaired = await store.putPhoto("launch", new Uint8Array([2]).buffer, { upload });

    expect(delta.photos.map((photo) => photo.key)).toEqual([repaired.key]);
    expect(decodePhotoFeedCursor(delta.cursor!).sequence).toBe(1);
    expect(delta.truncated).toBe(false);
  });

  test("an existing Gallery read repairs a legacy head left ahead of its commit", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-feed/v1/committed/");
    const store = new EventStore(photos, state, "https://photos.example");
    const before = await store.listPhotos("launch");

    const legacy = await store.putPhoto("launch", new Uint8Array([1]).buffer);
    expect(legacy).toMatchObject({ duplicate: false, indexStored: true });
    expect(state.has(photoFeedHeadKey("launch"))).toBe(true);
    expect(state.has(photoFeedCommittedKey("launch", 1))).toBe(false);

    state.allowWrites();
    const delta = await store.listPhotos("launch", before.cursor);

    expect(delta.photos.map((photo) => photo.key)).toEqual([legacy.key]);
    expect(decodePhotoFeedCursor(delta.cursor!).sequence).toBe(1);
    expect(state.has(photoFeedCommittedKey("launch", 1))).toBe(true);
    expect(state.has(photoFeedMarkerKey("launch", legacy.key))).toBe(true);
  });

  test("a fresh Gallery read repairs a legacy head left ahead of its commit", async () => {
    const photos = new InMemoryObjectStore();
    const state = new FailPrivatePhotoWriteStore("events/launch/photo-feed/v1/committed/");
    const store = new EventStore(photos, state, "https://photos.example");

    const legacy = await store.putPhoto("launch", new Uint8Array([1]).buffer);
    expect(state.has(photoFeedCommittedKey("launch", 1))).toBe(false);

    state.allowWrites();
    const initial = await store.listPhotos("launch");

    expect(initial.photos.map((photo) => photo.key)).toEqual([legacy.key]);
    expect(decodePhotoFeedCursor(initial.cursor!).sequence).toBe(1);
    expect(state.has(photoFeedCommittedKey("launch", 1))).toBe(true);
    expect(state.has(photoFeedMarkerKey("launch", legacy.key))).toBe(true);
  });

  test("repairs a missing head commit before advancing a valid prior cursor", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const before = await store.listPhotos("launch");
    await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000117", capturedAt: 1753315200012 },
    });
    const throughFirst = await store.listPhotos("launch", before.cursor);
    const secondUpload = {
      captureId: "018f0000-0000-4000-8000-000000000118",
      capturedAt: 1753315200013,
    };
    const second = await store.putPhoto("launch", new Uint8Array([2]).buffer, { upload: secondUpload });
    await state.delete(photoFeedCommittedKey("launch", 2));

    const repaired = await store.listPhotos("launch", throughFirst.cursor);
    expect(repaired.photos.map((photo) => photo.key)).toEqual([second.key]);
    expect(decodePhotoFeedCursor(repaired.cursor!).sequence).toBe(2);
    expect(state.has(photoFeedCommittedKey("launch", 2))).toBe(true);
  });

  test("fails closed on a corrupt per-photo sequence marker", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000114", capturedAt: 1753315200009 };
    const photo = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    state.set(photoFeedMarkerKey("launch", photo.key), JSON.stringify({ version: 1, sequence: "1" }));

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
  });

  test("fails closed when a marker sequence is inconsistent with the Event head", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000115", capturedAt: 1753315200010 };
    const photo = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    state.set(photoFeedMarkerKey("launch", photo.key), JSON.stringify({ version: 1, sequence: 2 }));

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
  });

  test("fails closed when exact committed proof points at an orphan node", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000116", capturedAt: 1753315200011 };
    const photo = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    const entryKey = (await state.list({ prefix: "events/launch/photo-feed/v1/entries/" })).objects[0]!.key;
    const orphanNodeKey = "events/launch/photo-feed/v1/nodes/orphan.json";
    state.set(orphanNodeKey, JSON.stringify({
      version: 1,
      sequence: 1,
      entryKey,
      previousNodeKey: null,
    }));
    state.set(photoFeedCommittedKey("launch", 1), JSON.stringify({
      version: 1,
      sequence: 1,
      key: photo.key,
      entryKey,
      nodeKey: orphanNodeKey,
    }));

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
  });

  test("pages a delta through private feed records and exact public gets without relisting PHOTOS", async () => {
    const photos = new GuardedPhotoListStore();
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    const initial = await store.listPhotos("launch");
    const upload = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000106", capturedAt: 1000000000000 },
    });
    photos.rejectPhotoLists = true;

    const delta = await store.listPhotos("launch", initial.cursor);

    expect(delta.photos.map((photo) => photo.key)).toEqual([upload.key]);
  });

  test("skips deleted feed records while advancing an opaque Event-bound cursor", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const initial = await store.listPhotos("launch");
    const upload = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000107", capturedAt: 1000000000000 },
    });
    await store.deletePhoto("launch", upload.key);

    const skipped = await store.listPhotos("launch", initial.cursor);
    const unchanged = await store.listPhotos("launch", skipped.cursor);

    expect(skipped).toMatchObject({ photos: [], unchanged: true });
    expect(skipped.cursor).not.toBe(initial.cursor);
    expect(unchanged).toMatchObject({ photos: [], unchanged: true, cursor: skipped.cursor });
    await expect(store.listPhotos("other", skipped.cursor)).rejects.toBeInstanceOf(InvalidPhotoCursorError);
    await expect(store.listPhotos("launch", "not-an-opaque-cursor")).rejects.toBeInstanceOf(InvalidPhotoCursorError);
  });

  test("repairs a stable index and receipt with the original public upload time", async () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => now);
    const upload = { captureId: "018f0000-0000-4000-8000-000000000108", capturedAt: 1753315200000 };
    const first = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    const originalUploadedAt = (await photos.get(first.key))!.uploaded.toISOString();
    await state.delete(photoIndexKey("launch", first.key, upload.capturedAt));
    await state.delete(photoReceiptKey("launch", first.key));
    now = new Date("2026-07-24T00:05:00.000Z");

    const repaired = await store.putPhoto("launch", new Uint8Array([2]).buffer, { upload });
    const index = await (await state.get(photoIndexKey("launch", first.key, upload.capturedAt)))!.json<{ uploadedAt: string }>();
    const receipt = await (await state.get(photoReceiptKey("launch", first.key)))!.json<{ uploadedAt: string }>();

    expect(repaired).toMatchObject({ duplicate: true, indexStored: true, receiptStored: true });
    expect(index.uploadedAt).toBe(originalUploadedAt);
    expect(receipt.uploadedAt).toBe(originalUploadedAt);
  });

  test("does not repair a duplicate index with a retry timestamp when the public object is unavailable", async () => {
    const photos = new MissingDuplicatePhotoMetadataStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");
    const upload = { captureId: "018f0000-0000-4000-8000-000000000109", capturedAt: 1753315200000 };
    const first = await store.putPhoto("launch", new Uint8Array([1]).buffer, { upload });
    await state.delete(photoIndexKey("launch", first.key, upload.capturedAt));
    photos.hideExistingPhoto = true;

    await expect(store.putPhoto("launch", new Uint8Array([2]).buffer, { upload })).rejects.toBeInstanceOf(PhotoIndexWriteError);
    expect(state.has(photoIndexKey("launch", first.key, upload.capturedAt))).toBe(false);
  });

  test("iterates every export page", async () => {
    const photos = new InMemoryObjectStore();
    for (let i = 0; i < 1002; i += 1) photos.set(`launch/${String(i).padStart(13, "0")}-x.jpg`, "x");
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    const keys: string[] = [];
    for await (const object of store.iteratePhotoObjects("launch")) keys.push(object.key);
    expect(keys).toHaveLength(1002);
  });

  test("deletes only an exact photo key belonging to the event", async () => {
    const photos = new InMemoryObjectStore({
      "launch/0000000001000-a.jpg": "a",
      "other/0000000001000-b.jpg": "b",
      "launch/notes.txt": "keep",
    });
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    expect(await store.deletePhoto("launch", "other/0000000001000-b.jpg")).toBe(false);
    expect(await store.deletePhoto("launch", "launch/notes.txt")).toBe(false);
    expect(await store.deletePhoto("launch", "launch/0000000001000-a.jpg")).toBe(true);
    expect(photos.has("launch/0000000001000-a.jpg")).toBe(false);
    expect(photos.has("other/0000000001000-b.jpg")).toBe(true);
  });

  test("gets only an exact public image owned by the canonical Event", async () => {
    const uploaded = new Date("2026-07-24T12:00:00.000Z");
    const key = "launch/0000000001000-photo.jpg";
    const photos = new ExactPhotoReadStore();
    photos.set(key, "photo", uploaded);
    photos.set("other/0000000001000-photo.jpg", "other", uploaded);
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");

    await expect(store.getPublicPhoto("launch", key)).resolves.toEqual({
      key,
      url: "https://photos.example/launch/0000000001000-photo.jpg",
      uploadedAt: uploaded.toISOString(),
    });
    expect(photos.reads).toEqual([key]);

    photos.resetReads();
    await expect(store.getPublicPhoto("Launch", key)).rejects.toBeInstanceOf(InvalidEventSlugError);
    for (const malformed of [
      "launch/",
      "0000000001000-photo.jpg",
      "launch/../other/0000000001000-photo.jpg",
      "other/0000000001000-photo.jpg",
    ]) {
      await expect(store.getPublicPhoto("launch", malformed)).rejects.toBeInstanceOf(TypeError);
    }
    expect(photos.reads).toEqual([]);

    await expect(store.getPublicPhoto("launch", "launch/0000000001000-missing.jpg")).resolves.toBeNull();
    expect(photos.reads).toEqual(["launch/0000000001000-missing.jpg"]);
  });

  test("pages the private inverse-time index newest-first across bounded storage pages", async () => {
    const photos = new InMemoryObjectStore();
    const state = new CappedListStore(1);
    const store = new EventStore(photos, state, "https://photos.example");
    const records = [
      { key: "launch/0000000001000-a.jpg", capturedAt: 1_000 },
      { key: "launch/0000000002000-b.jpg", capturedAt: 2_000 },
      { key: "launch/0000000003000-c.jpg", capturedAt: 3_000 },
    ];
    for (const record of records) {
      photos.set(record.key, record.key, new Date(record.capturedAt));
      state.set(photoIndexKey("launch", record.key, record.capturedAt), JSON.stringify({
        version: 1,
        ...record,
        uploadedAt: new Date(record.capturedAt).toISOString(),
        source: "framed",
        frameKey: "celebration",
        configRevisionId: "private-revision",
      }));
    }

    const first = await store.listModerationPhotos("launch", { limit: 2 });
    expect(first.photos).toEqual([
      {
        key: records[2]!.key,
        url: `https://photos.example/${records[2]!.key}`,
        uploadedAt: new Date(3_000).toISOString(),
        capturedAt: 3_000,
        source: "framed",
        frameKey: "celebration",
      },
      {
        key: records[1]!.key,
        url: `https://photos.example/${records[1]!.key}`,
        uploadedAt: new Date(2_000).toISOString(),
        capturedAt: 2_000,
        source: "framed",
        frameKey: "celebration",
      },
    ]);
    expect(first.nextCursor).toStartWith("mod1.");

    const newest = { key: "launch/0000000004000-new.jpg", capturedAt: 4_000 };
    photos.set(newest.key, "new", new Date(newest.capturedAt));
    state.set(photoIndexKey("launch", newest.key, newest.capturedAt), JSON.stringify({
      version: 1,
      ...newest,
      uploadedAt: new Date(newest.capturedAt).toISOString(),
    }));

    const second = await store.listModerationPhotos("launch", {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.photos.map((photo) => photo.key)).toEqual([records[0]!.key]);
    expect(second.nextCursor).toBeNull();
  });

  test("filters inclusively, deduplicates exact keys, and skips missing public photos", async () => {
    const photos = new InMemoryObjectStore({
      "launch/0000000002000-b.jpg": "b",
      "launch/0000000003000-c.jpg": "c",
    });
    const state = new InMemoryObjectStore();
    const metadata = (key: string, capturedAt: number) => JSON.stringify({
      version: 1,
      key,
      uploadedAt: new Date(capturedAt).toISOString(),
      capturedAt,
    });
    state.set(photoIndexKey("launch", "launch/0000000004000-missing.jpg", 4_000),
      metadata("launch/0000000004000-missing.jpg", 4_000));
    state.set(photoIndexKey("launch", "launch/0000000003000-c.jpg", 3_500),
      metadata("launch/0000000003000-c.jpg", 3_000));
    state.set(photoIndexKey("launch", "launch/0000000003000-c.jpg", 3_000),
      metadata("launch/0000000003000-c.jpg", 3_000));
    state.set(photoIndexKey("launch", "launch/0000000002000-b.jpg", 2_000),
      metadata("launch/0000000002000-b.jpg", 2_000));

    const page = await new EventStore(photos, state, "https://photos.example")
      .listModerationPhotos("launch", { limit: 10, from: 2_000, to: 3_000 });

    expect(page.photos.map((photo) => photo.key)).toEqual([
      "launch/0000000003000-c.jpg",
      "launch/0000000002000-b.jpg",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  test("fails explicitly on corrupt, future, expanded, or cross-Event index records", async () => {
    const photos = new InMemoryObjectStore({ "launch/0000000001000-a.jpg": "a" });
    for (const record of [
      { version: 2, key: "launch/0000000001000-a.jpg", uploadedAt: new Date(1_000).toISOString(), capturedAt: 1_000 },
      { version: 1, key: "other/0000000001000-a.jpg", uploadedAt: new Date(1_000).toISOString(), capturedAt: 1_000 },
      { version: 1, key: "launch/0000000001000-a.jpg", uploadedAt: new Date(1_000).toISOString(), capturedAt: 1_000, heartbeat: true },
    ]) {
      const state = new InMemoryObjectStore({
        [photoIndexKey("launch", "launch/0000000001000-a.jpg", 1_000)]: JSON.stringify(record),
      });
      await expect(new EventStore(photos, state, "https://photos.example")
        .listModerationPhotos("launch", { limit: 10 }))
        .rejects.toBeInstanceOf(InvalidStoredModerationPhotoError);
    }
  });

  test("rebuilds legacy indexes in bounded add-only batches without receipts", async () => {
    const photos = new InMemoryObjectStore();
    photos.set("launch/1753315200000-a.jpg", "a", new Date("2025-07-25T00:00:00.000Z"));
    photos.set("launch/legacy-b.jpg", "b", new Date("2025-07-26T00:00:00.000Z"));
    photos.set("launch/notes.txt", "notes", new Date("2025-07-27T00:00:00.000Z"));
    photos.set("other/1753315200000-other.jpg", "other");
    const state = new InMemoryObjectStore();
    const existingKey = photoIndexKey("launch", "launch/1753315200000-a.jpg", 1753315200000);
    state.set(existingKey, "existing-bytes");
    const existingEtag = (await state.get(existingKey))!.etag;
    const store = new EventStore(photos, state, "https://photos.example");

    const first = await store.rebuildPhotoIndex("launch", { batchSize: 2 });
    expect(first).toMatchObject({ complete: false, scanned: 2, indexed: 1 });
    expect(first.checkpoint).toBe("launch/legacy-b.jpg");
    expect((await state.get(existingKey))!.etag).toBe(existingEtag);

    const second = await store.rebuildPhotoIndex("launch", { batchSize: 2 });
    expect(second).toMatchObject({ complete: true, scanned: 1, indexed: 0 });
    expect(state.has(photoIndexKey(
      "launch",
      "launch/legacy-b.jpg",
      new Date("2025-07-26T00:00:00.000Z").getTime()
    ))).toBe(true);
    expect(state.has(photoReceiptKey("launch", "launch/1753315200000-a.jpg"))).toBe(false);
    expect(state.has(photoReceiptKey("launch", "launch/legacy-b.jpg"))).toBe(false);
    expect(state.has(photoIndexRebuildCompleteKey("launch"))).toBe(true);
    expect((await state.list({ prefix: "events/other/" })).objects).toHaveLength(0);
  });

  test("does not checkpoint past a failed index batch and safely retries create-only writes", async () => {
    const photos = new InMemoryObjectStore({
      "launch/1753315200000-a.jpg": "a",
      "launch/1753315200001-b.jpg": "b",
    });
    const state = new FailNextIndexCreateStore();
    const store = new EventStore(photos, state, "https://photos.example");

    await expect(store.rebuildPhotoIndex("launch", { batchSize: 2 })).rejects.toThrow("index");
    expect(state.has(photoIndexRebuildCheckpointKey("launch"))).toBe(false);
    const retried = await store.rebuildPhotoIndex("launch", { batchSize: 2 });
    expect(retried).toMatchObject({ complete: true, scanned: 2, indexed: 2 });
  });

  test("rechecks public truth and recovers a crash after the final checkpoint", async () => {
    const photos = new MissingDuringRebuildStore({
      "launch/1753315200000-gone.jpg": "gone",
      "launch/1753315200001-kept.jpg": "kept",
    });
    const state = new CrashBeforeCompleteMarkerStore();
    const store = new EventStore(photos, state, "https://photos.example");

    await expect(store.rebuildPhotoIndex("launch", { batchSize: 10 }))
      .rejects.toThrow("complete marker");
    expect(state.has(photoIndexKey("launch", "launch/1753315200000-gone.jpg", 1753315200000))).toBe(false);
    expect(state.has(photoIndexRebuildCheckpointKey("launch"))).toBe(true);
    expect(state.has(photoIndexRebuildCompleteKey("launch"))).toBe(false);

    const recovered = await store.rebuildPhotoIndex("launch", { batchSize: 10 });
    expect(recovered).toEqual({
      complete: true,
      scanned: 0,
      indexed: 0,
      checkpoint: "launch/1753315200001-kept.jpg",
    });
  });

  test("rejects corrupt rebuild checkpoints without touching photos", async () => {
    const photos = new InMemoryObjectStore({ "launch/1753315200000-a.jpg": "a" });
    const state = new InMemoryObjectStore({
      [photoIndexRebuildCheckpointKey("launch")]: JSON.stringify({
        version: 2,
        event: "launch",
        lastPhotoKey: "launch/1753315200000-a.jpg",
      }),
    });
    await expect(new EventStore(photos, state, "https://photos.example")
      .rebuildPhotoIndex("launch", { batchSize: 10 }))
      .rejects.toBeInstanceOf(InvalidPhotoIndexRebuildStateError);
    expect(photos.has("launch/1753315200000-a.jpg")).toBe(true);
  });

  test("writes an exact private heartbeat with a server-controlled timestamp", async () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => now);
    const input = boothHeartbeat("018f0000-0000-4000-8000-000000000001", {
      pendingCount: 2,
      upload: "retry-wait",
    });

    const record = await store.writeBoothHeartbeat("launch", input);

    expect(record).toEqual({ ...input, lastSeenAt: now.toISOString() });
    const stored = await state.get(boothHeartbeatKey("launch", input.deviceId));
    expect(await stored!.json<unknown>()).toEqual(record);
    expect((await photos.list()).objects).toHaveLength(0);
    await expect(store.writeBoothHeartbeat("launch", {
      ...input,
      lastSeenAt: "2099-01-01T00:00:00.000Z",
    } as unknown as BoothHeartbeatInput)).rejects.toBeInstanceOf(TypeError);
  });

  test("pages bounded private heartbeats, derives stale records, and overwrites exact devices", async () => {
    let now = new Date("2026-07-24T00:00:00.000Z");
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => now);
    const firstDevice = "018f0000-0000-4000-8000-000000000001";
    const secondDevice = "018f0000-0000-4000-8000-000000000002";
    const thirdDevice = "018f0000-0000-4000-8000-000000000003";
    await store.writeBoothHeartbeat("launch", boothHeartbeat(firstDevice));
    await store.writeBoothHeartbeat("launch", boothHeartbeat(secondDevice));
    await store.writeBoothHeartbeat("launch", boothHeartbeat(thirdDevice));
    now = new Date("2026-07-24T00:00:45.001Z");

    const firstPage = await store.listBoothHeartbeats("launch", { limit: 2 });
    const secondPage = await store.listBoothHeartbeats("launch", { limit: 2, cursor: firstPage.cursor });

    expect(firstPage.booths.map((record) => record.deviceId)).toEqual([firstDevice, secondDevice]);
    expect(firstPage.booths.every((record) => record.stale)).toBe(true);
    expect(firstPage.cursor).not.toBeNull();
    expect(secondPage.booths.map((record) => record.deviceId)).toEqual([thirdDevice]);
    expect(secondPage.cursor).toBeNull();
    await store.writeBoothHeartbeat("launch", boothHeartbeat(firstDevice, { pendingCount: 3 }));
    const refreshed = await store.listBoothHeartbeats("launch", { limit: 100 });
    expect(refreshed.booths).toHaveLength(3);
    expect(refreshed.booths.find((record) => record.deviceId === firstDevice)).toMatchObject({
      pendingCount: 3,
      stale: false,
      lastSeenAt: now.toISOString(),
    });
    await expect(store.listBoothHeartbeats("launch", { limit: 101 })).rejects.toBeInstanceOf(TypeError);
    expect((await photos.list()).objects).toHaveLength(0);
  });

  test("passes a long opaque storage cursor through unchanged", async () => {
    const firstDevice = "018f0000-0000-4000-8000-000000000001";
    const secondDevice = "018f0000-0000-4000-8000-000000000002";
    const prefix = "events/launch/booths/";
    const state = new LongBoothCursorStore(prefix, boothHeartbeatKey("launch", firstDevice));
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    await store.writeBoothHeartbeat("launch", boothHeartbeat(firstDevice));
    await store.writeBoothHeartbeat("launch", boothHeartbeat(secondDevice));

    const firstPage = await store.listBoothHeartbeats("launch", { limit: 1 });
    expect(firstPage.cursor).toBe(state.opaqueCursor);
    expect(firstPage.cursor!.length).toBeGreaterThan(2_048);

    const secondPage = await store.listBoothHeartbeats("launch", {
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(secondPage.booths.map((record) => record.deviceId)).toEqual([secondDevice]);
  });

  test("passes a whitespace-only opaque storage cursor through unchanged", async () => {
    const firstDevice = "018f0000-0000-4000-8000-000000000001";
    const secondDevice = "018f0000-0000-4000-8000-000000000002";
    const prefix = "events/launch/booths/";
    const whitespaceCursor = " \t\n ";
    const state = new LongBoothCursorStore(
      prefix,
      boothHeartbeatKey("launch", firstDevice),
      whitespaceCursor
    );
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    await store.writeBoothHeartbeat("launch", boothHeartbeat(firstDevice));
    await store.writeBoothHeartbeat("launch", boothHeartbeat(secondDevice));

    const firstPage = await store.listBoothHeartbeats("launch", { limit: 1 });
    expect(firstPage.cursor).toBe(whitespaceCursor);

    const secondPage = await store.listBoothHeartbeats("launch", {
      limit: 1,
      cursor: firstPage.cursor,
    });
    expect(secondPage.booths.map((record) => record.deviceId)).toEqual([secondDevice]);
  });

  test("isolates heartbeats by Event and fails closed on malformed or future private records", async () => {
    const deviceId = "018f0000-0000-4000-8000-000000000001";
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => new Date("2026-07-24T00:00:00.000Z"));
    await store.writeBoothHeartbeat("launch", boothHeartbeat(deviceId));
    await store.writeBoothHeartbeat("other", boothHeartbeat(deviceId, { pendingCount: 9 }));

    expect((await store.listBoothHeartbeats("launch", {})).booths).toMatchObject([{ deviceId, pendingCount: 0 }]);
    expect((await store.listBoothHeartbeats("other", {})).booths).toMatchObject([{ deviceId, pendingCount: 9 }]);
    expect(state.has(boothHeartbeatKey("launch", deviceId))).toBe(true);
    expect(state.has(boothHeartbeatKey("other", deviceId))).toBe(true);
    state.set(boothHeartbeatKey("launch", "018f0000-0000-4000-8000-000000000004"), "not json");
    await expect(store.listBoothHeartbeats("launch", {})).rejects.toThrow("booth heartbeat");

    const futureState = new InMemoryObjectStore({
      [boothHeartbeatKey("launch", deviceId)]: JSON.stringify({
        ...boothHeartbeat(deviceId),
        version: 2,
        lastSeenAt: "2026-07-24T00:00:00.000Z",
      }),
    });
    const futureStore = new EventStore(photos, futureState, "https://photos.example");
    await expect(futureStore.listBoothHeartbeats("launch", {})).rejects.toThrow("booth heartbeat");
    expect((await photos.list()).objects).toHaveLength(0);
  });

  test("returns an unpaused default without writing and stores bounded localized pause state privately", async () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example", () => now);

    expect(await store.readBoothOperationalState("launch")).toEqual({
      version: 1,
      paused: false,
      updatedAt: now.toISOString(),
    });
    expect(state.has(boothOperationalStateKey("launch"))).toBe(false);
    const written = await store.writeBoothOperationalState("launch", {
      paused: true,
      messages: { en: "The Booth is briefly paused.", "zh-SG": "暂时暂停" },
    });
    expect(written).toEqual({
      version: 1,
      paused: true,
      messages: { en: "The Booth is briefly paused.", "zh-SG": "暂时暂停" },
      updatedAt: now.toISOString(),
    });
    expect(await store.readBoothOperationalState("launch")).toEqual(written);
    expect((await photos.list()).objects).toHaveLength(0);

    state.set(boothOperationalStateKey("other"), JSON.stringify({ version: 2, paused: false, updatedAt: now.toISOString() }));
    await expect(store.readBoothOperationalState("other")).rejects.toThrow("booth operational state");
  });

  test("rejects non-canonical Events before any Booth STATE access", async () => {
    const input = boothHeartbeat("018f0000-0000-4000-8000-000000000001");

    for (const event of ["Launch 2026", "launch--2026", "launch/nested"]) {
      const state = new BoothStateAccessStore();
      const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
      const results = await Promise.allSettled([
        store.writeBoothHeartbeat(event, input),
        store.listBoothHeartbeats(event, {}),
        store.readBoothOperationalState(event),
        store.writeBoothOperationalState(event, { paused: true }),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
        "rejected",
        "rejected",
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(InvalidEventSlugError);
        }
      }
      expect(state.reads).toEqual([]);
      expect(state.writes).toEqual([]);
      expect(state.lists).toEqual([]);
    }
  });

  test("round-trips sensitive locale names with own-property semantics", async () => {
    const state = new InMemoryObjectStore();
    const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
    const messages = {
      constructor: "Constructor locale",
      prototype: "Prototype locale",
      toString: "String locale",
    };

    const written = await store.writeBoothOperationalState("launch", { paused: true, messages });
    expect(Object.getPrototypeOf(written.messages!)).toBeNull();
    expect(Object.keys(written.messages!)).toEqual(Object.keys(messages));
    const stored = await (await state.get(boothOperationalStateKey("launch")))!.json<{
      messages: Record<string, string>;
    }>();
    expect(stored.messages).toEqual(messages);

    const roundTripped = await store.readBoothOperationalState("launch");
    expect(Object.getPrototypeOf(roundTripped.messages!)).toBeNull();
    for (const key of Object.keys(messages)) {
      expect(Object.hasOwn(roundTripped.messages!, key)).toBe(true);
      expect(roundTripped.messages![key]).toBe(messages[key as keyof typeof messages]);
    }
  });

  describe("export photo sources", () => {
    const firstKey = "launch/1721793600000-018f0000-0000-4000-8000-000000000001.jpg";
    const secondKey = "launch/1721793600001-018f0000-0000-4000-8000-000000000002.png";
    const receipt = (key: string) => ({
      version: 1,
      key,
      uploadedAt: "2026-07-24T00:00:00.000Z",
      capturedAt: 1721793600000,
      source: "framed",
      frameKey: "square",
      configRevisionId: "018f0000-0000-7000-8000-000000000001",
    });

    test("pages exact Event images and joins only each exact private receipt", async () => {
      const photos = new PagedExportPhotoStore({
        [firstKey]: new Uint8Array([1, 2, 3]),
        [secondKey]: new Uint8Array([4, 5]),
        "launch/readme.txt": "not a photo",
        "other/1721793600000-other.jpg": new Uint8Array([9]),
      });
      const state = new BoothStateAccessStore();
      state.set(photoReceiptKey("launch", firstKey), JSON.stringify(receipt(firstKey)));
      state.set(photoReceiptKey("launch", secondKey), JSON.stringify({
        ...receipt(secondKey),
        source: "camera-fallback",
        frameKey: undefined,
      }));
      const store = new EventStore(photos, state, "https://photos.example");

      const sources = [];
      for await (const source of store.iterateExportPhotoSources("launch")) sources.push(source);

      expect(photos.photoLists).toBeGreaterThan(1);
      expect(sources.map(({ key }) => key)).toEqual([firstKey, secondKey]);
      expect(sources[0]).toEqual({
        key: firstKey,
        size: 3,
        uploadedAt: expect.any(String),
        receipt: {
          capturedAt: 1721793600000,
          source: "framed",
          frameKey: "square",
        },
      });
      expect(sources[1]?.receipt).toEqual({
        capturedAt: 1721793600000,
        source: "camera-fallback",
      });
      expect(JSON.stringify(sources)).not.toContain("configRevisionId");
      expect(JSON.stringify(sources)).not.toContain("photo-metadata");
      expect(state.reads).toEqual([
        photoReceiptKey("launch", firstKey),
        photoReceiptKey("launch", secondKey),
      ]);
    });

    test("uses null for one missing exact receipt and never yields orphan receipts", async () => {
      const photos = new InMemoryObjectStore({ [firstKey]: new Uint8Array([1]) });
      const state = new InMemoryObjectStore({
        [photoReceiptKey("launch", secondKey)]: JSON.stringify(receipt(secondKey)),
      });
      const store = new EventStore(photos, state, "https://photos.example");
      const sources = [];
      for await (const source of store.iterateExportPhotoSources("launch")) sources.push(source);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.key).toBe(firstKey);
      expect(sources[0]?.receipt).toBeNull();
    });

    test("rejects non-canonical Events before public or private access", async () => {
      const photos = new BoothStateAccessStore();
      const state = new BoothStateAccessStore();
      const store = new EventStore(photos, state, "https://photos.example");
      await expect(async () => {
        for await (const _source of store.iterateExportPhotoSources("Launch Event")) {
          // no-op
        }
      }).toThrow(InvalidEventSlugError);
      expect(photos.lists).toEqual([]);
      expect(state.reads).toEqual([]);
    });

    test("fails enriched inventory on corrupt, wrong-key, or unavailable private receipts", async () => {
      for (const stored of [
        { ...receipt(firstKey), version: 2 },
        { ...receipt(firstKey), key: secondKey },
        { ...receipt(firstKey), credential: "secret" },
      ]) {
        const photos = new InMemoryObjectStore({ [firstKey]: new Uint8Array([1]) });
        const state = new InMemoryObjectStore({
          [photoReceiptKey("launch", firstKey)]: JSON.stringify(stored),
        });
        const store = new EventStore(photos, state, "https://photos.example");
        await expect(async () => {
          for await (const _source of store.iterateExportPhotoSources("launch")) {
            // no-op
          }
        }).toThrow(InvalidPhotoReceiptError);
      }

      const unavailable = new EventStore(
        new InMemoryObjectStore({ [firstKey]: new Uint8Array([1]) }),
        new FailingReceiptReadStore(),
        "https://photos.example",
      );
      await expect(async () => {
        for await (const _source of unavailable.iterateExportPhotoSources("launch")) {
          // no-op
        }
      }).toThrow("private STATE unavailable");
    });
  });
});
