import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  ConfigConflictError,
  ConfigMutationConflictError,
  EventPresetNotFoundError,
  EventStore,
  InvalidEventSlugError,
  PresetConflictError,
} from "@/app/event-store";
import {
  isRevisionId,
  parseEventExperience,
  projectPublicConfig,
} from "@/app/event-config";
import { isPresetId, type EventPreset } from "@/app/event-preset";
import { adminOk } from "@/app/upload-auth";

export type PresetHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};

const json = (body: unknown, init?: ResponseInit) =>
  NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" },
  });

const errorResponse = (error: string, status: number) =>
  json({ error }, { status });

function authorize(req: NextRequest, deps: PresetHandlerDeps): NextResponse | null {
  if (!deps.adminKey) return errorResponse("presets disabled: no key configured", 503);
  return adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) === "ok"
    ? null
    : errorResponse("unauthorized", 401);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStrictExperience(value: unknown): boolean {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      "frames",
      "locales",
      "defaultLocale",
      "timeZone",
      "capture",
      "gallery",
    ])
  ) {
    return false;
  }
  if (
    value.capture !== undefined
    && (
      !isRecord(value.capture)
      || !hasOnlyKeys(value.capture, [
        "reviewEnabled",
        "autoAcceptSeconds",
        "countdownAudioDefault",
      ])
    )
  ) {
    return false;
  }
  return value.gallery === undefined
    || (
      isRecord(value.gallery)
      && hasOnlyKeys(value.gallery, ["title", "accentColor"])
    );
}

function safePreset(preset: EventPreset): EventPreset {
  return {
    version: 1,
    id: preset.id,
    label: preset.label,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    config: {
      frames: [...preset.config.frames],
      ...(preset.config.locales ? { locales: [...preset.config.locales] } : {}),
      ...(preset.config.defaultLocale ? { defaultLocale: preset.config.defaultLocale } : {}),
      ...(preset.config.timeZone ? { timeZone: preset.config.timeZone } : {}),
      ...(preset.config.capture ? { capture: { ...preset.config.capture } } : {}),
      ...(preset.config.gallery ? { gallery: { ...preset.config.gallery } } : {}),
    },
  };
}

export async function getPresets(
  req: NextRequest,
  deps: PresetHandlerDeps,
): Promise<NextResponse> {
  const rejected = authorize(req, deps);
  if (rejected) return rejected;
  const params = req.nextUrl.searchParams;
  if (Array.from(params.keys()).some((key) => key !== "cursor" && key !== "limit")) {
    return errorResponse("invalid preset query", 400);
  }
  if (params.getAll("cursor").length > 1 || params.getAll("limit").length > 1) {
    return errorResponse("invalid preset query", 400);
  }
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
    return errorResponse("invalid preset limit", 400);
  }
  try {
    const page = await deps.store.listEventPresets({
      ...(params.has("cursor") ? { cursor: params.get("cursor")! } : {}),
      limit: rawLimit === null ? 50 : Number(rawLimit),
    });
    return json({
      presets: page.presets.map(safePreset),
      cursor: page.cursor,
    });
  } catch (error) {
    if (error instanceof TypeError) return errorResponse("invalid preset query", 400);
    throw error;
  }
}

export async function putPreset(
  req: NextRequest,
  presetId: string,
  deps: PresetHandlerDeps,
): Promise<NextResponse> {
  const rejected = authorize(req, deps);
  if (rejected) return rejected;
  if (!isPresetId(presetId)) return errorResponse("invalid preset ID", 400);
  const value = await req.json().catch(() => null);
  if (!isRecord(value) || !hasExactKeys(value, ["label", "config", "expectedUpdatedAt"])) {
    return errorResponse("invalid preset request", 400);
  }
  const config = isStrictExperience(value.config)
    ? parseEventExperience(value.config)
    : null;
  if (
    typeof value.label !== "string"
    || !config
    || (
      value.expectedUpdatedAt !== null
      && typeof value.expectedUpdatedAt !== "string"
    )
  ) {
    return errorResponse("invalid preset request", 400);
  }
  try {
    return json(safePreset(await deps.store.putEventPreset(presetId, {
      label: value.label,
      config,
      expectedUpdatedAt: value.expectedUpdatedAt,
    })));
  } catch (error) {
    if (error instanceof PresetConflictError) {
      return errorResponse("preset conflict", 409);
    }
    if (error instanceof TypeError) return errorResponse("invalid preset request", 400);
    throw error;
  }
}

export async function postPresetApply(
  req: NextRequest,
  deps: PresetHandlerDeps,
): Promise<NextResponse> {
  const rejected = authorize(req, deps);
  if (rejected) return rejected;
  const params = req.nextUrl.searchParams;
  if (
    Array.from(params.keys()).some((key) => key !== "event")
    || params.getAll("event").length !== 1
  ) {
    return errorResponse("invalid preset apply query", 400);
  }
  let event: string;
  try {
    event = canonicalEvent(params.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return errorResponse(error.message, 400);
    throw error;
  }
  const value = await req.json().catch(() => null);
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["presetId", "mutationId", "baseRevisionId"])
    || !isPresetId(value.presetId)
    || !isRevisionId(value.mutationId)
    || (value.baseRevisionId !== null && !isRevisionId(value.baseRevisionId))
  ) {
    return errorResponse("invalid preset apply request", 400);
  }
  try {
    const result = await deps.store.applyEventPreset(event, {
      presetId: value.presetId,
      mutationId: value.mutationId,
      baseRevisionId: value.baseRevisionId,
    });
    return json({
      ...projectPublicConfig(result.config),
      currentRevisionId: result.revision.id,
      sourcePresetId: value.presetId,
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (error instanceof EventPresetNotFoundError) {
      return errorResponse("preset not found", 404);
    }
    if (error instanceof ConfigConflictError || error instanceof ConfigMutationConflictError) {
      return errorResponse("configuration conflict", 409);
    }
    if (error instanceof TypeError) return errorResponse("invalid preset apply request", 400);
    throw error;
  }
}
