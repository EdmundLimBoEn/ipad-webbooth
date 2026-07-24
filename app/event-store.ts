import type {
  R2Bucket,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from "@cloudflare/workers-types";
import {
  EVENT_CONFIG_VERSION,
  isRevisionId,
  parseConfigRevision,
  parseEventConfig,
  type ConfigRevision,
  type EventConfig,
  type EventExperience,
} from "./event-config";
import type { StableCaptureIdentity, StableUpload } from "./upload-contract";
export { canonicalEvent, InvalidEventSlugError, slugifyEvent } from "./event-identity";
export { EVENT_CONFIG_VERSION };
export type { EventConfig } from "./event-config";
export const HEALTH_CANARY_KEY = "_health/canary";
const HEALTH_STATE_KEY = "health/statuspage.json";
const LEGACY_HEALTH_STATE_KEY = "_health/state.json";
const PAGE_SIZE = 1000;
const BOOTH_KEY_MUTATION_FINGERPRINT = /^[0-9a-f]{64}$/;

type StoredEventConfig = EventConfig & { version: typeof EVENT_CONFIG_VERSION };
type ConfigSaveInput = {
  config: EventConfig;
  baseRevisionId: string | null;
  mutationId: string;
  boothKeyMutationFingerprint?: string;
};
export type ConfigRestoreInput = {
  revisionId: string;
  baseRevisionId: string | null;
  mutationId: string;
};
type ConfigMutationIntent = {
  version: typeof EVENT_CONFIG_VERSION;
  config: EventExperience;
  baseRevisionId: string | null;
  boothKeyMutationFingerprint: string | null;
  reason: "save" | "restore";
  sourceRevisionId?: string;
};
type ConfigAppendInput = {
  config: EventConfig;
  baseRevisionId: string | null;
  mutationId: string;
  boothKeyMutationFingerprint: string | null;
  reason: "save" | "restore";
  sourceRevisionId?: string;
};

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
export const eventConfigMutationKey = (event: string, mutationId: string) =>
  `events/${event}/config-mutations/${mutationId}.json`;
export const legacyEventConfigKey = (event: string) => `_config/${event}.json`;
export const eventPhotoPrefix = (event: string) => `${event}/`;
export const stablePhotoKey = (event: string, id: StableCaptureIdentity) =>
  `${event}/${String(id.capturedAt).padStart(13, "0")}-${id.captureId}.jpg`;
export const photoReceiptKey = (event: string, key: string) =>
  `events/${event}/photo-metadata/${key.slice(eventPhotoPrefix(event).length)}.json`;
export const photoIndexKey = (event: string, key: string, sortTime: number) =>
  `events/${event}/photo-index/v1/${String(9_999_999_999_999 - sortTime).padStart(13, "0")}-${base64url(key)}.json`;

function photoTimestamp(key: string): number {
  const filename = key.slice(key.lastIndexOf("/") + 1);
  return Number(filename.split("-")[0]) || 0;
}

function isPhotoKey(event: string, key: string): boolean {
  return key.startsWith(eventPhotoPrefix(event)) && /\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i.test(key);
}

export type Photo = { key: string; url: string; uploadedAt: Date };
export type PhotoFeed = { photos: Photo[]; cursor: string | null; unchanged: boolean; truncated: boolean };
export type PutPhotoOptions = { upload?: StableUpload };
export type PutPhotoResult = {
  key: string;
  url: string;
  duplicate: boolean;
  receiptStored: boolean;
  indexStored: boolean;
};
export type ConfigMutationResult = {
  config: EventConfig;
  revision: ConfigRevision;
  idempotent: boolean;
};
export type ConfigHistory = {
  config: EventConfig | null;
  currentRevisionId: string | null;
  revisions: ConfigRevision[];
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

export class ConfigRevisionNotFoundError extends Error {
  constructor(readonly event: string, readonly revisionId: string) {
    super(`config revision ${revisionId} is not reachable for ${event}`);
  }
}

export class InvalidStoredConfigRevisionError extends Error {
  constructor(readonly event: string, readonly revisionId: string) {
    super(`stored config revision ${revisionId} for ${event} is corrupt or uses an unsupported version`);
  }
}

export class InvalidStoredEventConfigError extends Error {
  constructor(readonly event: string) {
    super(`stored config for ${event} is corrupt or uses an unsupported version`);
  }
}

export class PhotoIndexWriteError extends Error {
  constructor(
    readonly photo: Pick<PutPhotoResult, "key" | "url" | "duplicate">,
    options: { cause: unknown }
  ) {
    super("photo index write failed", options);
    this.name = "PhotoIndexWriteError";
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
      const current = await this.readPrivateConfig(event);
      if (current) return current;
    } catch (error) {
      if (error instanceof InvalidStoredEventConfigError) throw error;
      // During rollout, STATE may not exist yet. Legacy reads keep events live.
    }

    // Compatibility migration: old configs remain readable after STATE is introduced.
    const legacy = parseEventConfig(await this.readJson(this.photos, legacyEventConfigKey(event)));
    if (!legacy) return null;
    try {
      const migrated = await this.state.compareAndSwap(
        eventConfigKey(event),
        null,
        JSON.stringify({ version: EVENT_CONFIG_VERSION, ...legacy }),
        jsonWriteOptions()
      );
      if (migrated) return legacy;
      const current = await this.readPrivateConfig(event);
      if (current) return current;
    } catch (error) {
      if (error instanceof InvalidStoredEventConfigError) throw error;
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
    input: ConfigSaveInput
  ): Promise<ConfigMutationResult> {
    const boothKeyMutationFingerprint = validateConfigMutationInput(input);
    const requested = parseEventConfig({
      version: EVENT_CONFIG_VERSION,
      ...input.config,
      currentRevisionId: undefined,
    });
    if (!requested) throw new TypeError("invalid event configuration");
    return this.appendConfigRevision(event, {
      config: requested,
      baseRevisionId: input.baseRevisionId,
      mutationId: input.mutationId,
      boothKeyMutationFingerprint,
      reason: "save",
    });
  }

  async readConfigHistory(event: string): Promise<ConfigHistory> {
    const config = await this.readConfig(event);
    const currentRevisionId = config?.currentRevisionId ?? null;
    const revisions: ConfigRevision[] = [];
    const visited = new Set<string>();
    let revisionId = currentRevisionId;

    while (revisionId !== null) {
      if (visited.has(revisionId)) {
        throw new InvalidStoredConfigRevisionError(event, revisionId);
      }
      visited.add(revisionId);
      const revision = await this.readReachableRevision(event, revisionId);
      revisions.push(revision);
      revisionId = revision.parentRevisionId;
    }

    return { config, currentRevisionId, revisions };
  }

  async restoreConfigRevision(
    event: string,
    input: ConfigRestoreInput
  ): Promise<ConfigMutationResult> {
    validateConfigRestoreInput(input);
    const history = await this.readConfigHistory(event);
    const source = history.revisions.find((revision) => revision.id === input.revisionId);
    if (!source) throw new ConfigRevisionNotFoundError(event, input.revisionId);

    return this.appendConfigRevision(event, {
      config: source.config,
      baseRevisionId: input.baseRevisionId,
      mutationId: input.mutationId,
      boothKeyMutationFingerprint: null,
      reason: "restore",
      sourceRevisionId: source.id,
    });
  }

  private async appendConfigRevision(
    event: string,
    input: ConfigAppendInput
  ): Promise<ConfigMutationResult> {
    const requestedExperience = configExperience(input.config);
    const head = await this.readConfigHead(event);
    await this.ensureConfigMutationIntent(
      event,
      input.mutationId,
      requestedExperience,
      input.baseRevisionId,
      input.boothKeyMutationFingerprint,
      input.reason,
      input.sourceRevisionId
    );
    const existing = await this.readRevision(event, input.mutationId);

    if (existing) {
      await this.assertMatchingMutation(event, existing, requestedExperience, input);
      return this.finishExistingMutation(event, input, input.config, head, existing);
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
      reason: input.reason,
      ...(input.sourceRevisionId ? { sourceRevisionId: input.sourceRevisionId } : {}),
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
        input
      );
      return this.finishExistingMutation(event, input, input.config, head, racedRevision);
    }

    return this.advanceConfigHead(event, input.baseRevisionId, input.config, head, revision, false);
  }

  photoKey(event: string, now = Date.now(), suffix = randomSuffix()): string {
    return `${event}/${String(now).padStart(13, "0")}-${suffix}.jpg`;
  }

  async putPhoto(event: string, body: ArrayBuffer, options: PutPhotoOptions = {}): Promise<PutPhotoResult> {
    // Capture server time once: the immutable records for this attempt then
    // agree even when a retry completes a previously interrupted upload.
    const uploadedAt = this.now();
    const upload = options.upload;
    const key = upload ? stablePhotoKey(event, upload) : this.photoKey(event, uploadedAt.getTime());
    const url = this.publicUrl(key);
    let duplicate = false;

    if (upload) {
      const created = await this.photos.compareAndSwap(key, null, body, jpegWriteOptions());
      duplicate = !created;
    } else {
      // Legacy clients cannot retry the same public key. Keep their original
      // acknowledgment behavior even when private derived writes are down.
      await this.photos.put(key, body, jpegWriteOptions());
    }

    const photo = { key, url, duplicate };
    const metadata = photoPrivateMetadata(key, uploadedAt, upload);
    const indexKey = photoIndexKey(event, key, metadata.capturedAt);

    if (upload) {
      try {
        await this.state.compareAndSwap(indexKey, null, JSON.stringify(metadata), jsonWriteOptions());
      } catch (cause) {
        throw new PhotoIndexWriteError(photo, { cause });
      }
      const receiptStored = await this.tryWritePhotoReceipt(event, key, metadata);
      return { ...photo, indexStored: true, receiptStored };
    }

    const indexStored = await this.tryWritePhotoIndex(indexKey, metadata);
    const receiptStored = await this.tryWritePhotoReceipt(event, key, metadata);
    return { ...photo, indexStored, receiptStored };
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

  private async tryWritePhotoIndex(key: string, metadata: PrivatePhotoMetadata): Promise<boolean> {
    try {
      await this.state.compareAndSwap(key, null, JSON.stringify(metadata), jsonWriteOptions());
      return true;
    } catch {
      return false;
    }
  }

  private async tryWritePhotoReceipt(event: string, photoKey: string, metadata: PrivatePhotoMetadata): Promise<boolean> {
    try {
      await this.state.compareAndSwap(
        photoReceiptKey(event, photoKey),
        null,
        JSON.stringify(metadata),
        jsonWriteOptions()
      );
      return true;
    } catch {
      return false;
    }
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

  private async readPrivateConfig(event: string): Promise<EventConfig | null> {
    const object = await this.state.get(eventConfigKey(event));
    if (!object) return null;
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredEventConfigError(event);
    }
    const config = parseEventConfig(value);
    if (!config) throw new InvalidStoredEventConfigError(event);
    return config;
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

  private async ensureConfigMutationIntent(
    event: string,
    mutationId: string,
    config: EventExperience,
    baseRevisionId: string | null,
    boothKeyMutationFingerprint: string | null,
    reason: "save" | "restore",
    sourceRevisionId?: string
  ): Promise<void> {
    const intent: ConfigMutationIntent = {
      version: EVENT_CONFIG_VERSION,
      config,
      baseRevisionId,
      boothKeyMutationFingerprint,
      reason,
      ...(sourceRevisionId ? { sourceRevisionId } : {}),
    };
    const key = eventConfigMutationKey(event, mutationId);
    const created = await this.state.compareAndSwap(
      key,
      null,
      JSON.stringify(intent),
      jsonWriteOptions()
    );
    if (created) return;

    const existing = await this.state.get(key);
    if (!existing) throw new ConfigMutationConflictError();
    let value: unknown;
    try {
      value = await existing.json<unknown>();
    } catch {
      throw new ConfigMutationConflictError();
    }
    const parsed = parseConfigMutationIntent(value);
    if (
      !parsed
      || parsed.baseRevisionId !== baseRevisionId
      || parsed.boothKeyMutationFingerprint !== boothKeyMutationFingerprint
      || parsed.reason !== reason
      || parsed.sourceRevisionId !== sourceRevisionId
      || !sameExperience(parsed.config, config)
    ) {
      throw new ConfigMutationConflictError();
    }
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

  private async readReachableRevision(event: string, id: string): Promise<ConfigRevision> {
    const object = await this.state.get(eventConfigRevisionKey(event, id));
    if (!object) throw new InvalidStoredConfigRevisionError(event, id);
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredConfigRevisionError(event, id);
    }
    const revision = parseConfigRevision(value);
    if (!revision || revision.id !== id) {
      throw new InvalidStoredConfigRevisionError(event, id);
    }
    return revision;
  }

  private async assertMatchingMutation(
    event: string,
    revision: ConfigRevision,
    requested: EventExperience,
    input: ConfigAppendInput
  ): Promise<void> {
    if (
      revision.id !== input.mutationId
      || revision.reason !== input.reason
      || revision.sourceRevisionId !== input.sourceRevisionId
      || revision.sourcePresetId !== undefined
      || !sameExperience(revision.config, requested)
    ) {
      throw new ConfigMutationConflictError();
    }
    if (revision.parentRevisionId === input.baseRevisionId) return;
    if (input.baseRevisionId !== null || revision.parentRevisionId === null) {
      throw new ConfigMutationConflictError();
    }

    // A first save over an unrevisioned config receives an internal baseline
    // parent even though the caller's base remains null.
    const parent = await this.readRevision(event, revision.parentRevisionId);
    if (parent?.reason !== "baseline") throw new ConfigMutationConflictError();
  }

  private async finishExistingMutation(
    event: string,
    input: Pick<ConfigAppendInput, "baseRevisionId">,
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

function validateConfigMutationInput(input: ConfigSaveInput): string | null {
  if (!isRevisionId(input.mutationId)) throw new TypeError("mutationId must be a revision ID");
  if (input.baseRevisionId !== null && !isRevisionId(input.baseRevisionId)) {
    throw new TypeError("baseRevisionId must be a revision ID or null");
  }
  const hasBoothKeyHash = input.config.boothKeyHash !== undefined;
  const hasFingerprint = input.boothKeyMutationFingerprint !== undefined;
  if (hasBoothKeyHash !== hasFingerprint) {
    throw new TypeError("boothKeyMutationFingerprint must be supplied exactly when boothKeyHash is supplied");
  }
  if (
    input.boothKeyMutationFingerprint !== undefined
    && !BOOTH_KEY_MUTATION_FINGERPRINT.test(input.boothKeyMutationFingerprint)
  ) {
    throw new TypeError("boothKeyMutationFingerprint must be 64 lowercase hexadecimal characters");
  }
  return input.boothKeyMutationFingerprint ?? null;
}

function validateConfigRestoreInput(input: ConfigRestoreInput): void {
  if (!isRevisionId(input.revisionId)) throw new TypeError("revisionId must be a revision ID");
  if (!isRevisionId(input.mutationId)) throw new TypeError("mutationId must be a revision ID");
  if (input.baseRevisionId !== null && !isRevisionId(input.baseRevisionId)) {
    throw new TypeError("baseRevisionId must be a revision ID or null");
  }
}

function parseConfigMutationIntent(value: unknown): ConfigMutationIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  const reason = intent.reason;
  if (
    intent.version !== EVENT_CONFIG_VERSION
    || (reason !== "save" && reason !== "restore")
    || (
      reason === "save"
        ? Object.keys(intent).length !== 5 || "sourceRevisionId" in intent
        : Object.keys(intent).length !== 6 || !isRevisionId(intent.sourceRevisionId)
    )
    || (
      intent.baseRevisionId !== null
      && !isRevisionId(intent.baseRevisionId)
    )
    || (
      intent.boothKeyMutationFingerprint !== null
      && (
        typeof intent.boothKeyMutationFingerprint !== "string"
        || !BOOTH_KEY_MUTATION_FINGERPRINT.test(intent.boothKeyMutationFingerprint)
      )
    )
    || !intent.config
    || typeof intent.config !== "object"
    || Array.isArray(intent.config)
  ) {
    return null;
  }
  const rawConfig = intent.config as Record<string, unknown>;
  if (
    "version" in rawConfig
    || "boothKeyHash" in rawConfig
    || "currentRevisionId" in rawConfig
  ) {
    return null;
  }
  const parsed = parseEventConfig({ version: EVENT_CONFIG_VERSION, ...rawConfig });
  if (!parsed) return null;
  return {
    version: EVENT_CONFIG_VERSION,
    config: configExperience(parsed),
    baseRevisionId: intent.baseRevisionId as string | null,
    boothKeyMutationFingerprint: intent.boothKeyMutationFingerprint as string | null,
    reason,
    ...(reason === "restore" ? { sourceRevisionId: intent.sourceRevisionId as string } : {}),
  };
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

function jpegWriteOptions(): R2PutOptions {
  return { httpMetadata: { contentType: "image/jpeg" } };
}

type PrivatePhotoMetadata = {
  version: 1;
  key: string;
  uploadedAt: string;
  capturedAt: number;
  source?: StableUpload["source"];
  frameKey?: string;
  configRevisionId?: string;
};

function photoPrivateMetadata(key: string, uploadedAt: Date, upload?: StableUpload): PrivatePhotoMetadata {
  return {
    version: 1,
    key,
    uploadedAt: uploadedAt.toISOString(),
    capturedAt: upload?.capturedAt ?? uploadedAt.getTime(),
    ...(upload?.source ? { source: upload.source } : {}),
    ...(upload?.frameKey ? { frameKey: upload.frameKey } : {}),
    ...(upload?.configRevisionId ? { configRevisionId: upload.configRevisionId } : {}),
  };
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
