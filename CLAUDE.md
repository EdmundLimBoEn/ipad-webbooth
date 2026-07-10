# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A live event photo booth. An iPad (or any phone) runs a booth page that takes photos; guests
watch them appear on a live gallery within ~3s. Next.js App Router on Cloudflare Workers + R2
via `@opennextjs/cloudflare`. Deployed at `photobooth.edmundlim.systems/<event-name>` (staging:
`photobooth-cf.edmundlim.systems`). See `README.md` for routes and `HUMANS.md` for the manual
steps (Cloudflare dashboard work, per-event setup, on-device camera test). Secrets live in
`EDMUNDS-STUFF.md` (gitignored — never commit or print it).

## Commands

Package manager is **Bun**.

```bash
bun install
bun dev                 # local dev (getUserMedia needs HTTPS or localhost)
bun run build           # production build
bun test                # unit tests (bun:test)
bun test app/templates.test.ts   # a single test file
bun run deploy          # opennextjs-cloudflare build + wrangler deploy (needs `bunx wrangler login` once)
bun run preview         # build + run the real worker locally (miniflare)
```

On macOS 27 `bun run <script>` is broken (`CouldntReadCurrentDirectory` — iCloud Desktop &
Documents sync evicts `node_modules` contents). Use the underlying binaries directly. The
deploy chain that actually works:

```bash
NEXT_PRIVATE_STANDALONE=true ./node_modules/.bin/next build
./node_modules/.bin/opennextjs-cloudflare build --skipNextBuild
OPEN_NEXT_DEPLOY=true node ./node_modules/wrangler/bin/wrangler.js deploy
```

macOS has no `timeout` command (use `gtimeout` or nothing). If `next dev`/`next build` fails,
hangs, or throws `ERR_INVALID_PACKAGE_CONFIG`, suspect evicted/corrupted `node_modules` (a bad
`@swc/helpers/package.json` has done this) — `rm -rf node_modules && bun install` fixes it.
`next.config.ts` pins `outputFileTracingRoot` to this dir because a stray `~/package-lock.json`
otherwise makes Next treat `$HOME` as the workspace root and scan it.

## Safety invariants

- **NEVER bulk-delete or empty photo storage** — not the R2 bucket, not the old Vercel Blob
  store (a `blob empty-store` once wiped real event photos). Both hold live/backup event data.
  Delete test uploads only by exact key/URL under a throwaway event name.
- `FRAMES.pdf` and `SQUARE FRAME.pdf` at the repo root are design sources, **not used at
  runtime** — never Read them (they're MBs and blow up the context). Runtime frame art is the
  PNGs under `public/templates/<group>/`.
- Square-frame photos have a different aspect ratio than the rectangular strips — slot
  positions in `app/templates.ts` are per-template; don't reuse rectangular crop math.

## Architecture

**No database, no websockets.** The R2 bucket (`photobooth`, binding `env.PHOTOS` via
`getCloudflareContext()`) *is* the data model and the gallery polls. Photos are served publicly
straight from the bucket at `R2_PUBLIC_BASE` (a `wrangler.jsonc` var) — image bytes never pass
through the Worker, so only the JSON API counts against the free 100k requests/day.

**Two keys** (helpers in `app/upload-auth.ts`): the **admin key** (`BOOTH_UPLOAD_KEY` Worker
secret) gates config PUT + export + admin; a **per-event booth key** (set on `/{event}/admin`,
stored as a salted PBKDF2 hash in the config object — the bucket is publicly readable, so the
hash is public too and must resist offline brute force) only uploads to its own event. `adminOk()` fails closed when the secret is unset
unless `ALLOW_KEYLESS=1` (local dev, `.env.local`).

- **Upload** (`app/api/upload/route.ts`): accepts the `x-booth-key` header matching the admin key
  or the event's booth-key hash, then `PHOTOS.put()`s the JPEG at `{event}/{Date.now()}-{8-hex}.jpg`
  (the random suffix replicates @vercel/blob's `addRandomSuffix`; the leading ms timestamp is
  load-bearing for sorting).
- **List** (`app/api/photos/route.ts`): `PHOTOS.list({ prefix })` paged via `truncated`/`cursor`
  (capped at 10 pages), sorted **newest-first by the `Date.now()` in the filename** — not by object
  `uploaded`, which is only second-granularity so same-second photos would tie. `force-dynamic`;
  a per-isolate 3s micro-cache absorbs polling floods (photos + config GET both have one).
- **Config** (`app/api/config/route.ts`): per-event frame allowlist + booth-key hash stored at
  `_config/{event}.json` (one object per event; R2 put overwrites). GET is public but only returns
  `frames`/`hasBoothKey`; PUT requires the admin key. `_config/` can never collide with a photo
  prefix because `safeEvent()` never emits an underscore.
- All routes share `safeEvent()` (slugs to `[a-z0-9-]`) from `app/upload-auth.ts`.
  Different event names are fully isolated (separate key prefixes).
- **Export** (`app/api/export/route.ts`): admin-key-gated zip of an event's photos — handwritten
  STORE zip (`app/zip.ts`, table-based crc32 in `app/crc32.ts`; workerd has no `node:zlib` crc32),
  streamed one object at a time so big events don't OOM the 128 MB isolate; rejects past STORE
  zip limits (65,535 files / ~4 GB, no ZIP64).

**Client capture + compositing** is the core logic:

- `app/[event]/page.tsx` (booth, client component): mode picker → sequenced capture → composite →
  upload. Camera frames are grabbed **mirrored** at full res into offscreen canvases, then handed
  to `composite()`. Falls back to `<input capture>` when `getUserMedia` is denied (re-encoded to
  JPEG client-side; frameless by design). The event's booth key is prompted once and kept in
  `localStorage` (`boothKey:{event}`); a 401 clears it and the Retry-upload button re-prompts. A
  failed upload keeps the composited blob for retry — guests' shots are never silently dropped.
- `app/templates.ts` is the single source of truth for the output artwork and is **deliberately
  data-driven** so real design files can be dropped in without touching compositing code. A template
  = `canvas` size + `slots` (photo holes in canvas pixels) + `fit` (`cover` crops to fill / `contain`
  shows the whole photo letterboxed, per-template or per-slot) + optional `background`/`bgImage`
  (behind photos) / `overlay` (frame art on top). `coverRect`/`containRect` are pure and unit-tested
  in `templates.test.ts`; when changing crop/letterbox math, update those tests. When real art
  arrives: set `canvas` to the art's pixel size, add `overlay`/`bgImage` from `public/templates/`,
  and position `slots` to the holes (pixel-measure the design render).
- **Frame groups + per-event allowlist**: templates carry a `group` (key of `GROUPS`, one folder per
  design drop under `public/templates/<group>/`). Ungrouped frames (the pink `square`) are on by
  default but can be unticked; a saved config is the complete per-event frame list. Grouped frames
  only appear at an event once enabled on `/{event}/admin` (admin-key-gated,
  also hosts the booth-key setter and the zip export). The booth filters its picker via `availableTemplates(enabled)` — no
  config/fetch failure degrades to defaults-only, never to all frames. The booth **never
  auto-selects** a frame and returns to the picker after every upload (deliberate UX rule).
- Adding a booth mode = one entry in `TEMPLATES` tagged with its `group` (its `shots`/`intervalMs`
  drive the capture loop) + the group's label in `GROUPS` if new.

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

**Statuspage health cron**: `wrangler.jsonc` `main` is `custom-worker.ts`, which wraps the
OpenNext-generated worker to add a `scheduled` handler (official OpenNext recipe). Every 5 min
it runs `healthCheck()` (`app/health.ts`): probes the R2 binding (→ "Upload" component) and
`R2_PUBLIC_BASE` (→ "Live page" component), keeps last per-component status at
`_health/state.json` (underscore prefix — same no-collision argument as `_config/`), and on
transitions PATCHes the statuspage.io component to `operational`/`degraded_performance`/
`major_outage` via the REST
API (`STATUSPAGE_API_KEY`/`_PAGE_ID`/`_COMPONENT_UPLOAD`/`_COMPONENT_LIVE` secrets; email
automation was ruled out — Worker email sending needs the paid plan). The transition rule
`decide()` is pure and tested in `app/health.test.ts`. Any secret unset → no-op.
The cron also checks free-tier request headroom: `requestsToday()` queries the Cloudflare
GraphQL analytics API (`CF_ANALYTICS_TOKEN` secret + `CF_ACCOUNT_ID` var) and flips the
Upload component to `degraded_performance` at ≥80% of the 100k/day Workers cap — a soft
signal that never escalates to an outage and is skipped when the token is unset or the
query fails. Self-reporting can't catch a fully dead worker (broken deploy kills the cron
too), so an external UptimeRobot check on `/api/photos` covers that case (see HUMANS.md).

