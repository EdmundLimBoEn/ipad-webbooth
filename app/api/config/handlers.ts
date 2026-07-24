import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  ConfigConflictError,
  ConfigMutationConflictError,
  ConfigRevisionNotFoundError,
  EventStore,
  InvalidEventSlugError,
} from "@/app/event-store";
import {
  isRevisionId,
  projectPublicConfig,
  type ConfigRevision,
  type EventConfig,
} from "@/app/event-config";
import { TEMPLATES } from "@/app/templates";
import { adminOk } from "@/app/upload-auth";

type SaveBody = {
  frames: string[];
  boothKey?: string;
  mutationId: string;
  baseRevisionId: string | null;
};

type RestoreBody = {
  revisionId: string;
  mutationId: string;
  baseRevisionId: string | null;
};

export type ConfigHandlerDeps = {
  store: EventStore;
  adminKey?: string;
  hashBoothKey: (key: string) => Promise<string>;
};

const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, { status });

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Stable, opaque retry identity for Booth key mutations. The independently
 * salted PBKDF2 hash remains the only credential verifier stored in config.
 */
export async function boothKeyMutationFingerprint(
  boothKey: string,
  adminKey: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(adminKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(boothKey));
  return toHex(new Uint8Array(signature));
}

function eventFrom(req: NextRequest): string | NextResponse {
  try {
    return canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) {
      return jsonError(error.message, 400);
    }
    throw error;
  }
}

function requireAdmin(req: NextRequest, deps: ConfigHandlerDeps): NextResponse | null {
  if (!deps.adminKey) {
    return jsonError("config disabled: no key configured", 503);
  }
  const auth = adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey);
  return auth === "ok" ? null : jsonError("unauthorized", 401);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function parseSaveBody(value: unknown): SaveBody | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "frames",
    "boothKey",
    "mutationId",
    "baseRevisionId",
  ])) {
    return null;
  }
  if (
    !Array.isArray(value.frames)
    || !value.frames.every((frame) =>
      typeof frame === "string" && Object.hasOwn(TEMPLATES, frame)
    )
    || !isRevisionId(value.mutationId)
    || (value.baseRevisionId !== null && !isRevisionId(value.baseRevisionId))
  ) {
    return null;
  }
  if (
    value.boothKey !== undefined
    && (
      typeof value.boothKey !== "string"
      || value.boothKey.length < 12
      || value.boothKey.length > 128
    )
  ) {
    return null;
  }
  return {
    frames: [...value.frames],
    ...(typeof value.boothKey === "string" ? { boothKey: value.boothKey } : {}),
    mutationId: value.mutationId,
    baseRevisionId: value.baseRevisionId,
  };
}

function parseRestoreBody(value: unknown): RestoreBody | null {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "revisionId",
    "mutationId",
    "baseRevisionId",
  ])) {
    return null;
  }
  if (
    !isRevisionId(value.revisionId)
    || !isRevisionId(value.mutationId)
    || (value.baseRevisionId !== null && !isRevisionId(value.baseRevisionId))
  ) {
    return null;
  }
  return {
    revisionId: value.revisionId,
    mutationId: value.mutationId,
    baseRevisionId: value.baseRevisionId,
  };
}

/**
 * Frames and a possible Booth-key rotation are the deliberately small Admin
 * save surface. Preserve every other known experience field explicitly rather
 * than spreading an HTTP body into a stored config.
 */
function configForSave(
  current: EventConfig | null,
  body: SaveBody,
  boothKeyHash: string | undefined
): EventConfig {
  return {
    frames: [...body.frames],
    ...(current?.locales ? { locales: [...current.locales] } : {}),
    ...(current?.defaultLocale ? { defaultLocale: current.defaultLocale } : {}),
    ...(current?.timeZone ? { timeZone: current.timeZone } : {}),
    ...(current?.capture
      ? {
        capture: {
          ...(current.capture.reviewEnabled !== undefined
            ? { reviewEnabled: current.capture.reviewEnabled }
            : {}),
          ...(current.capture.autoAcceptSeconds !== undefined
            ? { autoAcceptSeconds: current.capture.autoAcceptSeconds }
            : {}),
          ...(current.capture.countdownAudioDefault !== undefined
            ? { countdownAudioDefault: current.capture.countdownAudioDefault }
            : {}),
        },
      }
      : {}),
    ...(current?.gallery
      ? {
        gallery: {
          ...(current.gallery.title !== undefined ? { title: current.gallery.title } : {}),
          ...(current.gallery.accentColor !== undefined ? { accentColor: current.gallery.accentColor } : {}),
        },
      }
      : {}),
    ...(boothKeyHash === undefined ? {} : { boothKeyHash }),
  };
}

