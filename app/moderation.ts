export type ModerationPhoto = {
  key: string;
  url: string;
  uploadedAt: string;
  capturedAt: number;
  source?: "framed" | "camera-fallback";
  frameKey?: string;
};

export type ModerationCursor = {
  version: 1;
  event: string;
  afterIndexKey: string;
  from: number | null;
  to: number | null;
};

type ModerationPhotoRecord = Omit<ModerationPhoto, "url">;

const PHOTO_EXTENSIONS = /\.(?:jpe?g|png|gif|webp|hei[cf]|avif)$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class InvalidModerationCursorError extends Error {
  constructor() {
    super("moderation cursor is invalid for this Event and filter");
  }
}

export function encodeModerationCursor(cursor: ModerationCursor): string {
  validateCursor(cursor, cursor);
  return `mod1.${base64url(JSON.stringify(cursor))}`;
}

export function decodeModerationCursor(
  encoded: string,
  expected: Pick<ModerationCursor, "event" | "from" | "to">
): ModerationCursor {
  if (!encoded.startsWith("mod1.")) throw new InvalidModerationCursorError();
  let value: unknown;
  try {
    value = JSON.parse(base64urlDecode(encoded.slice(5)));
  } catch {
    throw new InvalidModerationCursorError();
  }
  return validateCursor(value, expected);
}

export function parseModerationPhotoRecord(
  event: string,
  value: unknown
): ModerationPhotoRecord | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "version",
    "key",
    "uploadedAt",
    "capturedAt",
    "source",
    "frameKey",
    "configRevisionId",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || value.version !== 1
    || typeof value.key !== "string"
    || !isEventPhotoKey(event, value.key)
    || typeof value.uploadedAt !== "string"
    || !isStoredInstant(value.uploadedAt)
    || typeof value.capturedAt !== "number"
    || !Number.isSafeInteger(value.capturedAt)
    || value.capturedAt < 0
    || (value.source !== undefined && value.source !== "framed" && value.source !== "camera-fallback")
    || (
      value.frameKey !== undefined
      && (typeof value.frameKey !== "string" || !TOKEN.test(value.frameKey))
    )
    || (
      value.configRevisionId !== undefined
      && (typeof value.configRevisionId !== "string" || !TOKEN.test(value.configRevisionId))
    )
  ) {
    return null;
  }
  return {
    key: value.key,
    uploadedAt: value.uploadedAt,
    capturedAt: value.capturedAt,
    ...(value.source ? { source: value.source } : {}),
    ...(typeof value.frameKey === "string" ? { frameKey: value.frameKey } : {}),
  };
}

function validateCursor(
  value: unknown,
  expected: Pick<ModerationCursor, "event" | "from" | "to">
): ModerationCursor {
  if (!isRecord(value)) throw new InvalidModerationCursorError();
  if (
    !hasExactKeys(value, ["version", "event", "afterIndexKey", "from", "to"])
    || value.version !== 1
    || typeof value.event !== "string"
    || value.event !== expected.event
    || typeof value.afterIndexKey !== "string"
    || !isPhotoIndexKey(value.event, value.afterIndexKey)
    || !isNullableTimestamp(value.from)
    || !isNullableTimestamp(value.to)
    || value.from !== expected.from
    || value.to !== expected.to
  ) {
    throw new InvalidModerationCursorError();
  }
  return {
    version: 1,
    event: value.event,
    afterIndexKey: value.afterIndexKey,
    from: value.from,
    to: value.to,
  };
}

function isPhotoIndexKey(event: string, key: string): boolean {
  const prefix = `events/${event}/photo-index/v1/`;
  const suffix = key.slice(prefix.length);
  return key.startsWith(prefix)
    && /^\d{13}-[A-Za-z0-9_-]+\.json$/.test(suffix);
}

function isEventPhotoKey(event: string, key: string): boolean {
  const prefix = `${event}/`;
  const filename = key.slice(prefix.length);
  return key.startsWith(prefix)
    && filename.length > 0
    && !/[\/\\?#]/.test(filename)
    && PHOTO_EXTENSIONS.test(filename);
}

function isStoredInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
