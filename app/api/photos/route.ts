import { list } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";

function safeEvent(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "event";
}

// no caching — the gallery polls this for fresh photos
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const event = safeEvent(req.nextUrl.searchParams.get("event"));

  // Page through ALL blobs — list() returns max 1000 per call, so a busy event
  // would otherwise silently drop the newest photos past that.
  const blobs = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `${event}/`, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  // filenames are `${event}/${Date.now()}-...jpg` — sort by that ms timestamp,
  // which is finer than blob uploadedAt (second granularity) so same-second
  // photos still order correctly. newest first.
  const ts = (pathname: string) => Number(pathname.split("/")[1]?.split("-")[0]) || 0;
  const photos = blobs
    .sort((a, b) => ts(b.pathname) - ts(a.pathname))
    .map((b) => ({ url: b.url, uploadedAt: b.uploadedAt }));

  return NextResponse.json({ photos });
}
