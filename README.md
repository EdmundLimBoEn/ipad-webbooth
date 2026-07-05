# iPad Photo Booth

Live event photo booth. An iPad (or any phone) runs the booth page, takes photos,
and they appear on a live gallery within ~3s. Next.js on Cloudflare Workers +
R2 (via `@opennextjs/cloudflare`), no database.

## Routes

- `/{event}` — booth. Live camera, 3-2-1 countdown, shutter, upload. After each
  photo it returns to the frame picker.
- `/{event}/live` — auto-refreshing gallery (newest first). Good for a projector/TV.
- `/{event}/admin` — event admin (needs the upload key): choose which frames the
  booth offers at this event, and export all photos as a zip.
- `/{event}/export` — photo zip export only (same key).

`{event}` is any name; it's slugged to `a-z0-9-`. Different events don't see each
other's photos.

By default a new event's booth only offers the pink Square frame. Extra frames
(grouped per design drop, e.g. Talent Beacon 9 Anniversary) must be enabled per
event on its admin page; the allowlist is stored as an R2 object at
`_config/{event}.json`.

## Storage / env

Photos live in the R2 bucket `photobooth` (binding `PHOTOS` in `wrangler.jsonc`),
served publicly from `R2_PUBLIC_BASE`. `BOOTH_UPLOAD_KEY` is the shared upload
secret — a Worker secret in production (`bunx wrangler secret put BOOTH_UPLOAD_KEY`),
`.env.local` for dev. The booth page prompts for it once and stores it in
`localStorage`.

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

Custom domains (`photobooth.edmundlim.systems`, staging `photobooth-cf.…`) are
declared in `wrangler.jsonc` and attach on deploy.
