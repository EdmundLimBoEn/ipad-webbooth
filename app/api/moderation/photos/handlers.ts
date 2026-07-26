import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
} from "@/app/event-store";
import {
  decodeModerationCursor,
  InvalidModerationCursorError,
} from "@/app/moderation";
import { adminOk } from "@/app/upload-auth";

export type ModerationHandlerDeps = {
  store: EventStore;
  adminKey?: string;
  rebuildBatchSize?: number;
};

const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

function authorize(req: NextRequest, deps: ModerationHandlerDeps): NextResponse | null {
  if (!deps.adminKey) return jsonError("moderation disabled: no key configured", 503);
  return adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) === "ok"
    ? null
    : jsonError("unauthorized", 401);
}

function hasOnlySingleQueryKeys(
  params: URLSearchParams,
  allowed: readonly string[]
): boolean {
  return Array.from(params.keys()).every((key) => allowed.includes(key))
    && allowed.every((key) => params.getAll(key).length <= 1);
}

function parseEvent(value: string | null): string | NextResponse {
  try {
    return canonicalEvent(value);
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return jsonError(error.message, 400);
    throw error;
  }
}

export async function getModerationPhotos(
  req: NextRequest,
  deps: ModerationHandlerDeps
): Promise<NextResponse> {
  const authError = authorize(req, deps);
  if (authError) return authError;
  const params = req.nextUrl.searchParams;
  if (!hasOnlySingleQueryKeys(params, ["event", "cursor", "limit", "from", "to"])) {
    return jsonError("invalid moderation query", 400);
  }
  const event = parseEvent(params.get("event"));
  if (event instanceof NextResponse) return event;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
    return jsonError("invalid moderation limit", 400);
  }
  const from = parseOptionalInstant(params.get("from"));
  const to = parseOptionalInstant(params.get("to"));
  if (from === undefined || to === undefined || (from !== null && to !== null && from > to)) {
    return jsonError("invalid moderation time filter", 400);
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    try {
      decodeModerationCursor(cursor, { event, from, to });
    } catch (error) {
      if (error instanceof InvalidModerationCursorError) {
        return jsonError(error.message, 400);
      }
      throw error;
    }
  }

  const page = await deps.store.listModerationPhotos(event, {
    limit: rawLimit === null ? 48 : Number(rawLimit),
    ...(cursor !== null ? { cursor } : {}),
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
  });
  return NextResponse.json({
    photos: page.photos.map((photo) => ({
      key: photo.key,
      url: photo.url,
      uploadedAt: photo.uploadedAt,
      capturedAt: photo.capturedAt,
      ...(photo.source ? { source: photo.source } : {}),
      ...(photo.frameKey ? { frameKey: photo.frameKey } : {}),
    })),
    nextCursor: page.nextCursor,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function postModerationRebuild(
  req: NextRequest,
  deps: ModerationHandlerDeps
): Promise<NextResponse> {
  const authError = authorize(req, deps);
  if (authError) return authError;
  const params = req.nextUrl.searchParams;
  if (!hasOnlySingleQueryKeys(params, ["event"])) {
    return jsonError("invalid moderation rebuild query", 400);
  }
  const event = parseEvent(params.get("event"));
  if (event instanceof NextResponse) return event;
  const batchSize = deps.rebuildBatchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new TypeError("invalid moderation rebuild batch size");
  }
  const result = await deps.store.rebuildPhotoIndex(event, { batchSize });
  return NextResponse.json({
    complete: result.complete,
    scanned: result.scanned,
    indexed: result.indexed,
    checkpoint: result.checkpoint,
  }, {
    status: result.complete ? 200 : 202,
    headers: { "Cache-Control": "no-store" },
  });
}

function parseOptionalInstant(value: string | null): number | null | undefined {
  if (value === null) return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = "", zone, sign, zoneHour, zoneMinute] = match;
  const offsetHour = zone === "Z" ? 0 : Number(zoneHour);
  const offsetMinute = zone === "Z" ? 0 : Number(zoneMinute);
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  const offset = zone === "Z"
    ? 0
    : (sign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const local = new Date(parsed + offset * 60_000);
  const milliseconds = Number(fraction.padEnd(3, "0"));
  if (
    local.getUTCFullYear() !== Number(year)
    || local.getUTCMonth() + 1 !== Number(month)
    || local.getUTCDate() !== Number(day)
    || local.getUTCHours() !== Number(hour)
    || local.getUTCMinutes() !== Number(minute)
    || local.getUTCSeconds() !== Number(second)
    || local.getUTCMilliseconds() !== milliseconds
  ) {
    return undefined;
  }
  return parsed;
}