## Env vars / secrets

- `BOOTH_UPLOAD_KEY` — the **admin key**. Production: a Worker secret
  (`bunx wrangler secret put BOOTH_UPLOAD_KEY`). Unset → upload/config/export **fail closed**
  (503) everywhere, unless `ALLOW_KEYLESS=1` (only ever set in `.env.local` for local dev).
  Per-event booth keys are data, not env — hashed into `_config/{event}.json` via admin.
- `R2_PUBLIC_BASE` — public base URL of the bucket (`bucket.photobooth.edmundlim.systems`,
  a custom domain bound to the bucket; the old r2.dev subdomain still works as a fallback),
  set in `wrangler.jsonc` `vars`. API routes compose photo URLs as `${R2_PUBLIC_BASE}/${key}`.
- `CF_ANALYTICS_TOKEN` — Worker secret, a Cloudflare API token with Account Analytics Read;
  enables the health cron's request-headroom check (unset → check skipped).
- `STATUSPAGE_API_KEY` / `STATUSPAGE_PAGE_ID` / `STATUSPAGE_COMPONENT_UPLOAD` /
  `STATUSPAGE_COMPONENT_LIVE` — Worker secrets for the health cron's Statuspage REST calls
  (values recorded in `EDMUNDS-STUFF.md`, never in code). All four must be set for
  reporting to happen.
- `BLOB_READ_WRITE_TOKEN` (`.env.local` only) — reaches the **old Vercel Blob store**, which is
  kept as an untouched backup of every pre-migration photo. `scripts/migrate-to-r2.ts` is the
  idempotent copy script (Vercel → R2, never deletes).

## Deployment notes

Worker name `ipad-webbooth`; wrangler is OAuth'd as `limboenedmund@gmail.com`, account
`2132f9cf03d557cc3be87ca4208e683d`. Migrated off Vercel 2026-07-05 — the Workers+R2 vs Vercel
question is settled, don't re-litigate. Photos are served from a custom domain bound to the
bucket (no r2.dev rate limit) and the live-gallery QR is generated locally (`qrcode` npm
package) — no third-party dependency to break on locked-down venue Wi-Fi.

Cloudflare Workers free tier: 100k requests/day. The live gallery polls `/api/photos` every 3s
(~1.2k req/hr per open tab) — fine for 2-3h events, but don't leave galleries polling for days.
Custom domains are declared as `routes` in `wrangler.jsonc` and attach on deploy (the zone
`edmundlim.systems` is on this Cloudflare account).
