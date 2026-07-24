import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { canonicalEvent, EventStore, InvalidEventSlugError } from "@/app/event-store";
import { adminOk } from "@/app/upload-auth";
import { getPhotos } from "./handlers";

// no caching by Next — the gallery polls this for fresh photos
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { env } = getCloudflareContext();
  return getPhotos(req, { store: EventStore.fromEnv(env) });
}

export async function DELETE(req: NextRequest) {
  const { env } = getCloudflareContext();
  const auth = adminOk(req.headers.get("x-booth-key") ?? "", env.BOOTH_UPLOAD_KEY);
  if (auth === "disabled") return NextResponse.json({ error: "deletion disabled: no key configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let event: string;
  try {
    event = canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const deleted = await EventStore.fromEnv(env).deletePhoto(event, key);
  if (!deleted) return NextResponse.json({ error: "photo not found" }, { status: 404 });
  return NextResponse.json({ deleted: true, key });
}
