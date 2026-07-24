import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
  InvalidPhotoCursorError,
} from "@/app/event-store";

export type PhotoHandlerDeps = { store: EventStore };

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
    return NextResponse.json(await deps.store.listPhotos(event, after));
  } catch (error) {
    if (error instanceof InvalidPhotoCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
