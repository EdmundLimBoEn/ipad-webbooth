import type {
  R2Bucket,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "@cloudflare/workers-types";
import {
  EVENT_CONFIG_VERSION,
  parseConfigRevision,
  parseEventConfig,
  type ConfigRevision,
  type EventConfig,
  type EventExperience,
} from "./event-config";
export { canonicalEvent, InvalidEventSlugError, slugifyEvent } from "./event-identity";
export { EVENT_CONFIG_VERSION };
export type { EventConfig } from "./event-config";
export const HEALTH_CANARY_KEY = "_health/canary";
const HEALTH_STATE_KEY = "health/statuspage.json";
const LEGACY_HEALTH_STATE_KEY = "_health/state.json";
const PAGE_SIZE = 1000;

type StoredEventConfig = EventConfig & { version: typeof EVENT_CONFIG_VERSION };

export type StoredObject = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
};

export interface StoredObjectBody extends StoredObject {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export type ListOptions = {
  prefix?: string;
  cursor?: string;
  startAfter?: string;
  limit?: number;
};

export type ListResult = {
  objects: StoredObject[];
  truncated: boolean;
  cursor?: string;
};

export interface ObjectStore {
  get(key: string): Promise<StoredObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): Promise<ListResult>;
  compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: R2PutOptions
  ): Promise<boolean>;
}

/** Production adapter. Keeping R2 behind this seam makes key and paging rules testable. */
export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions): Promise<void> {
    await this.bucket.put(key, value, options);
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: R2PutOptions
  ): Promise<boolean> {
    const result = await this.bucket.put(key, value, {
      ...options,
      onlyIf: expectedEtag === null
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: expectedEtag },
    });
    return result !== null;
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const page: R2Objects = await this.bucket.list(options);
    return { objects: page.objects, truncated: page.truncated, cursor: page.truncated ? page.cursor : undefined };
  }
}

type MemoryEntry = { bytes: Uint8Array; uploaded: Date; etag: string };

