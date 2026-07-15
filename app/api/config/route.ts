import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { canonicalEvent, EventStore, InvalidEventSlugError } from "@/app/event-store";
import { adminOk, hashBoothKey } from "@/app/upload-auth";
import { TEMPLATES } from "@/app/templates";

// no caching by Next — the booth reads this on every load and admin edits must show up.
export const dynamic = "force-dynamic";

// Public: which frames an event has enabled isn't secret, and the booth picker
// needs it before (or without) a key. The booth key hash is deliberately NOT
// returned — only `hasBoothKey`. { frames: null } = no config saved yet.
export async function GET(req: NextRequest) {
  let event: string;
  try {
    event = canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const { env } = getCloudflareContext();
  const cfg = await EventStore.fromEnv(env).readConfig(event);
  const frames = Array.isArray(cfg?.frames) ? cfg.frames.filter((f: unknown) => typeof f === "string") : null;
  return NextResponse.json({ frames, hasBoothKey: !!cfg?.boothKeyHash });
}

// Admin-key only. Saves the frame allowlist and (optionally) this event's
// booth key — stored as a salted PBKDF2 hash in the private STATE bucket.
// Omitting boothKey keeps the old one.
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
  // 12-char floor still protects operator-chosen keys if private state is ever
  // exposed through a backup or configuration mistake.
  if (boothKey !== undefined && (typeof boothKey !== "string" || boothKey.length < 12 || boothKey.length > 128)) {
    return NextResponse.json({ error: "boothKey must be a string of 12-128 chars" }, { status: 400 });
  }

  let event: string;
  try {
    event = canonicalEvent(req.nextUrl.searchParams.get("event"));
  } catch (error) {
    if (error instanceof InvalidEventSlugError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const store = EventStore.fromEnv(env);
  const prev = await store.readConfig(event);
  const boothKeyHash = typeof boothKey === "string" ? await hashBoothKey(boothKey) : prev?.boothKeyHash;
  await store.writeConfig(event, { frames, ...(boothKeyHash ? { boothKeyHash } : {}) });

  return NextResponse.json({ frames, hasBoothKey: !!boothKeyHash });
}
