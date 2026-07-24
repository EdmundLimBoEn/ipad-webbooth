import { describe, expect, test } from "bun:test";
import {
  canonicalEvent,
  ConfigConflictError,
  ConfigMutationConflictError,
  ConfigRevisionNotFoundError,
  EventStore,
  InMemoryObjectStore,
  InvalidStoredConfigRevisionError,
  eventConfigKey,
  eventConfigMutationKey,
  eventConfigRevisionKey,
  legacyEventConfigKey,
} from "./event-store";

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
    }),
  });
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
    }>()).toEqual({
      version: 1,
      config: { frames: ["one"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: null,
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
    }>()).toEqual({
      version: 1,
      config: { frames: ["one"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: fingerprint,
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
    }>()).toEqual({
      version: 1,
      config: { frames: ["new"] },
      baseRevisionId: null,
      boothKeyMutationFingerprint: input.boothKeyMutationFingerprint,
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

  test("returns an initial snapshot and efficient start-after delta", async () => {
    const photos = new InMemoryObjectStore();
    photos.set("launch/0000000001000-aaaa.jpg", "a", new Date("2026-01-01T00:00:01Z"));
    photos.set("launch/0000000002000-bbbb.jpg", "b", new Date("2026-01-01T00:00:02Z"));
    photos.set("launch/readme.txt", "not a photo");
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");

    const initial = await store.listPhotos("launch");
    expect(initial.photos.map((photo) => photo.url)).toEqual([
      "https://photos.example/launch/0000000002000-bbbb.jpg",
      "https://photos.example/launch/0000000001000-aaaa.jpg",
    ]);
    expect(initial.cursor).toBe("launch/0000000002000-bbbb.jpg");

    const unchanged = await store.listPhotos("launch", initial.cursor);
    expect(unchanged).toMatchObject({ photos: [], cursor: initial.cursor, unchanged: true });
    photos.set("launch/0000000003000-cccc.jpg", "c");
    const delta = await store.listPhotos("launch", initial.cursor);
    expect(delta.photos).toHaveLength(1);
    expect(delta.cursor).toBe("launch/0000000003000-cccc.jpg");
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
});
