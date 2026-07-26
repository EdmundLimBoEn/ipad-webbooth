import type { CaptureSource } from "./upload-contract";

const RECEIPT_KEYS = new Set([
  "version",
  "key",
  "uploadedAt",
  "capturedAt",
  "source",
  "frameKey",
  "configRevisionId",
]);
const REQUIRED_RECEIPT_KEYS = ["version", "key", "uploadedAt", "capturedAt"] as const;
const RFC3339 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  if (offset) {
    const hours = Number(offset[1]);
    const minutes = Number(offset[2]);
    if (hours > 14 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export type PhotoReceiptV1 = {
  version: 1;
  key: string;
  uploadedAt: string;
  capturedAt: number;
  source?: CaptureSource;
  frameKey?: string;
  configRevisionId?: string;
};

export class InvalidPhotoReceiptError extends Error {
  constructor(
    readonly expectedKey: string,
    readonly reason:
      | "invalid_shape"
      | "unsupported_version"
      | "key_mismatch"
      | "invalid_timestamp"
      | "invalid_metadata",
  ) {
    super(`invalid photo receipt (${reason})`);
    this.name = "InvalidPhotoReceiptError";
  }
}

function invalid(
  expectedKey: string,
  reason: InvalidPhotoReceiptError["reason"],
): never {
  throw new InvalidPhotoReceiptError(expectedKey, reason);
}

export function parsePhotoReceipt(
  value: unknown,
  expectedKey: string,
): PhotoReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(expectedKey, "invalid_shape");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !RECEIPT_KEYS.has(key))
    || REQUIRED_RECEIPT_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    return invalid(expectedKey, "invalid_shape");
  }
  if (record.version !== 1) return invalid(expectedKey, "unsupported_version");
  if (typeof record.key !== "string") return invalid(expectedKey, "invalid_shape");
  if (record.key !== expectedKey) return invalid(expectedKey, "key_mismatch");
  if (
    !isRfc3339(record.uploadedAt)
  ) {
    return invalid(expectedKey, "invalid_timestamp");
  }
  if (
    typeof record.capturedAt !== "number"
    || !Number.isSafeInteger(record.capturedAt)
    || record.capturedAt < 1_000_000_000_000
    || record.capturedAt > 9_999_999_999_999
    || (
      record.source !== undefined
      && record.source !== "framed"
      && record.source !== "camera-fallback"
    )
    || (record.frameKey !== undefined && !SAFE_TOKEN.test(String(record.frameKey)))
    || (
      record.configRevisionId !== undefined
      && !SAFE_TOKEN.test(String(record.configRevisionId))
    )
  ) {
    return invalid(expectedKey, "invalid_metadata");
  }
  if (
    (record.frameKey !== undefined && typeof record.frameKey !== "string")
    || (
      record.configRevisionId !== undefined
      && typeof record.configRevisionId !== "string"
    )
  ) {
    return invalid(expectedKey, "invalid_metadata");
  }
  return {
    version: 1,
    key: record.key,
    uploadedAt: record.uploadedAt,
    capturedAt: record.capturedAt,
    ...(record.source !== undefined ? { source: record.source } : {}),
    ...(record.frameKey !== undefined ? { frameKey: record.frameKey } : {}),
    ...(record.configRevisionId !== undefined
      ? { configRevisionId: record.configRevisionId }
      : {}),
  };
}
