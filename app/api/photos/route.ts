import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextRequest, NextResponse } from "next/server";
import { safeEvent } from "@/app/upload-auth";

// no caching by Next — the gallery polls this for fresh photos
export const dynamic = "force-dynamic";

// ponytail: per-isolate micro-cache (TTL matches the gallery's 3s poll) —
// collapses any number of polling tabs (or a request flood) into ~1 R2 list
// per 3s per isolate. A WAF rate rule on /api/* is the real abuse backstop
// (see HUMANS.md).
const microCache = new Map<string, { exp: number; body: string }>();
const TTL = 3000;
// ponytail: caps worst-case R2 list cost per call at 10k photos; past that the
// newest get dropped (list is oldest-first) — no real 2-3h event gets close.
const MAX_PAGES = 10;

export async function GET(req: NextRequest) {
  const event = safeEvent(req.nextUrl.searchParams.get("event"));
  const hit = microCache.get(event);
  if (hit && hit.exp > Date.now()) {
    return new NextResponse(hit.body, { headers: { "content-type": "application/json" } });
  }
  const { env } = getCloudflareContext();

  // Page through the prefix — R2 list() caps a single call at 1000 keys, so a
  // busy event would otherwise silently drop photos past that.
  const objects: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await env.PHOTOS.list({ prefix: `${event}/`, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && ++pages < MAX_PAGES);

  // filenames are `${event}/${Date.now()}-...jpg` — sort by that ms timestamp,
  // which is finer than R2's `uploaded` (still second-ish precision in
  // practice) so same-second photos still order correctly. newest first.
  const ts = (key: string) => Number(key.split("/")[1]?.split("-")[0]) || 0;
  const photos = objects
    .sort((a, b) => ts(b.key) - ts(a.key))
    .map((o) => ({ url: `${env.R2_PUBLIC_BASE}/${o.key}`, uploadedAt: o.uploaded }));

  const body = JSON.stringify({ photos });
  if (microCache.size > 200) microCache.clear();
  microCache.set(event, { exp: Date.now() + TTL, body });
  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}
