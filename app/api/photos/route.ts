import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";

function safeEvent(raw: string | null): string {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "event";
}

// no caching — the gallery polls this for fresh photos
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const { env } = getCloudflareContext();

  // Page through ALL objects — R2 list() caps a single call (max 1000), so a
  // busy event would otherwise silently drop the newest photos past that.
  const objects: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS.list({ prefix: `${event}/`, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // filenames are `${event}/${Date.now()}-...jpg` — sort by that ms timestamp,
  // which is finer than R2's `uploaded` (still second-ish precision in
  // practice) so same-second photos still order correctly. newest first.
  const ts = (key: string) => Number(key.split("/")[1]?.split("-")[0]) || 0;
  const photos = objects
    .sort((a, b) => ts(b.key) - ts(a.key))
    .map((o) => ({ url: `${env.R2_PUBLIC_BASE}/${o.key}`, uploadedAt: o.uploaded }));

  return NextResponse.json({ photos });
}
