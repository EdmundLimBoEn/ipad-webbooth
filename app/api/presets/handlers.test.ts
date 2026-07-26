import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  ConfigConflictError,
  EventPresetNotFoundError,
  EventStore,
  InMemoryObjectStore,
  PresetConflictError,
  type ConfigMutationResult,
  type ConfigPresetApplyInput,
  type EventPresetPage,
  type EventPresetListOptions,
  type PutEventPresetInput,
} from "@/app/event-store";
import type { EventPreset } from "@/app/event-preset";
import { getPresets, postPresetApply, putPreset } from "./handlers";

const preset: EventPreset = {
  version: 1,
  id: "launch-night",
  label: "Launch Night",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  config: { frames: ["square"], locales: ["en"], defaultLocale: "en" },
};

class PresetHandlerStore extends EventStore {
  calls: string[] = [];
  listResult: EventPresetPage = { presets: [preset], cursor: null };
  putError: unknown;
  applyError: unknown;

  constructor() {
    super(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
  }

  override async listEventPresets(options: EventPresetListOptions): Promise<EventPresetPage> {
    this.calls.push(`list:${JSON.stringify(options)}`);
    return this.listResult;
  }

  override async putEventPreset(id: string, input: PutEventPresetInput): Promise<EventPreset> {
    this.calls.push(`put:${id}:${JSON.stringify(input)}`);
    if (this.putError) throw this.putError;
    return { ...preset, id, label: input.label, config: input.config };
  }

  override async applyEventPreset(
    event: string,
    input: ConfigPresetApplyInput,
  ): Promise<ConfigMutationResult> {
    this.calls.push(`apply:${event}:${JSON.stringify(input)}`);
    if (this.applyError) throw this.applyError;
    return {
      config: {
        ...preset.config,
        boothKeyHash: "private",
        currentRevisionId: input.mutationId,
      },
      revision: {
        version: 1,
        id: input.mutationId,
        createdAt: "2026-07-24T00:00:00.000Z",
        parentRevisionId: input.baseRevisionId,
        reason: "preset",
        sourcePresetId: input.presetId,
        config: preset.config,
      },
      idempotent: false,
    };
  }
}

function request(
  path: string,
  options: { method?: string; key?: string; body?: unknown } = {},
): NextRequest {
  return new NextRequest(`https://app.test${path}`, {
    method: options.method,
    headers: {
      "x-booth-key": options.key ?? "admin",
      "content-type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("Admin preset handlers", () => {
  test("authenticates before parsing or storage", async () => {
    for (const [adminKey, status] of [[undefined, 503], ["different", 401]] as const) {
      const store = new PresetHandlerStore();
      const response = await getPresets(request("/api/presets?limit=nope"), {
        store,
        adminKey,
      });
      expect(response.status).toBe(status);
      expect(store.calls).toEqual([]);
    }
  });

  test("pages presets with strict bounded input and an explicit safe response", async () => {
    const store = new PresetHandlerStore();
    store.listResult = {
      presets: [{ ...preset, credential: "never" } as never],
      cursor: "opaque",
    };
    const response = await getPresets(request("/api/presets?limit=25"), {
      store,
      adminKey: "admin",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.calls).toEqual(["list:{\"limit\":25}"]);
    expect(JSON.stringify(await response.json())).not.toContain("credential");

    for (const query of ["limit=0", "limit=101", "limit=1.5", "secret=x", "limit=2&limit=3"]) {
      const invalidStore = new PresetHandlerStore();
      expect((await getPresets(request(`/api/presets?${query}`), {
        store: invalidStore,
        adminKey: "admin",
      })).status).toBe(400);
      expect(invalidStore.calls).toEqual([]);
    }
  });

  test("strictly saves only a safe experience and reports conflicts", async () => {
    const store = new PresetHandlerStore();
    const response = await putPreset(request("/api/presets/launch-night", {
      method: "PUT",
      body: {
        label: "Launch Night",
        config: preset.config,
        expectedUpdatedAt: null,
      },
    }), "launch-night", { store, adminKey: "admin" });
    expect(response.status).toBe(200);
    expect(store.calls[0]).toContain("put:launch-night:");

    for (const body of [
      { label: "Unsafe", config: { ...preset.config, boothKeyHash: "secret" }, expectedUpdatedAt: null },
      { label: "Unsafe", config: preset.config, expectedUpdatedAt: null, device: "private" },
    ]) {
      const invalidStore = new PresetHandlerStore();
      expect((await putPreset(request("/api/presets/launch-night", {
        method: "PUT",
        body,
      }), "launch-night", { store: invalidStore, adminKey: "admin" })).status).toBe(400);
      expect(invalidStore.calls).toEqual([]);
    }

    store.putError = new PresetConflictError("launch-night", null, preset.updatedAt);
    expect((await putPreset(request("/api/presets/launch-night", {
      method: "PUT",
      body: { label: preset.label, config: preset.config, expectedUpdatedAt: null },
    }), "launch-night", { store, adminKey: "admin" })).status).toBe(409);
  });

  test("applies a preset to one canonical Event and allowlists the public config", async () => {
    const mutationId = "018f0000-0000-4000-8000-000000000301";
    const store = new PresetHandlerStore();
    const body = { presetId: "launch-night", mutationId, baseRevisionId: null };
    const response = await postPresetApply(request("/api/presets/apply?event=launch", {
      method: "POST",
      body,
    }), { store, adminKey: "admin" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...preset.config,
      hasBoothKey: true,
      currentRevisionId: mutationId,
      sourcePresetId: "launch-night",
      idempotent: false,
    });

    const invalidStore = new PresetHandlerStore();
    expect((await postPresetApply(request("/api/presets/apply?event=Launch", {
      method: "POST",
      body,
    }), { store: invalidStore, adminKey: "admin" })).status).toBe(400);
    expect(invalidStore.calls).toEqual([]);

    store.applyError = new EventPresetNotFoundError("launch-night");
    expect((await postPresetApply(request("/api/presets/apply?event=launch", {
      method: "POST",
      body,
    }), { store, adminKey: "admin" })).status).toBe(404);
    store.applyError = new ConfigConflictError(null, mutationId);
    expect((await postPresetApply(request("/api/presets/apply?event=launch", {
      method: "POST",
      body,
    }), { store, adminKey: "admin" })).status).toBe(409);
  });
});
