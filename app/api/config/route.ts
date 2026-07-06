import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { adminOk, hashBoothKey, safeEvent, configPath, readEventConfig } from "@/app/upload-auth";
import { TEMPLATES } from "@/app/templates";

// no caching by Next — the booth reads this on every load and admin edits must
// show up. The micro-cache below only smooths over request floods.
export const dynamic = "force-dynamic";

// ponytail: per-isolate micro-cache so the public GET can't be hammered into
// R2 costs; a WAF rate rule on /api/* is the real backstop (see HUMANS.md).
const microCache = new Map<string, { exp: number; body: string }>();
const TTL = 3000;

// Public: which frames an event has enabled isn't secret, and the booth picker
// needs it before (or without) a key. The booth key hash is deliberately NOT
// returned — only `hasBoothKey`. { frames: null } = no config saved yet.
export async function GET(req: NextRequest) {
  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const hit = microCache.get(event);
  if (hit && hit.exp > Date.now()) {
    return new NextResponse(hit.body, { headers: { "content-type": "application/json" } });
  }
  const { env } = getCloudflareContext();
  const cfg = await readEventConfig(env.PHOTOS, event);
  const frames = Array.isArray(cfg?.frames) ? cfg.frames.filter((f: unknown) => typeof f === "string") : null;
  const body = JSON.stringify({ frames, hasBoothKey: !!cfg?.boothKeyHash });
  if (microCache.size > 200) microCache.clear();
  microCache.set(event, { exp: Date.now() + TTL, body });
  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}

// Admin-key only. Saves the frame allowlist and (optionally) this event's
// booth key — stored as a salted PBKDF2 hash because the config object is
// publicly readable via the bucket's public URL. Omitting boothKey keeps the
// old one.
export async function PUT(req: NextRequest) {
  const { env } = getCloudflareContext();
  const auth = adminOk(req.headers.get("x-booth-key") ?? "", env.BOOTH_UPLOAD_KEY);
  if (auth === "disabled") {
    return NextResponse.json({ error: "config disabled: no key configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const frames = body?.frames;
  if (!Array.isArray(frames) || !frames.every((f) => typeof f === "string" && f in TEMPLATES)) {
    return NextResponse.json({ error: "frames must be an array of template keys" }, { status: 400 });
  }
  const boothKey = body?.boothKey;
  // 12-char floor: the hash is public, so short human-chosen keys are the
  // one thing key-stretching can't save
  if (boothKey !== undefined && (typeof boothKey !== "string" || boothKey.length < 12 || boothKey.length > 128)) {
    return NextResponse.json({ error: "boothKey must be a string of 12-128 chars" }, { status: 400 });
  }

  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const prev = await readEventConfig(env.PHOTOS, event);
  const boothKeyHash = typeof boothKey === "string" ? await hashBoothKey(boothKey) : prev?.boothKeyHash;
  // R2 put() overwrites by default, so this always leaves exactly one config
  // object per event.
  await env.PHOTOS.put(configPath(event), JSON.stringify({ frames, ...(boothKeyHash ? { boothKeyHash } : {}) }), {
    httpMetadata: { contentType: "application/json" },
  });
  microCache.delete(event);

  return NextResponse.json({ frames, hasBoothKey: !!boothKeyHash });
}
