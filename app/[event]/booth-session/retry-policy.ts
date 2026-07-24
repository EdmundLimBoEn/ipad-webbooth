export type UploadErrorClass =
  | "network"
  | "timeout"
  | "auth"
  | "payload"
  | "server"
  | "unknown";

export class HttpUploadError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    readonly errorClass: UploadErrorClass
  ) {
    super(`upload failed with status ${status}`);
    this.name = "HttpUploadError";
  }
}

export type RetryDisposition =
  | { kind: "retryable"; delayMs: number; errorClass: UploadErrorClass }
  | { kind: "auth-required"; errorClass: "auth" }
  | { kind: "permanent"; errorClass: UploadErrorClass };

const MAX_RETRY_DELAY_MS = 30_000;

function retryAfterDelay(value: string | null, now: number) {
  if (value === null) return 0;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1_000);
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

function retryable(
  errorClass: UploadErrorClass,
  attempt: number,
  now: number,
  random: () => number,
  retryAfter: string | null
): RetryDisposition {
  const exponent = Math.max(0, attempt - 1);
  const jitter = 0.5 + Math.min(1, Math.max(0, random()));
  const backoff = 1_000 * 2 ** exponent * jitter;
  const delayMs = Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(backoff, retryAfterDelay(retryAfter, now))
  );
  return { kind: "retryable", delayMs, errorClass };
}

export function classifyUploadFailure(
  error: unknown,
  attempt: number,
  now: number,
  random: () => number = Math.random
): RetryDisposition {
  if (error instanceof TypeError) {
    return retryable("network", attempt, now, random, null);
  }
  if (!(error instanceof HttpUploadError)) {
    return { kind: "permanent", errorClass: "unknown" };
  }
  if (error.status === 401) {
    return { kind: "auth-required", errorClass: "auth" };
  }
  if (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  ) {
    return retryable(error.errorClass, attempt, now, random, error.retryAfter);
  }
  return { kind: "permanent", errorClass: error.errorClass };
}