function safeRevision(revision: ConfigRevision): ConfigRevision {
  const { hasBoothKey: _hasBoothKey, ...config } = projectPublicConfig(revision.config);
  return {
    version: revision.version,
    id: revision.id,
    createdAt: revision.createdAt,
    parentRevisionId: revision.parentRevisionId,
    reason: revision.reason,
    ...(revision.sourceRevisionId ? { sourceRevisionId: revision.sourceRevisionId } : {}),
    ...(revision.sourcePresetId ? { sourcePresetId: revision.sourcePresetId } : {}),
    config: { ...config, frames: config.frames ?? [] },
  };
}

function conflictResponse(error: unknown): NextResponse | null {
  if (error instanceof ConfigConflictError || error instanceof ConfigMutationConflictError) {
    return jsonError("configuration conflict", 409);
  }
  return null;
}

export async function getPublicConfig(
  req: NextRequest,
  deps: ConfigHandlerDeps
): Promise<NextResponse> {
  const event = eventFrom(req);
  if (event instanceof NextResponse) return event;
  const config = await deps.store.readConfig(event);
  return NextResponse.json(projectPublicConfig(config));
}

export async function putConfig(
  req: NextRequest,
  deps: ConfigHandlerDeps
): Promise<NextResponse> {
  const rejected = requireAdmin(req, deps);
  if (rejected) return rejected;
  const event = eventFrom(req);
  if (event instanceof NextResponse) return event;
  const body = parseSaveBody(await req.json().catch(() => null));
  if (!body) return jsonError("invalid config request", 400);

  const boothKeyHash = body.boothKey === undefined
    ? undefined
    : await deps.hashBoothKey(body.boothKey);
  const fingerprint = body.boothKey === undefined
    ? undefined
    : await boothKeyMutationFingerprint(body.boothKey, deps.adminKey!);

  try {
    const current = await deps.store.readConfig(event);
    const result = await deps.store.saveConfigRevision(event, {
      config: configForSave(current, body, boothKeyHash),
      mutationId: body.mutationId,
      baseRevisionId: body.baseRevisionId,
      ...(fingerprint === undefined
        ? {}
        : { boothKeyMutationFingerprint: fingerprint }),
    });
    return NextResponse.json({
      ...projectPublicConfig(result.config),
      currentRevisionId: result.revision.id,
      idempotent: result.idempotent,
    });
  } catch (error) {
    const conflict = conflictResponse(error);
    if (conflict) return conflict;
    if (error instanceof TypeError) return jsonError("invalid config request", 400);
    throw error;
  }
}

export async function getConfigRevisions(
  req: NextRequest,
  deps: ConfigHandlerDeps
): Promise<NextResponse> {
  const rejected = requireAdmin(req, deps);
  if (rejected) return rejected;
  const event = eventFrom(req);
  if (event instanceof NextResponse) return event;
  const history = await deps.store.readConfigHistory(event);
  return NextResponse.json({
    config: projectPublicConfig(history.config),
    currentRevisionId: history.currentRevisionId,
    revisions: history.revisions.map(safeRevision),
  });
}

export async function postConfigRestore(
  req: NextRequest,
  deps: ConfigHandlerDeps
): Promise<NextResponse> {
  const rejected = requireAdmin(req, deps);
  if (rejected) return rejected;
  const event = eventFrom(req);
  if (event instanceof NextResponse) return event;
  const body = parseRestoreBody(await req.json().catch(() => null));
  if (!body) return jsonError("invalid restore request", 400);

  try {
    const result = await deps.store.restoreConfigRevision(event, body);
    return NextResponse.json({
      ...projectPublicConfig(result.config),
      currentRevisionId: result.revision.id,
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (error instanceof ConfigRevisionNotFoundError) {
      return jsonError("configuration revision not found", 404);
    }
    const conflict = conflictResponse(error);
    if (conflict) return conflict;
    if (error instanceof TypeError) return jsonError("invalid restore request", 400);
    throw error;
  }
}
