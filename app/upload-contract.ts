export type CaptureSource = "framed" | "camera-fallback";

export type CaptureMetadata = {
  frameKey?: string;
  capturedAt: number;
  source: CaptureSource;
  configRevisionId?: string;
};

export type StableCaptureIdentity = {
  captureId: string;
  capturedAt: number;
};

export type StableUpload = StableCaptureIdentity & {
  source?: CaptureSource;
  frameKey?: string;
  configRevisionId?: string;
};

export type UploadIntent = { kind: "legacy" } | ({ kind: "stable" } & StableUpload);

type InvalidUploadHeadersCode =
  | "incomplete_capture_identity"
  | "invalid_capture_id"
  | "invalid_captured_at"
  | "invalid_capture_source"
  | "invalid_frame_key"
  | "invalid_config_revision_id";

export class InvalidUploadHeadersError extends Error {
  constructor(readonly code: InvalidUploadHeadersCode, message: string) {
    super(message);
    this.name = "InvalidUploadHeadersError";
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURED_AT = /^\d{13}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const invalid = (code: InvalidUploadHeadersCode, message: string): never => {
  throw new InvalidUploadHeadersError(code, message);
};

export function parseUploadHeaders(headers: Headers): UploadIntent {
  const captureId = headers.get("x-capture-id");
  const capturedAt = headers.get("x-captured-at");
  const source = headers.get("x-capture-source");
  const frameKey = headers.get("x-frame-key");
  const configRevisionId = headers.get("x-config-revision-id");

  const hasMetadata = source !== null || frameKey !== null || configRevisionId !== null;

  if (captureId === null && capturedAt === null) {
    if (hasMetadata) invalid("incomplete_capture_identity", "Capture metadata requires a capture identity.");
    return { kind: "legacy" };
  }

  if (captureId === null || capturedAt === null) {
    throw new InvalidUploadHeadersError("incomplete_capture_identity", "Both capture identity headers are required.");
  }

  if (!UUID_V4.test(captureId)) invalid("invalid_capture_id", "Capture ID must be a lowercase UUID-v4.");
  if (!CAPTURED_AT.test(capturedAt)) invalid("invalid_captured_at", "Captured-at must be exactly 13 decimal digits.");
  let parsedSource: CaptureSource | undefined;
  if (source !== null) {
    if (source === "framed" || source === "camera-fallback") {
      parsedSource = source;
    } else {
      throw new InvalidUploadHeadersError("invalid_capture_source", "Capture source is invalid.");
    }
  }
  if (frameKey !== null && !SAFE_TOKEN.test(frameKey)) invalid("invalid_frame_key", "Frame key is invalid.");
  if (configRevisionId !== null && !SAFE_TOKEN.test(configRevisionId)) {
    invalid("invalid_config_revision_id", "Config revision ID is invalid.");
  }

  return {
    kind: "stable",
    captureId,
    capturedAt: Number(capturedAt),
    ...(parsedSource ? { source: parsedSource } : {}),
    ...(frameKey !== null ? { frameKey } : {}),
    ...(configRevisionId !== null ? { configRevisionId } : {}),
  };
}

export function stableUploadHeaders(input: StableUpload): Record<string, string> {
  return {
    "x-capture-id": input.captureId,
    "x-captured-at": String(input.capturedAt),
    ...(input.source ? { "x-capture-source": input.source } : {}),
    ...(input.frameKey ? { "x-frame-key": input.frameKey } : {}),
    ...(input.configRevisionId ? { "x-config-revision-id": input.configRevisionId } : {}),
  };
}
