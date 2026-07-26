export const BOOTH_HEARTBEAT_INTERVAL_MS = 15_000;
export const BOOTH_STALE_AFTER_MS = 45_000;

const BOOTH_CONTROL_VERSION = 1 as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CAMERA_STATES = ["stopped", "starting", "ready", "denied", "unavailable"] as const;
const UPLOAD_STATES = ["idle", "uploading", "retry-wait", "blocked", "auth-required"] as const;
const ERROR_CLASSES = [
  "network",
  "timeout",
  "auth",
  "payload",
  "camera-permission",
  "camera-unavailable",
  "storage",
  "server",
  "unknown",
] as const;
const HEARTBEAT_INPUT_KEYS = [
  "version",
  "deviceId",
  "sessionStartedAt",
  "pendingCount",
  "durableStorage",
  "online",
  "installed",
  "camera",
  "upload",
  "lastSuccessfulUploadAt",
  "errorClass",
  "buildId",
] as const;
const HEARTBEAT_RECORD_KEYS = [...HEARTBEAT_INPUT_KEYS, "lastSeenAt"] as const;

export type BoothCameraState = typeof CAMERA_STATES[number];
export type BoothUploadState = typeof UPLOAD_STATES[number];
export type BoothErrorClass = typeof ERROR_CLASSES[number];

export type BoothHeartbeatInput = {
  version: 1;
  deviceId: string;
  sessionStartedAt: number;
  pendingCount: number;
  durableStorage: boolean;
  online: boolean;
  installed: boolean;
  camera: BoothCameraState;
  upload: BoothUploadState;
  lastSuccessfulUploadAt?: number;
  errorClass?: BoothErrorClass;
  buildId: string;
};

export type BoothHeartbeatRecord = BoothHeartbeatInput & { lastSeenAt: string };
export type AdminBoothRecord = BoothHeartbeatRecord & { stale: boolean };

export type BoothOperationalState = {
  version: 1;
  paused: boolean;
  messages?: Record<string, string>;
  updatedAt: string;
};

export type BoothOperationalStateInput = Pick<BoothOperationalState, "paused" | "messages">;

export function parseBoothHeartbeat(value: unknown): BoothHeartbeatInput | null {
  const record = parseRecord(value, HEARTBEAT_INPUT_KEYS);
  if (!record) return null;
  return parseHeartbeatFields(record);
}

export function parseBoothHeartbeatRecord(value: unknown): BoothHeartbeatRecord | null {
  const record = parseRecord(value, HEARTBEAT_RECORD_KEYS);
  if (!record || !isIsoTimestamp(record.lastSeenAt)) return null;
  const heartbeat = parseHeartbeatFields(record);
  return heartbeat ? { ...heartbeat, lastSeenAt: record.lastSeenAt } : null;
}

export function parseBoothOperationalStateInput(value: unknown): BoothOperationalStateInput | null {
  const record = parseRecord(value, ["paused", "messages"]);
  if (!record || typeof record.paused !== "boolean") return null;
  const messages = parseMessages(record.messages);
  if (messages === null) return null;
  return {
    paused: record.paused,
    ...(messages ? { messages } : {}),
  };
}

export function parseBoothOperationalState(value: unknown): BoothOperationalState | null {
  const record = parseRecord(value, ["version", "paused", "messages", "updatedAt"]);
  if (
    !record
    || record.version !== BOOTH_CONTROL_VERSION
    || typeof record.paused !== "boolean"
    || !isIsoTimestamp(record.updatedAt)
  ) return null;
  const messages = parseMessages(record.messages);
  if (messages === null) return null;
  return {
    version: BOOTH_CONTROL_VERSION,
    paused: record.paused,
    ...(messages ? { messages } : {}),
    updatedAt: record.updatedAt,
  };
}

function parseHeartbeatFields(record: Record<string, unknown>): BoothHeartbeatInput | null {
  if (
    record.version !== BOOTH_CONTROL_VERSION
    || typeof record.deviceId !== "string"
    || !UUID_V4.test(record.deviceId)
    || !isMilliseconds(record.sessionStartedAt)
    || !isPendingCount(record.pendingCount)
    || typeof record.durableStorage !== "boolean"
    || typeof record.online !== "boolean"
    || typeof record.installed !== "boolean"
    || !isOneOf(CAMERA_STATES, record.camera)
    || !isOneOf(UPLOAD_STATES, record.upload)
    || (record.lastSuccessfulUploadAt !== undefined && !isMilliseconds(record.lastSuccessfulUploadAt))
    || (record.errorClass !== undefined && !isOneOf(ERROR_CLASSES, record.errorClass))
    || typeof record.buildId !== "string"
    || !TOKEN.test(record.buildId)
  ) return null;

  return {
    version: BOOTH_CONTROL_VERSION,
    deviceId: record.deviceId,
    sessionStartedAt: record.sessionStartedAt,
    pendingCount: record.pendingCount,
    durableStorage: record.durableStorage,
    online: record.online,
    installed: record.installed,
    camera: record.camera,
    upload: record.upload,
    ...(typeof record.lastSuccessfulUploadAt === "number"
      ? { lastSuccessfulUploadAt: record.lastSuccessfulUploadAt }
      : {}),
    ...(typeof record.errorClass === "string" ? { errorClass: record.errorClass } : {}),
    buildId: record.buildId,
  };
}

function parseMessages(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.length > 20
    || entries.some(([locale, message]) => !TOKEN.test(locale) || typeof message !== "string" || message.length > 280)
  ) return null;
  const messages = Object.create(null) as Record<string, string>;
  for (const [locale, message] of entries) messages[locale] = message as string;
  return messages;
}

function parseRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPendingCount(value: unknown): value is number {
  return isMilliseconds(value) && value <= 10_000;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}
