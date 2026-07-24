import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
  InvalidStoredRehearsalError,
  RehearsalConflictError,
  RehearsalEvidenceLimitError,
  RehearsalNotFoundError,
} from "@/app/event-store";
import {
  isRehearsalId,
  parseRehearsalEvidence,
  reduceRehearsal,
  type RehearsalEvidence,
  type RehearsalEvidenceInput,
} from "@/app/rehearsal";
import { adminOk, boothOrAdminOk } from "@/app/upload-auth";

export type RehearsalHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};

type Role = "admin" | "booth";

const BOOTH_EVIDENCE = new Set<RehearsalEvidence["kind"]>([
  "booth-ready",
  "network-failure",
  "outbox-recovered",
  "ordered-drain",
  "outbox-empty",
]);

const json = (body: unknown, init?: ResponseInit) =>
  NextResponse.json(body, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" },
  });

const errorResponse = (error: string, status: number, headers?: HeadersInit) =>
  json({ error }, { status, headers });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactQuery(
  req: NextRequest,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, string | undefined> | NextResponse {
  const params = req.nextUrl.searchParams;
  const allowedSet = new Set(allowed);
  if (
    Array.from(params.keys()).some((key) => !allowedSet.has(key))
    || allowed.some((key) => params.getAll(key).length > 1)
    || required.some((key) => params.getAll(key).length !== 1)
  ) {
    return errorResponse("invalid rehearsal query", 400);
  }
  return Object.fromEntries(allowed.map((key) => [key, params.get(key) ?? undefined]));
}

function eventFrom(value: string | undefined): string | NextResponse {
  try {
    return canonicalEvent(value ?? null);
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return errorResponse(error.message, 400);
    throw error;
  }
}

function authorizeAdmin(
  req: NextRequest,
  deps: RehearsalHandlerDeps,
): NextResponse | null {
  if (!deps.adminKey) {
    return errorResponse("rehearsals disabled: no key configured", 503);
  }
  return adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) === "ok"
    ? null
    : errorResponse("unauthorized", 401);
}

async function authorizeBoothOrAdmin(
  req: NextRequest,
  event: string,
  deps: RehearsalHandlerDeps,
): Promise<Role | NextResponse> {
  if (!deps.adminKey) {
    return errorResponse("rehearsals disabled: no key configured", 503);
  }
  const provided = req.headers.get("x-booth-key") ?? "";
  if (adminOk(provided, deps.adminKey) === "ok") return "admin";
  const config = await deps.store.readConfig(event);
  return await boothOrAdminOk(provided, deps.adminKey, config?.boothKeyHash) === "ok"
    ? "booth"
    : errorResponse("unauthorized", 401);
}

async function parsedBody(req: NextRequest): Promise<unknown> {
  return req.json().catch(() => null);
}

function parseEvidenceInput(
  value: unknown,
  event: string,
  rehearsalId: string,
): RehearsalEvidenceInput | null {
  if (!isRecord(value) || "recordedAt" in value) return null;
  const parsed = parseRehearsalEvidence({
    ...value,
    recordedAt: "2000-01-01T00:00:00.000Z",
  }, event);
  if (
    !parsed
    || parsed.rehearsalId !== rehearsalId
    || !isRehearsalId(parsed.id)
    || parsed.kind === "photo-acknowledged"
  ) {
    return null;
  }
  const { recordedAt: _recordedAt, ...input } = parsed;
  return input;
}

async function readSummary(deps: RehearsalHandlerDeps, event: string, id?: string) {
  const rehearsal = await deps.store.readRehearsal(event, id);
  const config = await deps.store.readConfig(event);
  return {
    ...rehearsal,
    summary: reduceRehearsal({
      ...rehearsal,
      currentRevisionId: config?.currentRevisionId ?? null,
    }),
  };
}

function mapStoreError(error: unknown): NextResponse | null {
  if (error instanceof RehearsalNotFoundError) {
    return errorResponse("rehearsal not found", 404);
  }
  if (error instanceof RehearsalConflictError) {
    return errorResponse("rehearsal evidence conflict", 409);
  }
  if (error instanceof RehearsalEvidenceLimitError) {
    return errorResponse("rehearsal evidence limit reached", 409);
  }
  if (error instanceof InvalidStoredRehearsalError) {
    return errorResponse("rehearsal unavailable", 503);
  }
  if (error instanceof TypeError) {
    return errorResponse("invalid rehearsal request", 400);
  }
  return null;
}

