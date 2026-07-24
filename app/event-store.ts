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
import {
  EVENT_PRESET_VERSION,
  isPresetId,
  parseEventPreset,
  serializePresetExperience,
  validatePresetLabel,
  type EventPreset,
} from "./event-preset";
import {
  BOOTH_STALE_AFTER_MS,
  parseBoothHeartbeat,
  parseBoothHeartbeatRecord,
  parseBoothOperationalState,
  parseBoothOperationalStateInput,
  type AdminBoothRecord,
  type BoothHeartbeatInput,
  type BoothHeartbeatRecord,
  type BoothOperationalState,
  type BoothOperationalStateInput,
} from "./booth-control";
import { canonicalEvent, InvalidEventSlugError, slugifyEvent } from "./event-identity";
import type { StableCaptureIdentity, StableUpload } from "./upload-contract";
import {
  InvalidPhotoReceiptError,
  parsePhotoReceipt,
  type PhotoReceiptV1,
} from "./photo-metadata";
import {
  decodeModerationCursor,
  encodeModerationCursor,
  parseModerationPhotoRecord,
  type ModerationPhoto,
} from "./moderation";
export { canonicalEvent, InvalidEventSlugError, slugifyEvent };
export { EVENT_CONFIG_VERSION };
export type { EventConfig } from "./event-config";
export const HEALTH_CANARY_KEY = "_health/canary";
const HEALTH_STATE_KEY = "health/statuspage.json";
const LEGACY_HEALTH_STATE_KEY = "_health/state.json";
const PAGE_SIZE = 1000;
const BOOTH_KEY_MUTATION_FINGERPRINT = /^[0-9a-f]{64}$/;
const PHOTO_FEED_VERSION = 1 as const;
const PHOTO_FEED_APPEND_ATTEMPTS = 16;
const PHOTO_FEED_PAGE_SIZE = 1000;
const PHOTO_FEED_SEQUENCE_WIDTH = 16;

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
export type ConfigPresetApplyInput = {
  presetId: string;
  mutationId: string;
  baseRevisionId: string | null;
};
type ConfigMutationIntent = {
  version: typeof EVENT_CONFIG_VERSION;
  config: EventExperience;
  baseRevisionId: string | null;
  boothKeyMutationFingerprint: string | null;
  reason: "save" | "restore" | "preset";
  sourceRevisionId?: string;
  sourcePresetId?: string;
};
type ConfigAppendInput = {
  config: EventConfig;
  baseRevisionId: string | null;
  mutationId: string;
  boothKeyMutationFingerprint: string | null;
  reason: "save" | "restore" | "preset";
  sourceRevisionId?: string;
  sourcePresetId?: string;
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
export const boothHeartbeatKey = (event: string, deviceId: string) =>
  `events/${event}/booths/${deviceId}.json`;
export const boothHeartbeatPrefix = (event: string) => `events/${event}/booths/`;
export const boothOperationalStateKey = (event: string) =>
  `events/${event}/booth-state.json`;
export const eventPresetKey = (presetId: string) => {
  if (!isPresetId(presetId)) throw new TypeError("invalid preset ID");
  return `presets/${presetId}.json`;
};
export const eventPresetPrefix = () => "presets/";
const eventPresetIndexPrefix = () => `${eventPresetPrefix()}_index/v1/`;
function utf16Hex(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function decodeUtf16Hex(value: string): string | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    return null;
  }
  let decoded = "";
  for (let offset = 0; offset < value.length; offset += 4) {
    decoded += String.fromCharCode(Number.parseInt(value.slice(offset, offset + 4), 16));
  }
  return decoded;
}

export const eventPresetIndexKey = (
  presetId: string,
  label: string,
  updatedAt: string,
) => {
  if (!isPresetId(presetId)) throw new TypeError("invalid preset ID");
  validatePresetLabel(label);
  const updatedTime = Date.parse(updatedAt);
  if (
    !Number.isFinite(updatedTime)
    || new Date(updatedTime).toISOString() !== updatedAt
  ) {
    throw new TypeError("invalid preset timestamp");
  }
  return `${eventPresetIndexPrefix()}${utf16Hex(label)}/${presetId}/${utf16Hex(updatedAt)}.json`;
};
export const legacyEventConfigKey = (event: string) => `_config/${event}.json`;
export const eventPhotoPrefix = (event: string) => `${event}/`;
export const stablePhotoKey = (event: string, id: StableCaptureIdentity) =>
  `${event}/${String(id.capturedAt).padStart(13, "0")}-${id.captureId}.jpg`;
export const photoReceiptKey = (event: string, key: string) =>
  `events/${event}/photo-metadata/${key.slice(eventPhotoPrefix(event).length)}.json`;
export const photoIndexKey = (event: string, key: string, sortTime: number) =>
  `events/${event}/photo-index/v1/${String(9_999_999_999_999 - sortTime).padStart(13, "0")}-${base64url(key)}.json`;
export const photoIndexRebuildCheckpointKey = (event: string) =>
  `events/${event}/photo-index-rebuild/v1/checkpoint.json`;
export const photoIndexRebuildCompleteKey = (event: string) =>
  `events/${event}/photo-index-rebuild/v1/complete.json`;
export const photoFeedHeadKey = (event: string) => `events/${event}/photo-feed/v1/head.json`;
const photoFeedEntryKey = (event: string, key: string) =>
  `events/${event}/photo-feed/v1/entries/${base64url(key)}.json`;
export const photoFeedClaimKey = (event: string, key: string) =>
  `events/${event}/photo-feed/v1/claims/${base64url(key)}.json`;
export const photoFeedMarkerKey = (event: string, key: string) =>
  `events/${event}/photo-feed/v1/markers/${base64url(key)}.json`;
export const photoFeedCommittedKey = (event: string, sequence: number) =>
  `events/${event}/photo-feed/v1/committed/${String(sequence).padStart(PHOTO_FEED_SEQUENCE_WIDTH, "0")}.json`;
const photoFeedNodePrefix = (event: string) => `events/${event}/photo-feed/v1/nodes/`;
const photoFeedNodeKey = (event: string) =>
  `${photoFeedNodePrefix(event)}${crypto.randomUUID()}.json`;

