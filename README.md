# iPad Photo Booth

Live event photo booth. An iPad (or any phone) runs the booth page, takes photos,
and they appear on a live gallery within ~3s. Next.js + Vercel Blob, no database.

## Routes

- `/{event}` — booth. Live camera, 3-2-1 countdown, shutter, upload.
- `/{event}/live` — auto-refreshing gallery (newest first). Good for a projector/TV.

`{event}` is any name; it's slugged to `a-z0-9-`. Different events don't see each
other's photos.

## Env vars

| Var | What |
|-----|------|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store token (auto-set when you create a Blob store on the project). |
| `BOOTH_UPLOAD_KEY` | Shared secret required to upload. Booth page prompts for it once and stores it in `localStorage`. Leave unset to allow open uploads. |

## Local dev

```bash
bun install
vercel env pull .env.local   # gets BLOB_READ_WRITE_TOKEN
bun dev
```

`getUserMedia` needs HTTPS or `localhost`. Test the camera on the Vercel
preview URL from a real iPad/phone.

## Deploy

```bash
vercel            # preview
vercel --prod     # production
```

Then add the domain `photobooth.edmundlim.systems` to the project (see HUMANS.md
for the DNS step).
