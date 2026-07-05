import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { keyOk } from "@/app/upload-auth";
import { TEMPLATES } from "@/app/templates";

// slugs an event name to a safe blob prefix; anything else -> "event".
// Keep in sync with the copies in the upload/photos/export routes.
function safeEvent(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "event";
}

// Per-event config lives at `_config/{event}.json` — safeEvent can never emit
// an underscore, so this prefix can't collide with any event's photo prefix.
const configPath = (event: string) => `_config/${event}.json`;

// no caching — the booth reads this on every load and admin edits must show up
export const dynamic = "force-dynamic";

// Public: which frames an event has enabled isn't secret, and the booth picker
// needs it before (or without) the upload key. { frames: null } = no config
// saved yet, meaning defaults only.
export async function GET(req: NextRequest) {
  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const { env } = getCloudflareContext();
  const obj = await env.PHOTOS.get(configPath(event));
  if (!obj) return NextResponse.json({ frames: null });
  const cfg = await obj.json<{ frames?: unknown }>().catch(() => null);
  const frames = Array.isArray(cfg?.frames) ? cfg.frames.filter((f: unknown) => typeof f === "string") : null;
  return NextResponse.json({ frames });
}

export async function PUT(req: NextRequest) {
  const { env } = getCloudflareContext();
  const expected = env.BOOTH_UPLOAD_KEY;
  if (!expected) {
    // Fail closed in production, same as the upload route.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "config disabled: no key configured" }, { status: 503 });
    }
  } else if (!keyOk(req.headers.get("x-booth-key") ?? "", expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const frames = body?.frames;
  if (!Array.isArray(frames) || !frames.every((f) => typeof f === "string" && f in TEMPLATES)) {
    return NextResponse.json({ error: "frames must be an array of template keys" }, { status: 400 });
  }

  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  // R2 put() overwrites by default, so this always leaves exactly one config
  // object per event (unlike @vercel/blob, no addRandomSuffix option to worry about).
  await env.PHOTOS.put(configPath(event), JSON.stringify({ frames }), {
    httpMetadata: { contentType: "application/json" },
  });

  return NextResponse.json({ frames });
}
