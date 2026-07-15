import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { canonicalEvent, EventStore, InvalidEventSlugError } from "@/app/event-store";
import { adminOk, boothKeyMatches, isImage, MAX_UPLOAD_BYTES } from "@/app/upload-auth";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  let event: string;
  try {
    event = canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const store = EventStore.fromEnv(env);
  const provided = req.headers.get("x-booth-key") ?? "";

  // Two accepted keys: the admin key (BOOTH_UPLOAD_KEY), or this event's own
  // booth key — set per event in /{event}/admin, stored hashed in the config
  // object. A booth key only ever uploads to its own event.
  const admin = adminOk(provided, env.BOOTH_UPLOAD_KEY);
  if (admin === "disabled") {
    return NextResponse.json({ error: "upload disabled: no key configured" }, { status: 503 });
  }
  if (admin === "unauthorized") {
    const cfg = await store.readConfig(event);
    const ok = !!cfg?.boothKeyHash && provided !== "" && (await boothKeyMatches(provided, cfg.boothKeyHash));
    if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Early reject via declared size before buffering the whole body.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }
  if (!isImage(new Uint8Array(body.slice(0, 12)))) {
    return NextResponse.json({ error: "not an image" }, { status: 415 });
  }

  const photo = await store.putPhoto(event, body);
  return NextResponse.json({ url: photo.url });
}
