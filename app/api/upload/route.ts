import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";

// slugs an event name to a safe blob prefix; anything else -> "event"
function safeEvent(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "event";
}

export async function POST(req: NextRequest) {
  const expected = process.env.BOOTH_UPLOAD_KEY;
  if (expected && req.headers.get("x-booth-key") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  const blob = await put(`${event}/${Date.now()}.jpg`, body, {
    access: "public",
    contentType: "image/jpeg",
    addRandomSuffix: true,
  });

  return NextResponse.json({ url: blob.url });
}