function isPhotoKey(event: string, key: string): boolean {
  const prefix = eventPhotoPrefix(event);
  if (!key.startsWith(prefix)) return false;
  const filename = key.slice(prefix.length);
  return /^[^/\\?#]+\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i.test(filename);
}

export type Photo = { key: string; url: string; uploadedAt: Date };
export type PublicPhoto = { key: string; url: string; uploadedAt: string };
export type PhotoFeed = { photos: Photo[]; cursor: string | null; unchanged: boolean; truncated: boolean };
export type PutPhotoOptions = { upload?: StableUpload };
export type PutPhotoResult = {
  key: string;
  url: string;
  duplicate: boolean;
  receiptStored: boolean;
  indexStored: boolean;
};
export type DeletePhotoResult =
  | { deleted: false }
  | {
      deleted: true;
      cleanup: {
        index: "deleted" | "missing" | "failed";
        receipt: "deleted" | "missing" | "failed";
      };
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
export type BoothHeartbeatListOptions = { cursor?: string | null; limit?: number };
export type BoothHeartbeatPage = { booths: AdminBoothRecord[]; cursor: string | null };
export type ExportPhotoSource = {
  key: string;
  size: number;
  uploadedAt: string;
  receipt: Pick<PhotoReceiptV1, "capturedAt" | "source" | "frameKey"> | null;
};
export type ModerationPhotoPage = { photos: ModerationPhoto[]; nextCursor: string | null };
export type PhotoIndexRebuildResult = {
  complete: boolean;
  scanned: number;
  indexed: number;
  checkpoint: string | null;
};
export type EventPresetListOptions = { cursor?: string; limit?: number };
export type EventPresetPage = { presets: EventPreset[]; cursor: string | null };
export type PutEventPresetInput = {
  label: string;
  config: EventExperience;
  expectedUpdatedAt: string | null;
};

const EVENT_PRESET_CURSOR_PREFIX = "preset-v1:";

function parseEventPresetIndexKey(
  key: string,
): Pick<EventPreset, "label" | "id" | "updatedAt"> | null {
  const prefix = eventPresetIndexPrefix();
  if (!key.startsWith(prefix)) return null;
  const match = /^([0-9a-f]+)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([0-9a-f]+)\.json$/.exec(
    key.slice(prefix.length),
  );
  if (!match) return null;
  const label = decodeUtf16Hex(match[1]!);
  const updatedAt = decodeUtf16Hex(match[3]!);
  if (label === null || updatedAt === null) return null;
  try {
    validatePresetLabel(label);
  } catch {
    return null;
  }
  const id = match[2]!;
  try {
    return eventPresetIndexKey(id, label, updatedAt) === key
      ? { label, id, updatedAt }
      : null;
  } catch {
    return null;
  }
}

function encodeEventPresetCursor(afterIndexKey: string): string {
  return `${EVENT_PRESET_CURSOR_PREFIX}${afterIndexKey}`;
}

function parseEventPresetCursor(value: string): string {
  if (!value.startsWith(EVENT_PRESET_CURSOR_PREFIX)) {
    throw new TypeError("preset cursor is invalid");
  }
  const afterIndexKey = value.slice(EVENT_PRESET_CURSOR_PREFIX.length);
  if (!parseEventPresetIndexKey(afterIndexKey)) {
    throw new TypeError("preset cursor is invalid");
  }
  return afterIndexKey;
}

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

export class InvalidStoredEventPresetError extends Error {
  constructor(readonly presetId: string) {
    super(`stored Event preset ${presetId} is corrupt or uses an unsupported version`);
  }
}

export class PresetConflictError extends Error {
  constructor(
    readonly presetId: string,
    readonly expectedUpdatedAt: string | null,
    readonly currentUpdatedAt: string | null,
  ) {
    super("Event preset changed");
  }
}

export class EventPresetNotFoundError extends Error {
  constructor(readonly presetId: string) {
    super(`Event preset ${presetId} was not found`);
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

export class InvalidPhotoCursorError extends Error {
  constructor() {
    super("photo feed cursor is invalid for this Event");
  }
}

export class InvalidPublicPhotoKeyError extends TypeError {
  constructor() {
    super("public photo key must be an exact Event-owned image key");
  }
}

export class InvalidStoredModerationPhotoError extends Error {
  constructor(readonly event: string, readonly indexKey: string) {
    super(`stored moderation photo for ${event} is corrupt or uses an unsupported version`);
  }
}

export class InvalidPhotoIndexRebuildStateError extends Error {
  constructor(readonly event: string) {
    super(`photo index rebuild state for ${event} is corrupt or uses an unsupported version`);
  }
}

export class InvalidStoredBoothHeartbeatError extends Error {
  constructor(readonly event: string) {
    super(`stored booth heartbeat for ${event} is corrupt or uses an unsupported version`);
  }
}

export class InvalidStoredBoothOperationalStateError extends Error {
  constructor(readonly event: string) {
    super(`stored booth operational state for ${event} is corrupt or uses an unsupported version`);
  }
}

class InvalidStoredPhotoFeedError extends Error {
  constructor(readonly event: string) {
    super(`photo feed state for ${event} is corrupt or uses an unsupported version`);
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

  async getEventPreset(presetId: string): Promise<EventPreset | null> {
    const key = eventPresetKey(presetId);
    const object = await this.state.get(key);
    if (!object) return null;
    return this.readEventPresetObject(presetId, object);
  }

  async listEventPresets(
    options: EventPresetListOptions = {},
  ): Promise<EventPresetPage> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("preset limit must be an integer from 1 to 100");
    }
    if (
      options.cursor !== undefined
      && (typeof options.cursor !== "string" || options.cursor.length === 0)
    ) {
      throw new TypeError("preset cursor is invalid");
    }
    const afterIndexKey = options.cursor === undefined
      ? undefined
      : parseEventPresetCursor(options.cursor);
    const page = await this.state.list({
      prefix: eventPresetIndexPrefix(),
      ...(afterIndexKey !== undefined ? { startAfter: afterIndexKey } : {}),
      limit,
    });
    const presets: EventPreset[] = [];
    let lastScannedKey: string | null = null;
    for (const listed of page.objects) {
      lastScannedKey = listed.key;
      const index = parseEventPresetIndexKey(listed.key);
      if (!index) throw new InvalidStoredEventPresetError(listed.key);
      const object = await this.state.get(eventPresetKey(index.id));
      if (!object) continue;
      const preset = await this.readEventPresetObject(index.id, object);
      if (
        preset.label === index.label
        && preset.updatedAt === index.updatedAt
      ) {
        presets.push(preset);
      }
    }
    return {
      presets,
      cursor: page.truncated && lastScannedKey !== null
        ? encodeEventPresetCursor(lastScannedKey)
        : null,
    };
  }

  async putEventPreset(
    presetId: string,
    input: PutEventPresetInput,
  ): Promise<EventPreset> {
    const key = eventPresetKey(presetId);
    const label = validatePresetLabel(input.label);
    const config = serializePresetExperience(input.config);
    if (
      input.expectedUpdatedAt !== null
      && (
        typeof input.expectedUpdatedAt !== "string"
        || !Number.isFinite(Date.parse(input.expectedUpdatedAt))
      )
    ) {
      throw new TypeError("expected preset timestamp is invalid");
    }

    const currentObject = await this.state.get(key);
    const current = currentObject
      ? await this.readEventPresetObject(presetId, currentObject)
      : null;
    if (
      (input.expectedUpdatedAt === null && current !== null)
      || (
        input.expectedUpdatedAt !== null
        && current?.updatedAt !== input.expectedUpdatedAt
      )
    ) {
      throw new PresetConflictError(
        presetId,
        input.expectedUpdatedAt,
        current?.updatedAt ?? null,
      );
    }

    const serverTime = this.nextPresetTimestamp(current?.updatedAt ?? null);
    const preset: EventPreset = {
      version: EVENT_PRESET_VERSION,
      id: presetId,
      label,
      createdAt: current?.createdAt ?? serverTime,
      updatedAt: serverTime,
      config,
    };
    const indexKey = eventPresetIndexKey(presetId, label, preset.updatedAt);
    await this.state.put(
      indexKey,
      JSON.stringify({
        version: EVENT_PRESET_VERSION,
        id: presetId,
        label,
        updatedAt: preset.updatedAt,
      }),
      jsonWriteOptions(),
    );
    const written = await this.state.compareAndSwap(
      key,
      currentObject?.etag ?? null,
      JSON.stringify(preset),
      jsonWriteOptions(),
    );
    if (!written) {
      const raced = await this.getEventPreset(presetId);
      if (raced?.label !== label) {
        try {
          await this.state.delete(indexKey);
        } catch {
          // A stale private index entry is harmless and bounded list paging
          // skips it after checking the authoritative preset.
        }
      }
      throw new PresetConflictError(
        presetId,
        input.expectedUpdatedAt,
        raced?.updatedAt ?? null,
      );
    }
    if (current) {
      try {
        await this.state.delete(
          eventPresetIndexKey(presetId, current.label, current.updatedAt),
        );
      } catch {
        // The new authoritative preset and index are already durable. A stale
        // exact index entry is skipped by listEventPresets.
      }
    }
    return preset;
  }

  private async readEventPresetObject(
    presetId: string,
    object: StoredObjectBody,
  ): Promise<EventPreset> {
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredEventPresetError(presetId);
    }
    const preset = parseEventPreset(value);
    if (!preset || preset.id !== presetId) {
      throw new InvalidStoredEventPresetError(presetId);
    }
    return preset;
  }

  private nextPresetTimestamp(previous: string | null): string {
    const serverNow = this.now().getTime();
    const previousTime = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous);
    return new Date(Math.max(serverNow, previousTime + 1)).toISOString();
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

  async applyEventPreset(
    event: string,
    input: ConfigPresetApplyInput,
  ): Promise<ConfigMutationResult> {
    if (
      !isPresetId(input.presetId)
      || !isRevisionId(input.mutationId)
      || (input.baseRevisionId !== null && !isRevisionId(input.baseRevisionId))
    ) {
      throw new TypeError("invalid preset application");
    }
    const preset = await this.getEventPreset(input.presetId);
    if (!preset) throw new EventPresetNotFoundError(input.presetId);
    return this.appendConfigRevision(canonicalEvent(event), {
      config: preset.config,
      baseRevisionId: input.baseRevisionId,
      mutationId: input.mutationId,
      boothKeyMutationFingerprint: null,
      reason: "preset",
      sourcePresetId: preset.id,
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
      input.sourceRevisionId,
      input.sourcePresetId,
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
      ...(input.sourcePresetId ? { sourcePresetId: input.sourcePresetId } : {}),
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
    // Capture server time once for a newly-created public object. A duplicate
    // must read the public object's immutable uploaded timestamp instead of
    // turning a delayed index repair into a false new arrival.
    const attemptedAt = this.now();
    const upload = options.upload;
    const key = upload ? stablePhotoKey(event, upload) : this.photoKey(event, attemptedAt.getTime());
    const url = this.publicUrl(key);
    let duplicate = false;
    let uploadedAt = attemptedAt;

    if (upload) {
      const created = await this.photos.compareAndSwap(key, null, body, jpegWriteOptions());
      duplicate = !created;
      try {
        const original = await this.photos.get(key);
        // R2 is authoritative for immutable upload time after either a fresh
        // conditional create or a lost-ack retry. Never invent retry-time
        // metadata when the public object cannot be observed.
        if (!original) throw new PhotoIndexWriteError({ key, url, duplicate }, { cause: new Error("stable photo missing") });
        uploadedAt = original.uploaded;
      } catch (cause) {
        if (cause instanceof PhotoIndexWriteError) throw cause;
        throw new PhotoIndexWriteError({ key, url, duplicate }, { cause });
      }
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
        await this.ensurePhotoFeedRecord(event, key, metadata);
      } catch (cause) {
        throw new PhotoIndexWriteError(photo, { cause });
      }
      const receiptStored = await this.tryWritePhotoReceipt(event, key, metadata);
      return { ...photo, indexStored: true, receiptStored };
    }

    const indexStored = await this.tryWritePhotoIndex(indexKey, metadata);
    await this.tryWritePhotoFeedRecord(event, key, metadata);
    const receiptStored = await this.tryWritePhotoReceipt(event, key, metadata);
    return { ...photo, indexStored, receiptStored };
  }

  async writeBoothHeartbeat(event: string, input: BoothHeartbeatInput): Promise<BoothHeartbeatRecord> {
    const canonical = canonicalEvent(event);
    const heartbeat = parseBoothHeartbeat(input);
    if (!heartbeat) throw new TypeError("invalid booth heartbeat");
    const record: BoothHeartbeatRecord = { ...heartbeat, lastSeenAt: this.now().toISOString() };
    await this.state.put(boothHeartbeatKey(canonical, record.deviceId), JSON.stringify(record), jsonWriteOptions());
    return record;
  }

  async listBoothHeartbeats(
    event: string,
    options: BoothHeartbeatListOptions = {}
  ): Promise<BoothHeartbeatPage> {
    const canonical = canonicalEvent(event);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("booth heartbeat limit must be an integer from 1 to 100");
    }
    const cursor = options.cursor ?? undefined;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0)) {
      throw new TypeError("booth heartbeat cursor is invalid");
    }
    const page = await this.state.list({
      prefix: boothHeartbeatPrefix(canonical),
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });
    const now = this.now().getTime();
    const booths = await Promise.all(page.objects.map(async (object): Promise<AdminBoothRecord> => {
      const record = await this.readBoothHeartbeat(canonical, object.key);
      return {
        ...record,
        stale: now - Date.parse(record.lastSeenAt) >= BOOTH_STALE_AFTER_MS,
      };
    }));
    return { booths, cursor: page.truncated ? page.cursor ?? null : null };
  }

  async readBoothOperationalState(event: string): Promise<BoothOperationalState> {
    const canonical = canonicalEvent(event);
    const object = await this.state.get(boothOperationalStateKey(canonical));
    if (!object) {
      return { version: 1, paused: false, updatedAt: this.now().toISOString() };
    }
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredBoothOperationalStateError(canonical);
    }
    const state = parseBoothOperationalState(value);
    if (!state) throw new InvalidStoredBoothOperationalStateError(canonical);
    return state;
  }

  async writeBoothOperationalState(
    event: string,
    input: BoothOperationalStateInput
  ): Promise<BoothOperationalState> {
    const canonical = canonicalEvent(event);
    const operational = parseBoothOperationalStateInput(input);
    if (!operational) throw new TypeError("invalid booth operational state");
    const state: BoothOperationalState = {
      version: 1,
      ...operational,
      updatedAt: this.now().toISOString(),
    };
    await this.state.put(boothOperationalStateKey(canonical), JSON.stringify(state), jsonWriteOptions());
    return state;
  }

  async listPhotos(event: string, after: string | null = null): Promise<PhotoFeed> {
    if (after === null) return this.initialPhotoFeed(event);
    if (isPhotoKey(event, after)) {
      // One-release compatibility bridge: a Gallery already open during the
      // deploy may still hold the former raw complete-key cursor. Rebase it
      // through one safe initial snapshot and return the new sequence cursor.
      // Structural ownership is sufficient: moderation may already have
      // deleted the exact photo while that Gallery still held its old cursor.
      return this.initialPhotoFeed(event);
    }
    return this.incrementalPhotoFeed(event, parsePhotoFeedCursor(event, after));
  }

  /**
   * The initial scan remains the compatibility path for photos created before
   * the private arrival feed existed. Capture the sequence waterline first.
   * A photo racing the public scan may also arrive in the immediate delta;
   * clients already deduplicate exact keys, while omission would risk a miss.
   */
  private async initialPhotoFeed(event: string): Promise<PhotoFeed> {
    const waterline = await this.readPhotoFeedHead(event);
    await this.ensurePhotoFeedHeadCommitted(event, waterline.head);
    const visible = (await this.listEventPhotoObjects(event)).sort(newestPublicObjectFirst);

    return {
      photos: visible.map((object) => this.toPhoto(object)),
      cursor: encodePhotoFeedCursor(event, waterline.head.sequence),
      unchanged: visible.length === 0,
      truncated: false,
    };
  }

  /** Deltas read a bounded contiguous sequence page and exact public images. */
  private async incrementalPhotoFeed(event: string, cursor: PhotoFeedCursor): Promise<PhotoFeed> {
    const current = await this.readPhotoFeedHead(event);
    await this.ensurePhotoFeedHeadCommitted(event, current.head);
    if (cursor.sequence > current.head.sequence) throw new InvalidPhotoCursorError();
    let previous = await this.validatePhotoFeedCursorProof(event, cursor.sequence, current.head);
    let advancedSequence = cursor.sequence;
    const photos: Photo[] = [];
    const upperSequence = Math.min(
      current.head.sequence,
      cursor.sequence + PHOTO_FEED_PAGE_SIZE
    );

    for (let sequence = cursor.sequence + 1; sequence <= upperSequence; sequence += 1) {
      const committed = await this.readPhotoFeedCommitted(event, sequence);
      // Head CAS happens before the exact committed record. Never advance
      // across that short repair window or a later repair would be skipped.
      if (!committed) break;
      const { entry, node } = await this.validateCommittedArrival(event, committed);
      if (
        (previous === null && node.previousNodeKey !== null)
        || (previous !== null && node.previousNodeKey !== previous.nodeKey)
      ) {
        throw new InvalidStoredPhotoFeedError(event);
      }
      const object = await this.photos.get(entry.key);
      if (object && isPhotoKey(event, object.key)) photos.push(this.toPhoto(object));
      advancedSequence = sequence;
      previous = committed;
    }

    photos.reverse();
    return {
      photos,
      cursor: encodePhotoFeedCursor(event, advancedSequence),
      unchanged: photos.length === 0,
      truncated: advancedSequence < current.head.sequence,
    };
  }

  private toPhoto(object: StoredObject): Photo {
    return { key: object.key, url: this.publicUrl(object.key), uploadedAt: object.uploaded };
  }

  private async listEventPhotoObjects(event: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.photos.list({ prefix: eventPhotoPrefix(event), cursor, limit: PAGE_SIZE });
      objects.push(...page.objects.filter((object) => isPhotoKey(event, object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }

  /**
   * Creates one immutable entry per public key, then claims an exact candidate
   * node before it can CAS the Event head. The mutable per-photo claim lets
   * concurrent duplicates and crash retries finalize or replace that exact
   * candidate without walking the linked history.
   */
  private async ensurePhotoFeedRecord(
    event: string,
    key: string,
    metadata: PrivatePhotoMetadata
  ): Promise<void> {
    const entryKey = photoFeedEntryKey(event, key);
    const entry: PrivatePhotoFeedEntry = { version: PHOTO_FEED_VERSION, key, metadata };
    const entryCreated = await this.state.compareAndSwap(
      entryKey,
      null,
      JSON.stringify(entry),
      jsonWriteOptions()
    );
    if (!entryCreated) {
      const existing = await this.readPhotoFeedEntry(event, entryKey);
      if (existing.key !== key || !samePrivatePhotoMetadata(existing.metadata, metadata)) {
        throw new InvalidStoredPhotoFeedError(event);
      }
    }

    if (await this.hasValidPhotoFeedMarker(event, key, entryKey)) return;

    for (let attempt = 0; attempt < PHOTO_FEED_APPEND_ATTEMPTS; attempt += 1) {
      const head = await this.readPhotoFeedHead(event);
      await this.ensurePhotoFeedHeadCommitted(event, head.head);
      if (await this.hasValidPhotoFeedMarker(event, key, entryKey)) return;

      let existingClaim = await this.readPhotoFeedClaim(event, key, entryKey);
      if (!existingClaim) {
        const candidate = this.photoFeedClaimForHead(event, entryKey, head.head);
        const claimed = await this.state.compareAndSwap(
          photoFeedClaimKey(event, key),
          null,
          JSON.stringify(candidate),
          jsonWriteOptions()
        );
        if (!claimed) continue;
        // The claim is durable before either its node or the Event head.
        // Finalize it in this same logical attempt; a crash after the claim
        // remains recoverable by the next caller reading this exact record.
        const outcome = await this.finalizePhotoFeedClaim(event, key, entry, candidate);
        if (outcome === "committed") return;
        if (outcome === "retry") continue;
        existingClaim = await this.readPhotoFeedClaim(event, key, entryKey);
        if (!existingClaim || !samePhotoFeedClaim(existingClaim.claim, candidate)) continue;
      } else {
        const outcome = await this.finalizePhotoFeedClaim(
          event,
          key,
          entry,
          existingClaim.claim
        );
        if (outcome === "committed") return;
        if (outcome === "retry") continue;
      }

      const current = await this.readPhotoFeedHead(event);
      await this.ensurePhotoFeedHeadCommitted(event, current.head);
      if (await this.hasValidPhotoFeedMarker(event, key, entryKey)) return;
      const replacement = this.photoFeedClaimForHead(event, entryKey, current.head);
      const replaced = await this.state.compareAndSwap(
        photoFeedClaimKey(event, key),
        existingClaim.etag,
        JSON.stringify(replacement),
        jsonWriteOptions()
      );
      if (!replaced) continue;
      const replacementOutcome = await this.finalizePhotoFeedClaim(
        event,
        key,
        entry,
        replacement
      );
      if (replacementOutcome === "committed") return;
    }
    throw new Error("photo feed append contention exceeded retry budget");
  }

  private photoFeedClaimForHead(
    event: string,
    entryKey: string,
    head: PrivatePhotoFeedHead
  ): PrivatePhotoFeedClaim {
    return {
      version: PHOTO_FEED_VERSION,
      entryKey,
      nodeKey: photoFeedNodeKey(event),
      sequence: head.sequence + 1,
      previousNodeKey: head.nodeKey,
    };
  }

  private async finalizePhotoFeedClaim(
    event: string,
    key: string,
    entry: PrivatePhotoFeedEntry,
    claim: PrivatePhotoFeedClaim
  ): Promise<"committed" | "stale" | "retry"> {
    const head = await this.readPhotoFeedHead(event);

    if (head.head.sequence === claim.sequence && head.head.nodeKey === claim.nodeKey) {
      const node = await this.readClaimedPhotoFeedNode(event, claim);
      await this.writePhotoFeedCommitted(event, claim.nodeKey, node, entry);
      await this.writePhotoFeedMarker(event, key, claim.sequence);
      return "committed";
    }

    if (
      head.head.sequence === claim.sequence - 1
      && head.head.nodeKey === claim.previousNodeKey
    ) {
      const node = await this.ensureClaimedPhotoFeedNode(event, claim);
      const advanced = await this.state.compareAndSwap(
        photoFeedHeadKey(event),
        head.etag,
        JSON.stringify({
          version: PHOTO_FEED_VERSION,
          sequence: claim.sequence,
          nodeKey: claim.nodeKey,
        }),
        jsonWriteOptions()
      );
      if (!advanced) return "retry";
      await this.writePhotoFeedCommitted(event, claim.nodeKey, node, entry);
      await this.writePhotoFeedMarker(event, key, claim.sequence);
      return "committed";
    }

    if (head.head.sequence < claim.sequence) {
      throw new InvalidStoredPhotoFeedError(event);
    }

    const committed = await this.readPhotoFeedCommitted(event, claim.sequence);
    if (
      committed
      && committed.key === key
      && committed.entryKey === claim.entryKey
      && committed.nodeKey === claim.nodeKey
    ) {
      await this.validateCommittedArrival(event, committed);
      await this.writePhotoFeedMarker(event, key, claim.sequence);
      return "committed";
    }
    return "stale";
  }

  private async ensureClaimedPhotoFeedNode(
    event: string,
    claim: PrivatePhotoFeedClaim
  ): Promise<PrivatePhotoFeedNode> {
    const node = photoFeedNodeFromClaim(claim);
    const created = await this.state.compareAndSwap(
      claim.nodeKey,
      null,
      JSON.stringify(node),
      jsonWriteOptions()
    );
    if (created) return node;
    const existing = await this.readClaimedPhotoFeedNode(event, claim);
    if (!samePhotoFeedNode(existing, node)) throw new InvalidStoredPhotoFeedError(event);
    return existing;
  }

  private async readClaimedPhotoFeedNode(
    event: string,
    claim: PrivatePhotoFeedClaim
  ): Promise<PrivatePhotoFeedNode> {
    const node = await this.readPhotoFeedNode(event, claim.nodeKey);
    if (!samePhotoFeedNode(node, photoFeedNodeFromClaim(claim))) {
      throw new InvalidStoredPhotoFeedError(event);
    }
    return node;
  }

  private async tryWritePhotoFeedRecord(
    event: string,
    key: string,
    metadata: PrivatePhotoMetadata
  ): Promise<boolean> {
    try {
      await this.ensurePhotoFeedRecord(event, key, metadata);
      return true;
    } catch {
      return false;
    }
  }

  private async readPhotoFeedHead(event: string): Promise<{ head: PrivatePhotoFeedHead; etag: string | null }> {
    const object = await this.state.get(photoFeedHeadKey(event));
    if (!object) {
      return { head: { version: PHOTO_FEED_VERSION, sequence: 0, nodeKey: null }, etag: null };
    }
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const head = parsePhotoFeedHead(event, value);
    if (!head) throw new InvalidStoredPhotoFeedError(event);
    return { head, etag: object.etag };
  }

  private async readPhotoFeedEntry(event: string, entryKey: string): Promise<PrivatePhotoFeedEntry> {
    if (!entryKey.startsWith(`events/${event}/photo-feed/v1/entries/`)) {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const object = await this.state.get(entryKey);
    if (!object) throw new InvalidStoredPhotoFeedError(event);
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const entry = parsePhotoFeedEntry(event, value);
    if (!entry) throw new InvalidStoredPhotoFeedError(event);
    return entry;
  }

  private async readPhotoFeedClaim(
    event: string,
    key: string,
    entryKey: string
  ): Promise<{ claim: PrivatePhotoFeedClaim; etag: string } | null> {
    const object = await this.state.get(photoFeedClaimKey(event, key));
    if (!object) return null;
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const claim = parsePhotoFeedClaim(event, value);
    if (!claim || claim.entryKey !== entryKey) throw new InvalidStoredPhotoFeedError(event);
    return { claim, etag: object.etag };
  }

  private async readPhotoFeedNode(event: string, nodeKey: string): Promise<PrivatePhotoFeedNode> {
    if (!nodeKey.startsWith(photoFeedNodePrefix(event))) throw new InvalidStoredPhotoFeedError(event);
    const object = await this.state.get(nodeKey);
    if (!object) throw new InvalidStoredPhotoFeedError(event);
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const node = parsePhotoFeedNode(event, value);
    if (!node) throw new InvalidStoredPhotoFeedError(event);
    return node;
  }

  private async readPhotoFeedMarker(event: string, key: string): Promise<PrivatePhotoFeedMarker | null> {
    const object = await this.state.get(photoFeedMarkerKey(event, key));
    if (!object) return null;
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const marker = parsePhotoFeedMarker(value);
    if (!marker) throw new InvalidStoredPhotoFeedError(event);
    return marker;
  }

  private async readPhotoFeedCommitted(
    event: string,
    sequence: number
  ): Promise<PrivatePhotoFeedCommitted | null> {
    const object = await this.state.get(photoFeedCommittedKey(event, sequence));
    if (!object) return null;
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const committed = parsePhotoFeedCommitted(event, value);
    if (!committed || committed.sequence !== sequence) throw new InvalidStoredPhotoFeedError(event);
    return committed;
  }

  private async writePhotoFeedMarker(event: string, key: string, sequence: number): Promise<void> {
    const created = await this.state.compareAndSwap(
      photoFeedMarkerKey(event, key),
      null,
      JSON.stringify({ version: PHOTO_FEED_VERSION, sequence }),
      jsonWriteOptions()
    );
    if (created) return;
    const existing = await this.readPhotoFeedMarker(event, key);
    if (existing?.sequence !== sequence) throw new InvalidStoredPhotoFeedError(event);
  }

  private async writePhotoFeedCommitted(
    event: string,
    nodeKey: string,
    node: PrivatePhotoFeedNode,
    entry: PrivatePhotoFeedEntry
  ): Promise<PrivatePhotoFeedCommitted> {
    const committed: PrivatePhotoFeedCommitted = {
      version: PHOTO_FEED_VERSION,
      sequence: node.sequence,
      key: entry.key,
      entryKey: node.entryKey,
      nodeKey,
    };
    const created = await this.state.compareAndSwap(
      photoFeedCommittedKey(event, node.sequence),
      null,
      JSON.stringify(committed),
      jsonWriteOptions()
    );
    if (created) return committed;
    const existing = await this.readPhotoFeedCommitted(event, node.sequence);
    if (!existing || !samePhotoFeedCommitted(existing, committed)) {
      throw new InvalidStoredPhotoFeedError(event);
    }
    return existing;
  }

  private async validateCommittedArrival(
    event: string,
    committed: PrivatePhotoFeedCommitted
  ): Promise<{ node: PrivatePhotoFeedNode; entry: PrivatePhotoFeedEntry }> {
    if (committed.entryKey !== photoFeedEntryKey(event, committed.key)) {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const node = await this.readPhotoFeedNode(event, committed.nodeKey);
    if (node.sequence !== committed.sequence || node.entryKey !== committed.entryKey) {
      throw new InvalidStoredPhotoFeedError(event);
    }
    const entry = await this.readPhotoFeedEntry(event, committed.entryKey);
    if (entry.key !== committed.key) throw new InvalidStoredPhotoFeedError(event);
    return { node, entry };
  }

  private async validatePhotoFeedCursorProof(
    event: string,
    sequence: number,
    head: PrivatePhotoFeedHead
  ): Promise<PrivatePhotoFeedCommitted | null> {
    if (sequence === 0) return null;
    try {
      const committed = await this.readPhotoFeedCommitted(event, sequence);
      if (!committed) throw new InvalidPhotoCursorError();
      await this.validateCommittedArrival(event, committed);
      if (sequence === head.sequence) {
        if (head.nodeKey !== committed.nodeKey) throw new InvalidPhotoCursorError();
      } else {
        const successor = await this.readPhotoFeedCommitted(event, sequence + 1);
        // A head CAS may be visible just before its exact successor commit.
        // The caller's prior committed record is still valid; paging below
        // must stop at the gap without invalidating or advancing its cursor.
        if (successor) {
          const { node } = await this.validateCommittedArrival(event, successor);
          if (node.previousNodeKey !== committed.nodeKey) throw new InvalidPhotoCursorError();
        }
      }
      return committed;
    } catch (error) {
      if (error instanceof InvalidPhotoCursorError) throw error;
      throw new InvalidPhotoCursorError();
    }
  }

  private async hasValidPhotoFeedMarker(event: string, key: string, entryKey: string): Promise<boolean> {
    const marker = await this.readPhotoFeedMarker(event, key);
    if (!marker) return false;
    const head = await this.readPhotoFeedHead(event);
    if (marker.sequence > head.head.sequence) return false;
    const committed = await this.readPhotoFeedCommitted(event, marker.sequence);
    if (!committed || committed.key !== key || committed.entryKey !== entryKey) return false;
    await this.validateCommittedArrival(event, committed);
    if (marker.sequence === head.head.sequence) return head.head.nodeKey === committed.nodeKey;
    const successor = await this.readPhotoFeedCommitted(event, marker.sequence + 1);
    if (!successor) return false;
    const { node: successorNode } = await this.validateCommittedArrival(event, successor);
    return successorNode.previousNodeKey === committed.nodeKey;
  }

  private async ensurePhotoFeedHeadCommitted(event: string, head: PrivatePhotoFeedHead): Promise<void> {
    if (head.sequence === 0) return;
    if (!head.nodeKey) throw new InvalidStoredPhotoFeedError(event);
    const node = await this.readPhotoFeedNode(event, head.nodeKey);
    if (node.sequence !== head.sequence) throw new InvalidStoredPhotoFeedError(event);
    const entry = await this.readPhotoFeedEntry(event, node.entryKey);
    await this.writePhotoFeedCommitted(event, head.nodeKey, node, entry);
    await this.writePhotoFeedMarker(event, entry.key, node.sequence);
  }

  async listModerationPhotos(
    event: string,
    options: {
      cursor?: string;
      limit?: number;
      from?: number;
      to?: number;
    }
  ): Promise<ModerationPhotoPage> {
    const canonical = canonicalEvent(event);
    const limit = options.limit ?? 48;
    const from = options.from ?? null;
    const to = options.to ?? null;
    if (
      !Number.isInteger(limit)
      || limit < 1
      || limit > 100
      || !isNullableSafeTimestamp(from)
      || !isNullableSafeTimestamp(to)
      || (from !== null && to !== null && from > to)
    ) {
      throw new TypeError("invalid moderation page options");
    }
    const decoded = options.cursor === undefined
      ? null
      : decodeModerationCursor(options.cursor, { event: canonical, from, to });
    const prefix = `events/${canonical}/photo-index/v1/`;
    let startAfter = decoded?.afterIndexKey;
    let exhausted = false;
    let lastScanned: string | null = startAfter ?? null;
    const seen = new Set<string>();
    const photos: ModerationPhoto[] = [];

    while (photos.length < limit && !exhausted) {
      const page = await this.state.list({
        prefix,
        ...(startAfter ? { startAfter } : {}),
        limit: Math.max(1, limit - photos.length),
      });
      if (page.objects.length === 0) {
        if (page.truncated) throw new InvalidStoredModerationPhotoError(canonical, startAfter ?? prefix);
        exhausted = true;
        break;
      }
      for (const object of page.objects) {
        lastScanned = object.key;
        startAfter = object.key;
        const stored = await this.state.get(object.key);
        if (!stored) continue;
        let value: unknown;
        try {
          value = await stored.json<unknown>();
        } catch {
          throw new InvalidStoredModerationPhotoError(canonical, object.key);
        }
        const record = parseModerationPhotoRecord(canonical, value);
        if (!record) throw new InvalidStoredModerationPhotoError(canonical, object.key);
        if (
          seen.has(record.key)
          || (from !== null && record.capturedAt < from)
          || (to !== null && record.capturedAt > to)
        ) {
          continue;
        }
        seen.add(record.key);
        const publicPhoto = await this.photos.get(record.key);
        if (!publicPhoto || !isPhotoKey(canonical, publicPhoto.key)) continue;
        photos.push({ ...record, url: this.publicUrl(record.key) });
        if (photos.length === limit) break;
      }
      exhausted = !page.truncated;
    }

    return {
      photos,
      nextCursor: !exhausted && lastScanned
        ? encodeModerationCursor({
            version: 1,
            event: canonical,
            afterIndexKey: lastScanned,
            from,
            to,
          })
        : null,
    };
  }

  async rebuildPhotoIndex(
    event: string,
    options: { batchSize: number }
  ): Promise<PhotoIndexRebuildResult> {
    const canonical = canonicalEvent(event);
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new TypeError("photo index rebuild batch size must be an integer from 1 to 1000");
    }
    const completeKey = photoIndexRebuildCompleteKey(canonical);
    const checkpointKey = photoIndexRebuildCheckpointKey(canonical);
    const existingComplete = await this.state.get(completeKey);
    if (existingComplete) {
      await this.parseRebuildComplete(canonical, existingComplete);
      const checkpoint = await this.readRebuildCheckpoint(canonical);
      return {
        complete: true,
        scanned: 0,
        indexed: 0,
        checkpoint: checkpoint?.lastPhotoKey ?? null,
      };
    }

    const checkpoint = await this.readRebuildCheckpoint(canonical);
    const page = await this.photos.list({
      prefix: eventPhotoPrefix(canonical),
      ...(checkpoint ? { startAfter: checkpoint.lastPhotoKey } : {}),
      limit: options.batchSize,
    });
    let indexed = 0;
    let lastPhotoKey = checkpoint?.lastPhotoKey ?? null;

    for (const object of page.objects) {
      lastPhotoKey = object.key;
      if (!isPhotoKey(canonical, object.key)) continue;
      const current = await this.photos.get(object.key);
      if (!current || !isPhotoKey(canonical, current.key)) continue;
      const capturedAt = capturedAtFromLegacyPhotoKey(canonical, current.key)
        ?? current.uploaded.getTime();
      const metadata: PrivatePhotoMetadata = {
        ...photoPrivateMetadata(current.key, current.uploaded),
        capturedAt,
      };
      const created = await this.state.compareAndSwap(
        photoIndexKey(canonical, current.key, capturedAt),
        null,
        JSON.stringify(metadata),
        jsonWriteOptions()
      );
      if (created) indexed += 1;
    }

    if (page.objects.length > 0 && lastPhotoKey) {
      const nextCheckpoint: PrivatePhotoIndexRebuildCheckpoint = {
        version: 1,
        event: canonical,
        lastPhotoKey,
      };
      const advanced = await this.state.compareAndSwap(
        checkpointKey,
        checkpoint?.etag ?? null,
        JSON.stringify(nextCheckpoint),
        jsonWriteOptions()
      );
      if (!advanced) {
        const current = await this.readRebuildCheckpoint(canonical);
        if (!current) throw new InvalidPhotoIndexRebuildStateError(canonical);
        return {
          complete: false,
          scanned: page.objects.length,
          indexed,
          checkpoint: current.lastPhotoKey,
        };
      }
    }

    const complete = !page.truncated;
    if (complete) {
      const marker: PrivatePhotoIndexRebuildComplete = {
        version: 1,
        event: canonical,
        completedAt: this.now().toISOString(),
      };
      await this.state.compareAndSwap(
        completeKey,
        null,
        JSON.stringify(marker),
        jsonWriteOptions()
      );
      const stored = await this.state.get(completeKey);
      if (!stored) throw new InvalidPhotoIndexRebuildStateError(canonical);
      await this.parseRebuildComplete(canonical, stored);
    }

    return {
      complete,
      scanned: page.objects.length,
      indexed,
      checkpoint: lastPhotoKey,
    };
  }

  private async readRebuildCheckpoint(
    event: string
  ): Promise<(PrivatePhotoIndexRebuildCheckpoint & { etag: string }) | null> {
    const object = await this.state.get(photoIndexRebuildCheckpointKey(event));
    if (!object) return null;
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidPhotoIndexRebuildStateError(event);
    }
    if (
      !isRecord(value)
      || !hasExactObjectKeys(value, ["version", "event", "lastPhotoKey"])
      || value.version !== 1
      || value.event !== event
      || typeof value.lastPhotoKey !== "string"
      || !value.lastPhotoKey.startsWith(eventPhotoPrefix(event))
      || /[\\?#]/.test(value.lastPhotoKey)
    ) {
      throw new InvalidPhotoIndexRebuildStateError(event);
    }
    return {
      version: 1,
      event,
      lastPhotoKey: value.lastPhotoKey,
      etag: object.etag,
    };
  }

  private async parseRebuildComplete(
    event: string,
    object: StoredObjectBody
  ): Promise<PrivatePhotoIndexRebuildComplete> {
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidPhotoIndexRebuildStateError(event);
    }
    if (
      !isRecord(value)
      || !hasExactObjectKeys(value, ["version", "event", "completedAt"])
      || value.version !== 1
      || value.event !== event
      || typeof value.completedAt !== "string"
      || Number.isNaN(Date.parse(value.completedAt))
    ) {
      throw new InvalidPhotoIndexRebuildStateError(event);
    }
    return { version: 1, event, completedAt: value.completedAt };
  }

  async *iteratePhotoObjects(event: string): AsyncGenerator<StoredObject> {
    let cursor: string | undefined;
    do {
      const page = await this.photos.list({ prefix: eventPhotoPrefix(event), cursor, limit: PAGE_SIZE });
      for (const object of page.objects) if (isPhotoKey(event, object.key)) yield object;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async *iterateExportPhotoSources(
    event: string,
  ): AsyncGenerator<ExportPhotoSource> {
    const canonical = canonicalEvent(event);
    for await (const photo of this.iteratePhotoObjects(canonical)) {
      const receiptObject = await this.state.get(
        photoReceiptKey(canonical, photo.key),
      );
      let receipt: ExportPhotoSource["receipt"] = null;
      if (receiptObject) {
        let value: unknown;
        try {
          value = await receiptObject.json<unknown>();
        } catch {
          throw new InvalidPhotoReceiptError(photo.key, "invalid_shape");
        }
        const parsed = parsePhotoReceipt(value, photo.key);
        receipt = {
          capturedAt: parsed.capturedAt,
          ...(parsed.source !== undefined ? { source: parsed.source } : {}),
          ...(parsed.frameKey !== undefined ? { frameKey: parsed.frameKey } : {}),
        };
      }
      yield {
        key: photo.key,
        size: photo.size,
        uploadedAt: photo.uploaded.toISOString(),
        receipt,
      };
    }
  }

  getPhoto(key: string): Promise<StoredObjectBody | null> {
    return this.photos.get(key);
  }

  async getPublicPhoto(event: string, completeKey: string): Promise<PublicPhoto | null> {
    const canonical = canonicalEvent(event);
    if (!isPhotoKey(canonical, completeKey)) {
      throw new InvalidPublicPhotoKeyError();
    }
    const object = await this.photos.get(completeKey);
    if (!object || object.key !== completeKey) return null;
    return {
      key: completeKey,
      url: this.publicUrl(completeKey),
      uploadedAt: object.uploaded.toISOString(),
    };
  }

  async deletePhoto(event: string, key: string): Promise<DeletePhotoResult> {
    const canonical = canonicalEvent(event);
    if (!isPhotoKey(canonical, key)) return { deleted: false };
    const existing = await this.photos.get(key);
    if (!existing) return { deleted: false };
    const receiptKey = photoReceiptKey(canonical, key);
    const receipt = await this.state.get(receiptKey);
    let sortTime = capturedAtFromLegacyPhotoKey(canonical, key) ?? existing.uploaded.getTime();
    if (receipt) {
      try {
        sortTime = parsePhotoReceipt(await receipt.json<unknown>(), key).capturedAt;
      } catch {
        // A corrupt derived record cannot block exact public deletion. Its one
        // exact receipt is still cleaned below using the safe public fallback.
      }
    }
    await this.photos.delete(key);
    const index = await this.deleteDerivedRecord(
      photoIndexKey(canonical, key, sortTime)
    );
    const receiptCleanup = await this.deleteDerivedRecord(receiptKey);
    return {
      deleted: true,
      cleanup: { index, receipt: receiptCleanup },
    };
  }

  private async deleteDerivedRecord(
    key: string
  ): Promise<"deleted" | "missing" | "failed"> {
    try {
      if (!await this.state.get(key)) return "missing";
      await this.state.delete(key);
      return "deleted";
    } catch {
      return "failed";
    }
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

  private async readBoothHeartbeat(event: string, key: string): Promise<BoothHeartbeatRecord> {
    const object = await this.state.get(key);
    if (!object) throw new InvalidStoredBoothHeartbeatError(event);
    let value: unknown;
    try {
      value = await object.json<unknown>();
    } catch {
      throw new InvalidStoredBoothHeartbeatError(event);
    }
    const record = parseBoothHeartbeatRecord(value);
    if (!record || key !== boothHeartbeatKey(event, record.deviceId)) {
      throw new InvalidStoredBoothHeartbeatError(event);
    }
    return record;
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
    reason: "save" | "restore" | "preset",
    sourceRevisionId?: string,
    sourcePresetId?: string,
  ): Promise<void> {
    const intent: ConfigMutationIntent = {
      version: EVENT_CONFIG_VERSION,
      config,
      baseRevisionId,
      boothKeyMutationFingerprint,
      reason,
      ...(sourceRevisionId ? { sourceRevisionId } : {}),
      ...(sourcePresetId ? { sourcePresetId } : {}),
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
      || parsed.sourcePresetId !== sourcePresetId
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
      || revision.sourcePresetId !== input.sourcePresetId
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
    || (reason !== "save" && reason !== "restore" && reason !== "preset")
    || (
      reason === "save"
        ? Object.keys(intent).length !== 5
          || "sourceRevisionId" in intent
          || "sourcePresetId" in intent
        : reason === "restore"
          ? Object.keys(intent).length !== 6
            || !isRevisionId(intent.sourceRevisionId)
            || "sourcePresetId" in intent
          : Object.keys(intent).length !== 6
            || !isPresetId(intent.sourcePresetId)
            || "sourceRevisionId" in intent
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
    ...(reason === "preset" ? { sourcePresetId: intent.sourcePresetId as string } : {}),
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

type PrivatePhotoFeedHead = {
  version: typeof PHOTO_FEED_VERSION;
  sequence: number;
  nodeKey: string | null;
};

type PrivatePhotoFeedEntry = {
  version: typeof PHOTO_FEED_VERSION;
  key: string;
  metadata: PrivatePhotoMetadata;
};

type PrivatePhotoFeedClaim = {
  version: typeof PHOTO_FEED_VERSION;
  entryKey: string;
  nodeKey: string;
  sequence: number;
  previousNodeKey: string | null;
};

type PrivatePhotoFeedNode = {
  version: typeof PHOTO_FEED_VERSION;
  sequence: number;
  entryKey: string;
  previousNodeKey: string | null;
};

type PrivatePhotoFeedMarker = {
  version: typeof PHOTO_FEED_VERSION;
  sequence: number;
};

type PrivatePhotoFeedCommitted = {
  version: typeof PHOTO_FEED_VERSION;
  sequence: number;
  key: string;
  entryKey: string;
  nodeKey: string;
};

type PhotoFeedCursor = {
  version: typeof PHOTO_FEED_VERSION;
  event: string;
  sequence: number;
};

type PrivatePhotoMetadata = PhotoReceiptV1;

type PrivatePhotoIndexRebuildCheckpoint = {
  version: 1;
  event: string;
  lastPhotoKey: string;
};

type PrivatePhotoIndexRebuildComplete = {
  version: 1;
  event: string;
  completedAt: string;
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

function parsePhotoFeedHead(event: string, value: unknown): PrivatePhotoFeedHead | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== PHOTO_FEED_VERSION
    || typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || (value.nodeKey !== null && (typeof value.nodeKey !== "string" || !value.nodeKey.startsWith(photoFeedNodePrefix(event))))
    || (value.sequence === 0) !== (value.nodeKey === null)
  ) {
    return null;
  }
  return { version: PHOTO_FEED_VERSION, sequence: value.sequence, nodeKey: value.nodeKey as string | null };
}

function parsePhotoFeedEntry(event: string, value: unknown): PrivatePhotoFeedEntry | null {
  if (!isRecord(value) || value.version !== PHOTO_FEED_VERSION || typeof value.key !== "string" || !isPhotoKey(event, value.key)) return null;
  const metadata = parsePrivatePhotoMetadata(event, value.metadata);
  if (!metadata || metadata.key !== value.key) return null;
  return { version: PHOTO_FEED_VERSION, key: value.key, metadata };
}

function parsePhotoFeedClaim(event: string, value: unknown): PrivatePhotoFeedClaim | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== PHOTO_FEED_VERSION
    || typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.entryKey !== "string"
    || !value.entryKey.startsWith(`events/${event}/photo-feed/v1/entries/`)
    || typeof value.nodeKey !== "string"
    || !value.nodeKey.startsWith(photoFeedNodePrefix(event))
    || (
      value.previousNodeKey !== null
      && (
        typeof value.previousNodeKey !== "string"
        || !value.previousNodeKey.startsWith(photoFeedNodePrefix(event))
      )
    )
    || (value.sequence === 1) !== (value.previousNodeKey === null)
  ) {
    return null;
  }
  return {
    version: PHOTO_FEED_VERSION,
    entryKey: value.entryKey,
    nodeKey: value.nodeKey,
    sequence: value.sequence,
    previousNodeKey: value.previousNodeKey as string | null,
  };
}

function parsePhotoFeedNode(event: string, value: unknown): PrivatePhotoFeedNode | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== PHOTO_FEED_VERSION
    || typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.entryKey !== "string"
    || !value.entryKey.startsWith(`events/${event}/photo-feed/v1/entries/`)
    || (value.previousNodeKey !== null && (typeof value.previousNodeKey !== "string" || !value.previousNodeKey.startsWith(photoFeedNodePrefix(event))))
    || (value.sequence === 1) !== (value.previousNodeKey === null)
  ) {
    return null;
  }
  return {
    version: PHOTO_FEED_VERSION,
    sequence: value.sequence,
    entryKey: value.entryKey,
    previousNodeKey: value.previousNodeKey as string | null,
  };
}

function parsePhotoFeedMarker(value: unknown): PrivatePhotoFeedMarker | null {
  if (
    !isRecord(value)
    || value.version !== PHOTO_FEED_VERSION
    || typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
  ) {
    return null;
  }
  return { version: PHOTO_FEED_VERSION, sequence: value.sequence };
}

function parsePhotoFeedCommitted(event: string, value: unknown): PrivatePhotoFeedCommitted | null {
  if (
    !isRecord(value)
    || value.version !== PHOTO_FEED_VERSION
    || typeof value.sequence !== "number"
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 1
    || typeof value.key !== "string"
    || !isPhotoKey(event, value.key)
    || typeof value.entryKey !== "string"
    || !value.entryKey.startsWith(`events/${event}/photo-feed/v1/entries/`)
    || typeof value.nodeKey !== "string"
    || !value.nodeKey.startsWith(photoFeedNodePrefix(event))
  ) {
    return null;
  }
  return {
    version: PHOTO_FEED_VERSION,
    sequence: value.sequence,
    key: value.key,
    entryKey: value.entryKey,
    nodeKey: value.nodeKey,
  };
}

function parsePrivatePhotoMetadata(event: string, value: unknown): PrivatePhotoMetadata | null {
  if (!isRecord(value) || typeof value.key !== "string" || !isPhotoKey(event, value.key)) {
    return null;
  }
  try {
    return parsePhotoReceipt(value, value.key);
  } catch {
    return null;
  }
}

function samePrivatePhotoMetadata(left: PrivatePhotoMetadata, right: PrivatePhotoMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function newestPublicObjectFirst(left: StoredObject, right: StoredObject): number {
  return right.uploaded.getTime() - left.uploaded.getTime() || right.key.localeCompare(left.key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isNullableSafeTimestamp(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function capturedAtFromLegacyPhotoKey(event: string, key: string): number | null {
  const match = key.slice(eventPhotoPrefix(event).length).match(/^(\d{13})-/);
  if (!match) return null;
  const capturedAt = Number(match[1]);
  return Number.isSafeInteger(capturedAt) ? capturedAt : null;
}

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function samePhotoFeedCommitted(
  left: PrivatePhotoFeedCommitted,
  right: PrivatePhotoFeedCommitted
): boolean {
  return left.version === right.version
    && left.sequence === right.sequence
    && left.key === right.key
    && left.entryKey === right.entryKey
    && left.nodeKey === right.nodeKey;
}

function photoFeedNodeFromClaim(claim: PrivatePhotoFeedClaim): PrivatePhotoFeedNode {
  return {
    version: PHOTO_FEED_VERSION,
    sequence: claim.sequence,
    entryKey: claim.entryKey,
    previousNodeKey: claim.previousNodeKey,
  };
}

function samePhotoFeedNode(left: PrivatePhotoFeedNode, right: PrivatePhotoFeedNode): boolean {
  return left.version === right.version
    && left.sequence === right.sequence
    && left.entryKey === right.entryKey
    && left.previousNodeKey === right.previousNodeKey;
}

function samePhotoFeedClaim(left: PrivatePhotoFeedClaim, right: PrivatePhotoFeedClaim): boolean {
  return left.version === right.version
    && left.entryKey === right.entryKey
    && left.nodeKey === right.nodeKey
    && left.sequence === right.sequence
    && left.previousNodeKey === right.previousNodeKey;
}

function encodePhotoFeedCursor(event: string, sequence: number): string {
  return `pf1.${base64url(JSON.stringify({ version: PHOTO_FEED_VERSION, event, sequence }))}`;
}

function parsePhotoFeedCursor(event: string, value: string): PhotoFeedCursor {
  if (!value.startsWith("pf1.")) throw new InvalidPhotoCursorError();
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64urlDecode(value.slice(4)));
  } catch {
    throw new InvalidPhotoCursorError();
  }
  if (
    !isRecord(decoded)
    || decoded.version !== PHOTO_FEED_VERSION
    || decoded.event !== event
    || typeof decoded.sequence !== "number"
    || !Number.isSafeInteger(decoded.sequence)
    || decoded.sequence < 0
  ) {
    throw new InvalidPhotoCursorError();
  }
  return {
    version: PHOTO_FEED_VERSION,
    event,
    sequence: decoded.sequence,
  };
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return atob(padded);
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
