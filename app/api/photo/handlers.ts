import { NextRequest, NextResponse } from "next/server";
import {
  canonicalEvent,
  EventStore,
  InvalidEventSlugError,
  InvalidPublicPhotoKeyError,
} from "@/app/event-store";

export type PublicPhotoHandlerDeps = { store: EventStore };

export async function getPublicPhoto(
  request: NextRequest,
  deps: PublicPhotoHandlerDeps
): Promise<NextResponse> {
  let event: string;
  try {
    event = canonicalEvent(request.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const keys = request.nextUrl.searchParams.getAll("key");
  if (keys.length !== 1 || !keys[0]) {
    return NextResponse.json({ error: "key must be a complete Event-owned image key" }, { status: 400 });
  }

  try {
    const photo = await deps.store.getPublicPhoto(event, keys[0]);
    if (!photo) return NextResponse.json({ error: "photo not found" }, { status: 404 });
    return NextResponse.json(photo, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidPublicPhotoKeyError) {
      return NextResponse.json({ error: "key must be a complete Event-owned image key" }, { status: 400 });
    }
    throw error;
  }
}
