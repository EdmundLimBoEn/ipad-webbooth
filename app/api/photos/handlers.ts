import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
  InvalidPhotoCursorError,
} from "@/app/event-store";
import { adminOk } from "@/app/upload-auth";

export type PhotoHandlerDeps = { store: EventStore; adminKey?: string };

export async function getPhotos(req: NextRequest, deps: PhotoHandlerDeps): Promise<NextResponse> {
  let event: string;
  try {
    event = canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const after = req.nextUrl.searchParams.get("after") ?? req.nextUrl.searchParams.get("cursor");
  try {
    return NextResponse.json(await deps.store.listPhotos(event, after), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InvalidPhotoCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function deletePhoto(
  req: NextRequest,
  deps: PhotoHandlerDeps
): Promise<NextResponse> {
  if (!deps.adminKey) {
    return NextResponse.json(
      { error: "deletion disabled: no key configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (adminOk(req.headers.get("x-booth-key") ?? "", deps.adminKey) !== "ok") {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const params = req.nextUrl.searchParams;
  if (
    Array.from(params.keys()).some((key) => key !== "event" && key !== "key")
    || params.getAll("event").length !== 1
    || params.getAll("key").length !== 1
  ) {
    return NextResponse.json(
      { error: "invalid photo deletion query" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  let event: string;
  try {
    event = canonicalEvent(params.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }
  const key = params.get("key");
  if (!key) {
    return NextResponse.json(
      { error: "key is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  const result = await deps.store.deletePhoto(event, key);
  if (!result.deleted) {
    return NextResponse.json(
      { error: "photo not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json({
    deleted: true,
    key,
    cleanupPending: result.cleanup.index === "failed" || result.cleanup.receipt === "failed",
  }, { headers: { "Cache-Control": "no-store" } });
}
