# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A live event photo booth. An iPad (or any phone) runs a booth page that takes photos; guests
watch them appear on a live gallery within ~3s. Next.js App Router + Vercel Blob. Deployed at
`photobooth.edmundlim.systems/<event-name>`. See `README.md` for routes and `HUMANS.md` for the
manual setup steps (DNS, on-device camera test, swapping in real border artwork).

## Commands

Package manager is **Bun**.

```bash
bun install
bun dev                 # local dev (getUserMedia needs HTTPS or localhost)
bun run build           # production build
bun test                # unit tests (bun:test)
bun test app/templates.test.ts   # a single test file
vercel --prod --yes     # deploy to production (authoritative build runs remotely)
```

**Local `next build`/`tsc` can hang on this machine** due to a slow network/home-dir setup — when
that happens, verify against the Vercel remote build (`vercel --prod`) instead, which type-checks
and builds authoritatively. `next.config.ts` pins `outputFileTracingRoot` to this dir because a
stray `~/package-lock.json` otherwise makes Next treat `$HOME` as the workspace root and scan it.

## Architecture

**No database, no websockets.** The Blob store *is* the data model and the gallery polls.

- **Upload** (`app/api/upload/route.ts`): checks the `x-booth-key` header against `BOOTH_UPLOAD_KEY`,
  then `put()`s the JPEG at `{event}/{Date.now()}.jpg` (public, `addRandomSuffix`).
- **List** (`app/api/photos/route.ts`): `list({ prefix: event })`, sorted **newest-first by the
  `Date.now()` in the filename** — not by blob `uploadedAt`, which is only second-granularity so
  same-second photos would tie. `force-dynamic`, no caching.
- Both routes slug the event name to `[a-z0-9-]` via an identical `safeEvent()`; keep them in sync.
  Different event names are fully isolated (separate blob prefixes).

**Client capture + compositing** is the core logic:

- `app/[event]/page.tsx` (booth, client component): mode picker → sequenced capture → composite →
  upload. Camera frames are grabbed **mirrored** at full res into offscreen canvases, then handed
  to `composite()`. Falls back to `<input capture>` when `getUserMedia` is denied. The upload key is
  prompted once and kept in `localStorage`.
- `app/templates.ts` is the single source of truth for the output artwork and is **deliberately
  data-driven** so real design files can be dropped in without touching compositing code. A template
  = `canvas` size + `slots` (photo holes in canvas pixels) + `fit` (`cover` crops to fill / `contain`
  shows the whole photo letterboxed, per-template or per-slot) + optional `background`/`bgImage`
  (behind photos) / `overlay` (frame art on top). `coverRect`/`containRect` are pure and unit-tested
  in `templates.test.ts`; when changing crop/letterbox math, update those tests. When real art
  arrives: set `canvas` to the art's pixel size, add `overlay`/`bgImage` from `public/templates/`,
  and position `slots` to the holes (see `HUMANS.md`).
- Adding a booth mode = one entry in `TEMPLATES` (its `shots`/`intervalMs` drive the capture loop).

**Live gallery** (`app/[event]/live/page.tsx`): polls `/api/photos` every 3s. Uncropped **masonry**
(`column-count`) so squares and tall strips coexist. The projector auto-scroll is a **seamless
marquee**: the grid is rendered twice (only when one copy is taller than the viewport), the page
auto-scrolls, and on reaching one copy's height it snaps back by exactly that height onto
pixel-identical content — no visible jump. The loop period is measured as `copyB.offsetTop -
copyA.offsetTop`. Auto-scroll pauses while the lightbox is open and for 4s after any manual
scroll/tap, so mobile viewers can browse/save unimpeded.

**Mobile download** (gallery lightbox `save()`): fetches the blob → `File`, and prefers
`navigator.share({ files })` (native share sheet / Save to Photos on iOS), falling back to an
`<a download>` link on desktop. Cross-origin-safe because it fetches then creates a same-origin
object URL.

## Env vars

- `BLOB_READ_WRITE_TOKEN` — Vercel Blob store token (auto-set when the store is linked; `vercel env pull`).
- `BOOTH_UPLOAD_KEY` — shared upload secret. If unset, uploads are open (the `expected && ...` guard
  short-circuits) — this is why a keyless local `.env.local` lets uploads through while production enforces.

## Deployment notes

Generated `*.vercel.app` URLs sit behind Vercel deployment protection (a login wall); the **custom
domain is public**, which is what the event uses. Don't be alarmed by a 302 on the raw deployment URL.
