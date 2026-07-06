import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { adminOk, boothKeyMatches, safeEvent, readEventConfig, isImage, MAX_UPLOAD_BYTES } from "@/app/upload-auth";

// 8 hex chars of randomness — replicates @vercel/blob's addRandomSuffix so
// keys stay unguessable/collision-free without a real filename generator.
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const provided = req.headers.get("x-booth-key") ?? "";

  // Two accepted keys: the admin key (BOOTH_UPLOAD_KEY), or this event's own
  // booth key — set per event in /{event}/admin, stored hashed in the config
  // object. A booth key only ever uploads to its own event.
  const admin = adminOk(provided, env.BOOTH_UPLOAD_KEY);
  if (admin === "disabled") {
    return NextResponse.json({ error: "upload disabled: no key configured" }, { status: 503 });
  }
  if (admin === "unauthorized") {
    const cfg = await readEventConfig(env.PHOTOS, event);
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

  // Key format `${event}/${Date.now()}-${suffix}.jpg` — the ms timestamp stays
  // the leading path segment so the photos route's sort-by-filename (which
  // reads `pathname.split("/")[1].split("-")[0]`) needs no changes.
  const key = `${event}/${Date.now()}-${randomSuffix()}.jpg`;
  await env.PHOTOS.put(key, body, {
    httpMetadata: { contentType: "image/jpeg" },
  });

  return NextResponse.json({ url: `${env.R2_PUBLIC_BASE}/${key}` });
}
