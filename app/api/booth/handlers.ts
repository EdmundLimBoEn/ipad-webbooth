import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
} from "@/app/event-store";
import {
  parseBoothHeartbeat,
  parseBoothOperationalStateInput,
} from "@/app/booth-control";
import { projectEventExperience } from "@/app/event-config";
import { adminOk, boothOrAdminOk } from "@/app/upload-auth";

export type BoothControlHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};

const MAX_EVENT_LENGTH = 128;
const MAX_BODY_BYTES = 16 * 1024;

type BoothListQuery = { event: string; cursor?: string; limit?: number };
type JsonBody = { value: unknown } | { response: NextResponse };

const jsonError = (error: string, status: number) =>
  NextResponse.json({ error }, { status });

function hasOnlyQueryKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
  return Array.from(params.keys()).every((key) => allowed.includes(key))
    && allowed.every((key) => params.getAll(key).length <= 1);
}

function eventFrom(req: NextRequest, allowedQueryKeys: readonly string[]): string | NextResponse {
  const params = req.nextUrl.searchParams;
  if (!hasOnlyQueryKeys(params, allowedQueryKeys)) {
    return jsonError("invalid Booth control query", 400);
  }

  const raw = params.get("event");
  if (raw !== null && raw.length > MAX_EVENT_LENGTH) {
    return jsonError("invalid Booth control Event", 400);
  }
  try {
    return canonicalEvent(raw);
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return jsonError(error.message, 400);
    throw error;
  }
}

function listQueryFrom(req: NextRequest): BoothListQuery | NextResponse {
  const event = eventFrom(req, ["event", "cursor", "limit"]);
  if (event instanceof NextResponse) return event;
  const { searchParams } = req.nextUrl;
  const rawCursor = searchParams.get("cursor");
  const rawLimit = searchParams.get("limit");
  if (rawCursor !== null && rawCursor.length === 0) {
    return jsonError("invalid Booth heartbeat cursor", 400);
  }
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
    return jsonError("invalid Booth heartbeat limit", 400);
  }
  return {
    event,
    ...(rawCursor !== null ? { cursor: rawCursor } : {}),
    ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
  };
}

function requireConfiguredAdmin(req: NextRequest, deps: BoothControlHandlerDeps): NextResponse | null {
  // Unlike local upload convenience, control-plane mutations and unlock
  // preflight never become keyless. A missing Worker secret is unavailable.
  if (!deps.adminKey) return jsonError("Booth control disabled: no key configured", 503);
  return adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) === "ok"
    ? null
    : jsonError("unauthorized", 401);
}

async function parseJsonBody(req: NextRequest): Promise<JsonBody> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return { response: jsonError("Booth control body is too large", 413) };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { response: jsonError("Booth control body is too large", 413) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { response: jsonError("invalid Booth control request", 400) };
  }
}

async function requireEmptyBody(req: NextRequest): Promise<NextResponse | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return jsonError("Booth control body is too large", 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return jsonError("Booth control body is too large", 413);
  }
  return text.length === 0 ? null : jsonError("Booth control request body is not allowed", 400);
}

async function authorizeBooth(
  req: NextRequest,
  deps: BoothControlHandlerDeps,
  boothKeyHash?: string
): Promise<NextResponse | null> {
  if (!deps.adminKey) return jsonError("Booth control disabled: no key configured", 503);
  const auth = await boothOrAdminOk(
    req.headers.get("x-booth-key") ?? "",
    deps.adminKey,
    boothKeyHash
  );
  if (auth === "ok") return null;
  if (auth === "disabled") return jsonError("Booth control disabled: no key configured", 503);
  return jsonError("unauthorized", 401);
}

/** Authenticated, safe readiness contract for a Booth before it starts capture. */
export async function postBoothPreflight(
  req: NextRequest,
  deps: BoothControlHandlerDeps
): Promise<NextResponse> {
  const event = eventFrom(req, ["event"]);
  if (event instanceof NextResponse) return event;
  const bodyError = await requireEmptyBody(req);
  if (bodyError) return bodyError;

  if (!deps.adminKey) return jsonError("Booth control disabled: no key configured", 503);
  const config = await deps.store.readConfig(event);
  const authError = await authorizeBooth(req, deps, config?.boothKeyHash);
  if (authError) return authError;
  if (!config || config.frames.length === 0) {
    return jsonError("Booth Event has no enabled Frames", 409);
  }

  const operationalState = await deps.store.readBoothOperationalState(event);
  return NextResponse.json({
    experience: projectEventExperience(config),
    operationalState,
    serverTime: new Date().toISOString(),
  });
}

/** Accepts the tightly allowlisted private status snapshot from one Booth. */
export async function postBoothHeartbeat(
  req: NextRequest,
  deps: BoothControlHandlerDeps
): Promise<NextResponse> {
  const event = eventFrom(req, ["event"]);
  if (event instanceof NextResponse) return event;
  if (!deps.adminKey) return jsonError("Booth control disabled: no key configured", 503);

  // Validate before resolving an Event Booth Key: readConfig() can perform a
  // lazy legacy migration, so invalid input must not cause a STATE write.
  const body = await parseJsonBody(req);
  if ("response" in body) return body.response;
  const heartbeat = parseBoothHeartbeat(body.value);
  if (!heartbeat) return jsonError("invalid Booth heartbeat", 400);

  let authError = await authorizeBooth(req, deps);
  if (authError && authError.status === 401) {
    const config = await deps.store.readConfig(event);
    authError = await authorizeBooth(req, deps, config?.boothKeyHash);
  }
  if (authError) return authError;

  return NextResponse.json(await deps.store.writeBoothHeartbeat(event, heartbeat));
}

/** Admin-only paginated view of private Booth heartbeat records. */
export async function getBoothHeartbeats(
  req: NextRequest,
  deps: BoothControlHandlerDeps
): Promise<NextResponse> {
  const query = listQueryFrom(req);
  if (query instanceof NextResponse) return query;
  const bodyError = await requireEmptyBody(req);
  if (bodyError) return bodyError;
  const adminError = requireConfiguredAdmin(req, deps);
  if (adminError) return adminError;

  return NextResponse.json(await deps.store.listBoothHeartbeats(query.event, {
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  }));
}

/** Public pause/message state only; device and configuration state remain private. */
export async function getBoothState(
  req: NextRequest,
  deps: BoothControlHandlerDeps
): Promise<NextResponse> {
  const event = eventFrom(req, ["event"]);
  if (event instanceof NextResponse) return event;
  const bodyError = await requireEmptyBody(req);
  if (bodyError) return bodyError;

  return NextResponse.json(await deps.store.readBoothOperationalState(event), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Admin-only replacement of the safe, bounded public operational state. */
export async function putBoothState(
  req: NextRequest,
  deps: BoothControlHandlerDeps
): Promise<NextResponse> {
  const event = eventFrom(req, ["event"]);
  if (event instanceof NextResponse) return event;
  const adminError = requireConfiguredAdmin(req, deps);
  if (adminError) return adminError;

  const body = await parseJsonBody(req);
  if ("response" in body) return body.response;
  const operationalState = parseBoothOperationalStateInput(body.value);
  if (!operationalState) return jsonError("invalid Booth operational state", 400);

  return NextResponse.json(await deps.store.writeBoothOperationalState(event, operationalState), {
    headers: { "Cache-Control": "no-store" },
  });
}