export async function postRehearsal(
  req: NextRequest,
  deps: RehearsalHandlerDeps,
): Promise<NextResponse> {
  const query = exactQuery(req, ["event"], ["event"]);
  if (query instanceof NextResponse) return query;
  const event = eventFrom(query.event);
  if (event instanceof NextResponse) return event;
  const value = await parsedBody(req);
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !isRehearsalId(value.rehearsalId)
  ) {
    return errorResponse("invalid rehearsal request", 400);
  }
  const rejected = authorizeAdmin(req, deps);
  if (rejected) return rejected;
  try {
    const session = await deps.store.startRehearsal(event, {
      rehearsalId: value.rehearsalId,
    });
    return json({ rehearsal: session, serverTime: deps.store.serverTime() });
  } catch (error) {
    const mapped = mapStoreError(error);
    if (mapped) return mapped;
    throw error;
  }
}

export async function getRehearsal(
  req: NextRequest,
  deps: RehearsalHandlerDeps,
): Promise<NextResponse> {
  const query = exactQuery(req, ["event", "id"], ["event"]);
  if (query instanceof NextResponse) return query;
  const event = eventFrom(query.event);
  if (event instanceof NextResponse) return event;
  if (query.id !== undefined && !isRehearsalId(query.id)) {
    return errorResponse("invalid rehearsal ID", 400);
  }
  const rejected = authorizeAdmin(req, deps);
  if (rejected) return rejected;
  try {
    return json({
      rehearsal: await readSummary(deps, event, query.id),
      serverTime: deps.store.serverTime(),
    });
  } catch (error) {
    const mapped = mapStoreError(error);
    if (mapped) return mapped;
    throw error;
  }
}

export async function postRehearsalJoin(
  req: NextRequest,
  deps: RehearsalHandlerDeps,
): Promise<NextResponse> {
  const query = exactQuery(req, ["event"], ["event"]);
  if (query instanceof NextResponse) return query;
  const event = eventFrom(query.event);
  if (event instanceof NextResponse) return event;
  const value = await parsedBody(req);
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || !isRehearsalId(value.rehearsalId)
  ) {
    return errorResponse("invalid rehearsal join", 400);
  }
  const role = await authorizeBoothOrAdmin(req, event, deps);
  if (role instanceof NextResponse) return role;
  try {
    const { session } = await deps.store.readRehearsal(event, value.rehearsalId);
    const config = await deps.store.readConfig(event);
    return json({
      rehearsal: {
        id: session.id,
        startedAt: session.startedAt,
        configRevisionId: session.configRevisionId,
        frames: [...session.frames],
        stale: session.configRevisionId !== (config?.currentRevisionId ?? null),
      },
      serverTime: deps.store.serverTime(),
    });
  } catch (error) {
    const mapped = mapStoreError(error);
    if (mapped) return mapped;
    throw error;
  }
}

export async function postRehearsalEvidence(
  req: NextRequest,
  deps: RehearsalHandlerDeps,
): Promise<NextResponse> {
  const query = exactQuery(req, ["event", "id"], ["event", "id"]);
  if (query instanceof NextResponse) return query;
  const event = eventFrom(query.event);
  if (event instanceof NextResponse) return event;
  if (!isRehearsalId(query.id)) return errorResponse("invalid rehearsal ID", 400);
  const input = parseEvidenceInput(await parsedBody(req), event, query.id);
  if (!input) return errorResponse("invalid rehearsal evidence", 400);
  const role = await authorizeBoothOrAdmin(req, event, deps);
  if (role instanceof NextResponse) return role;
  if (role === "booth" && !BOOTH_EVIDENCE.has(input.kind)) {
    return errorResponse("Admin authorization required", 403);
  }
  try {
    const result = await deps.store.appendRehearsalEvidence(event, query.id, input);
    return json({ ...result, serverTime: deps.store.serverTime() });
  } catch (error) {
    const mapped = mapStoreError(error);
    if (mapped) return mapped;
    throw error;
  }
}