/** Deterministic, committed fake used by unit/contract tests and local tooling. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(initial: Record<string, string | Uint8Array> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.set(key, value);
    }
  }

  set(key: string, value: string | Uint8Array, uploaded = new Date()): void {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
    this.entries.set(key, { bytes, uploaded, etag: crypto.randomUUID() });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const bytes = entry.bytes.slice();
    return {
      key,
      size: bytes.byteLength,
      uploaded: entry.uploaded,
      etag: entry.etag,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async json<T>() {
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      },
    };
  }

  async put(_key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    this.entries.set(_key, {
      bytes: memoryBytes(value),
      uploaded: new Date(),
      etag: crypto.randomUUID(),
    });
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    const current = this.entries.get(key);
    if (expectedEtag === null ? current !== undefined : current?.etag !== expectedEtag) return false;
    this.entries.set(key, {
      bytes: memoryBytes(value),
      uploaded: new Date(),
      etag: crypto.randomUUID(),
    });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    const keys = [...this.entries.keys()]
      .filter((key) => !options.prefix || key.startsWith(options.prefix))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .sort();
    const offset = options.cursor ? Number(options.cursor) || 0 : 0;
    const limit = Math.min(options.limit ?? PAGE_SIZE, PAGE_SIZE);
    const selected = keys.slice(offset, offset + limit);
    const objects = selected.map((key) => {
      const entry = this.entries.get(key)!;
      return { key, size: entry.bytes.byteLength, uploaded: entry.uploaded, etag: entry.etag };
    });
    const next = offset + selected.length;
    return { objects, truncated: next < keys.length, cursor: next < keys.length ? String(next) : undefined };
  }
}

export const eventConfigKey = (event: string) => `events/${event}/config.json`;
export const eventConfigRevisionPrefix = (event: string) =>
  `events/${event}/config-revisions/`;
export const eventConfigRevisionKey = (event: string, id: string) =>
  `${eventConfigRevisionPrefix(event)}${id}.json`;
export const legacyEventConfigKey = (event: string) => `_config/${event}.json`;
export const eventPhotoPrefix = (event: string) => `${event}/`;

function photoTimestamp(key: string): number {
  const filename = key.slice(key.lastIndexOf("/") + 1);
  return Number(filename.split("-")[0]) || 0;
}

function isPhotoKey(event: string, key: string): boolean {
  return key.startsWith(eventPhotoPrefix(event)) && /\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i.test(key);
}

export type Photo = { key: string; url: string; uploadedAt: Date };
export type PhotoFeed = { photos: Photo[]; cursor: string | null; unchanged: boolean; truncated: boolean };
export type ConfigMutationResult = {
  config: EventConfig;
  revision: ConfigRevision;
  idempotent: boolean;
};

export class ConfigConflictError extends Error {
  constructor(readonly expectedRevisionId: string | null, readonly currentRevisionId: string | null) {
    super("event configuration changed");
  }
}

export class ConfigMutationConflictError extends Error {
  constructor() {
    super("mutation ID was already used for different configuration");
  }
}

export class InvalidStoredEventConfigError extends Error {
  constructor(readonly event: string) {
    super(`stored config for ${event} is corrupt or uses an unsupported version`);
  }
}

export class EventStore {
  // Consistency policy: no process-global response cache. Reads reach the
  // backing store, so config writes/uploads/deletions need no invalidation fanout.
  constructor(
    readonly photos: ObjectStore,
    readonly state: ObjectStore,
    readonly publicBase: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  static fromEnv(env: Pick<CloudflareEnv, "PHOTOS" | "STATE" | "R2_PUBLIC_BASE">): EventStore {
    return new EventStore(new R2ObjectStore(env.PHOTOS), new R2ObjectStore(env.STATE), env.R2_PUBLIC_BASE);
  }

  publicUrl(key: string): string {
    const base = this.publicBase.replace(/\/$/, "");
    return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async readConfig(event: string): Promise<EventConfig | null> {
    try {
      const object = await this.state.get(eventConfigKey(event));
      if (object) {
        let current: unknown;
        try {
          current = await object.json<unknown>();
        } catch {
          throw new InvalidStoredEventConfigError(event);
        }
        const parsed = parseEventConfig(current);
        if (!parsed) throw new InvalidStoredEventConfigError(event);
        return parsed;
      }
    } catch (error) {
      if (error instanceof InvalidStoredEventConfigError) throw error;
      // During rollout, STATE may not exist yet. Legacy reads keep events live.
    }

    // Compatibility migration: old configs remain readable after STATE is introduced.
    const legacy = parseEventConfig(await this.readJson(this.photos, legacyEventConfigKey(event)));
    if (!legacy) return null;
    try {
      await this.writeConfig(event, legacy);
    } catch {
      // Returning the legacy value is safer than failing an event while the
      // operator creates/binds STATE. A later read retries the migration.
    }
    return legacy;
  }

  async writeConfig(event: string, config: EventConfig): Promise<void> {
    const stored: StoredEventConfig = { version: EVENT_CONFIG_VERSION, ...config };
    await this.state.put(eventConfigKey(event), JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  }

  async saveConfigRevision(
    event: string,
    input: {
      config: EventConfig;
      baseRevisionId: string | null;
      mutationId: string;
    }
  ): Promise<ConfigMutationResult> {
    const requested = parseEventConfig({
      version: EVENT_CONFIG_VERSION,
      ...input.config,
      currentRevisionId: undefined,
    });
    if (!requested) throw new TypeError("invalid event configuration");
    const requestedExperience = configExperience(requested);
    const head = await this.readConfigHead(event);
    const existing = await this.readRevision(event, input.mutationId);

    if (existing) {
      await this.assertMatchingMutation(event, existing, requestedExperience, input.baseRevisionId, input.mutationId);
      return this.finishExistingMutation(event, input, requested, head, existing);
    }

    const currentRevisionId = head.config?.currentRevisionId ?? null;
    if (input.baseRevisionId !== currentRevisionId) {
      throw new ConfigConflictError(input.baseRevisionId, currentRevisionId);
    }

    let parentRevisionId = currentRevisionId;
    if (head.config && !head.config.currentRevisionId) {
      const baseline: ConfigRevision = {
        version: EVENT_CONFIG_VERSION,
        id: crypto.randomUUID(),
        createdAt: this.now().toISOString(),
        parentRevisionId: null,
        reason: "baseline",
        config: configExperience(head.config),
      };
      const appended = await this.state.compareAndSwap(
        eventConfigRevisionKey(event, baseline.id),
        null,
        JSON.stringify(baseline),
        jsonWriteOptions()
      );
      if (!appended) throw new ConfigMutationConflictError();
      parentRevisionId = baseline.id;
    }

    const revision: ConfigRevision = {
      version: EVENT_CONFIG_VERSION,
      id: input.mutationId,
      createdAt: this.now().toISOString(),
      parentRevisionId,
      reason: "save",
      config: requestedExperience,
    };
    const appended = await this.state.compareAndSwap(
      eventConfigRevisionKey(event, revision.id),
      null,
      JSON.stringify(revision),
      jsonWriteOptions()
    );
    if (!appended) {
      const racedRevision = await this.readRevision(event, input.mutationId);
      if (!racedRevision) throw new ConfigMutationConflictError();
      await this.assertMatchingMutation(
        event,
        racedRevision,
        requestedExperience,
        input.baseRevisionId,
        input.mutationId
      );
      return this.finishExistingMutation(event, input, requested, head, racedRevision);
    }

    return this.advanceConfigHead(event, input.baseRevisionId, requested, head, revision, false);
  }

  photoKey(event: string, now = Date.now(), suffix = randomSuffix()): string {
    return `${event}/${String(now).padStart(13, "0")}-${suffix}.jpg`;
  }

  async putPhoto(event: string, body: ArrayBuffer): Promise<{ key: string; url: string }> {
    const key = this.photoKey(event);
    await this.photos.put(key, body, { httpMetadata: { contentType: "image/jpeg" } });
    return { key, url: this.publicUrl(key) };
  }

  async listPhotos(event: string, after: string | null = null): Promise<PhotoFeed> {
    const prefix = eventPhotoPrefix(event);
    const startAfter = after && after.startsWith(prefix) ? after : undefined;
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.photos.list({ prefix, cursor, ...(!cursor && startAfter ? { startAfter } : {}), limit: PAGE_SIZE });
      objects.push(...page.objects.filter((object) => isPhotoKey(event, object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    objects.sort((a, b) => photoTimestamp(b.key) - photoTimestamp(a.key) || b.key.localeCompare(a.key));
    const newest = objects[0]?.key ?? after;
    return {
      photos: objects.map((object) => ({ key: object.key, url: this.publicUrl(object.key), uploadedAt: object.uploaded })),
      cursor: newest ?? null,
      unchanged: objects.length === 0,
      truncated: false,
    };
  }

  async *iteratePhotoObjects(event: string): AsyncGenerator<StoredObject> {
    let cursor: string | undefined;
    do {
      const page = await this.photos.list({ prefix: eventPhotoPrefix(event), cursor, limit: PAGE_SIZE });
      for (const object of page.objects) if (isPhotoKey(event, object.key)) yield object;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  getPhoto(key: string): Promise<StoredObjectBody | null> {
    return this.photos.get(key);
  }

  async deletePhoto(event: string, key: string): Promise<boolean> {
    if (!isPhotoKey(event, key)) return false;
    const existing = await this.photos.get(key);
    if (!existing) return false;
    await this.photos.delete(key);
    return true;
  }

  async readHealthState<T>(): Promise<T | null> {
    let current: T | null = null;
    try {
      current = await this.readJson(this.state, HEALTH_STATE_KEY) as T | null;
    } catch {}
    if (current) return current;
    const legacy = await this.readJson(this.photos, LEGACY_HEALTH_STATE_KEY) as T | null;
    if (legacy) {
      try {
        await this.writeHealthState(legacy);
      } catch {}
    }
    return legacy;
  }

  writeHealthState(value: unknown): Promise<void> {
    return this.state.put(HEALTH_STATE_KEY, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  }

  private async readJson(store: ObjectStore, key: string): Promise<unknown | null> {
    const object = await store.get(key);
    if (!object) return null;
    try {
      return await object.json<unknown>();
    } catch {
      return null;
    }
  }

  private async readConfigHead(event: string): Promise<{ config: EventConfig | null; etag: string | null }> {
    const object = await this.state.get(eventConfigKey(event));
    if (object) {
      let value: unknown;
      try {
        value = await object.json<unknown>();
      } catch {
        throw new InvalidStoredEventConfigError(event);
      }
      const config = parseEventConfig(value);
      if (!config) throw new InvalidStoredEventConfigError(event);
      return { config, etag: object.etag };
    }
    const legacy = parseEventConfig(await this.readJson(this.photos, legacyEventConfigKey(event)));
    return { config: legacy, etag: null };
  }

  private async readRevision(event: string, id: string): Promise<ConfigRevision | null> {
    const object = await this.state.get(eventConfigRevisionKey(event, id));
    if (!object) return null;
    try {
      return parseConfigRevision(await object.json<unknown>());
    } catch {
      return null;
    }
  }

  private async assertMatchingMutation(
    event: string,
    revision: ConfigRevision,
    requested: EventExperience,
    baseRevisionId: string | null,
    mutationId: string
  ): Promise<void> {
    if (
      revision.id !== mutationId
      || revision.reason !== "save"
      || revision.sourceRevisionId !== undefined
      || revision.sourcePresetId !== undefined
      || !sameExperience(revision.config, requested)
    ) {
      throw new ConfigMutationConflictError();
    }
    if (revision.parentRevisionId === baseRevisionId) return;
    if (baseRevisionId !== null || revision.parentRevisionId === null) {
      throw new ConfigMutationConflictError();
    }

    // A first save over an unrevisioned config receives an internal baseline
    // parent even though the caller's base remains null.
    const parent = await this.readRevision(event, revision.parentRevisionId);
    if (parent?.reason !== "baseline") throw new ConfigMutationConflictError();
  }

  private async finishExistingMutation(
    event: string,
    input: { config: EventConfig; baseRevisionId: string | null; mutationId: string },
    requested: EventConfig,
    head: { config: EventConfig | null; etag: string | null },
    revision: ConfigRevision
  ): Promise<ConfigMutationResult> {
    if (head.config?.currentRevisionId === revision.id) {
      return { config: head.config, revision, idempotent: true };
    }

    const currentRevisionId = head.config?.currentRevisionId ?? null;
    let canAdvance = currentRevisionId === revision.parentRevisionId
      && input.baseRevisionId === currentRevisionId;
    if (
      !canAdvance
      && input.baseRevisionId === null
      && currentRevisionId === null
      && revision.parentRevisionId
    ) {
      const baseline = await this.readRevision(event, revision.parentRevisionId);
      canAdvance = baseline?.reason === "baseline"
        && sameExperience(baseline.config, configExperience(head.config ?? { frames: [] }));
    }
    if (!canAdvance) {
      throw new ConfigConflictError(input.baseRevisionId, currentRevisionId);
    }

    return this.advanceConfigHead(event, input.baseRevisionId, requested, head, revision, true);
  }

  private async advanceConfigHead(
    event: string,
    baseRevisionId: string | null,
    requested: EventConfig,
    head: { config: EventConfig | null; etag: string | null },
    revision: ConfigRevision,
    idempotent: boolean
  ): Promise<ConfigMutationResult> {
    const config = mergedRevisionHead(requested, head.config, revision.id);
    const advanced = await this.state.compareAndSwap(
      eventConfigKey(event),
      head.etag,
      JSON.stringify({ version: EVENT_CONFIG_VERSION, ...config }),
      jsonWriteOptions()
    );
    if (advanced) return { config, revision, idempotent };
    const current = await this.readConfigHead(event);
    if (current.config?.currentRevisionId === revision.id) {
      return { config: current.config, revision, idempotent: true };
    }
    throw new ConfigConflictError(baseRevisionId, current.config?.currentRevisionId ?? null);
  }
}

function memoryBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return new Uint8Array(value.slice(0));
}

function configExperience(config: EventConfig): EventExperience {
  const { boothKeyHash: _boothKeyHash, currentRevisionId: _currentRevisionId, ...experience } = config;
  return experience;
}

function sameExperience(left: EventExperience, right: EventExperience): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergedRevisionHead(requested: EventConfig, current: EventConfig | null, revisionId: string): EventConfig {
  const config: EventConfig = {
    ...configExperience(requested),
    currentRevisionId: revisionId,
  };
  const boothKeyHash = requested.boothKeyHash ?? current?.boothKeyHash;
  if (boothKeyHash !== undefined) config.boothKeyHash = boothKeyHash;
  return config;
}

function jsonWriteOptions(): R2PutOptions {
  return {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  };
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
