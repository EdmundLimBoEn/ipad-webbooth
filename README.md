# iPad Photo Booth

Live event photo booth. An iPad (or any phone) runs the booth page, takes photos,
and they appear on a live gallery within ~3s. Next.js on Cloudflare Workers +
R2 (via `@opennextjs/cloudflare`), no database.

## Routes

- `/{event}` — booth. Live camera, 3-2-1 countdown, shutter, upload. After each
  photo it returns to the frame picker.
- `/{event}/live` — auto-refreshing gallery (newest first). Good for a projector/TV.
- `/{event}/admin` — event admin (needs the admin key): choose which frames the
  booth offers at this event, set the event's booth key, and export all photos
  as a zip.

`{event}` is any name; it's slugged to `a-z0-9-`. Different events don't see each
other's photos. Galleries are public to anyone who knows the event name, so use
a non-obvious slug for private events.

By default a new event's booth only offers the pink Square frame. Extra frames
(grouped per design drop, e.g. Talent Beacon 9 Anniversary) must be enabled per
event on its admin page; the allowlist is stored as an R2 object at
`_config/{event}.json`.

## Storage / env

Photos live in the R2 bucket `photobooth` (binding `PHOTOS` in `wrangler.jsonc`),
served publicly from `R2_PUBLIC_BASE`. Two kinds of key:

- **Admin key** — `BOOTH_UPLOAD_KEY`, a Worker secret in production
  (`bunx wrangler secret put BOOTH_UPLOAD_KEY`). Gates the admin page, config
  saves, and the zip export.
- **Booth key** — per event, set on `/{event}/admin` (stored as a salted
  PBKDF2 hash in `_config/{event}.json`, since the bucket is publicly readable). Only
  uploads photos to its own event; this is the key the booth page prompts for
  and keeps in `localStorage`. Until one is set, only the admin key can upload.

With no admin key configured, the API fails closed unless `ALLOW_KEYLESS=1`
(set in `.env.local` for local dev only).

The old Vercel Blob store still holds a pre-migration copy of every photo as a
backup (`BLOB_READ_WRITE_TOKEN` in `.env.local` reaches it; `scripts/migrate-to-r2.ts`
re-copies anything new).

## Local dev

```bash
bun install
bun dev
```

`getUserMedia` needs HTTPS or `localhost`. Test the camera on the deployed URL
from a real iPad/phone.

## Deploy

```bash
bun run deploy    # opennextjs-cloudflare build + deploy
```

On macOS 27 `bun run` is currently broken — deploy with the underlying
commands instead:

```bash
./node_modules/.bin/next build
bunx opennextjs-cloudflare build --skipNextBuild
OPEN_NEXT_DEPLOY=true bunx wrangler deploy
```

Custom domains (`photobooth.edmundlim.systems`, staging `photobooth-cf.…`) are
declared in `wrangler.jsonc` and attach on deploy.
