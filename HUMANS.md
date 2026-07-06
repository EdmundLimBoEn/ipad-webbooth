# Human action checklist — Photo Booth

Things only you can do. Everything else (code, Blob store, env vars, production
deploy, adding the domain to the project) is already done.

## One-time (Cloudflare dashboard)

- [ ] Bind a custom domain (e.g. `photos.edmundlim.systems`) to the R2 bucket
  and update `R2_PUBLIC_BASE` in `wrangler.jsonc` — the current r2.dev
  subdomain is rate-limited and not meant for production.
- [ ] Add a WAF rate-limiting rule on `/api/*` (e.g. block an IP that gets
  many 401s, and cap request rate per IP) — the code has a per-isolate
  micro-cache but the WAF is the real brute-force/DoS backstop.

## Per event (before doors open)

- [ ] Open `/{event}/admin`, enter the **admin key** (see `EDMUNDS-STUFF.md`),
  tick the frames that event may use.
- [ ] In the same page, **Generate a booth key**, Save, and record it in
  `EDMUNDS-STUFF.md` — the server only stores a hash. That booth key is what
  you type into the iPad's booth page; it can only upload to this event.
  Until one is set, only the admin key can upload.
- [ ] **Test the camera + both modes on a real iPad before the event** — camera
  capture can't be verified headlessly, only on-device over HTTPS.

## During the event

- Open the booth URL on the iPad in Safari, allow camera access, enter the
  event's booth key when prompted.
- Walk-up flow: pick a 1-photo square frame — **Square / Lighthouse / Beacon
  Square** — or one of the four strip frames — **Beacon / Birthday /
  Baaa-thday / Starry** (3 photos each) — then press the shutter/▶. The
  preview crops to the frame's photo shape so guests frame themselves
  correctly.
- Put the live gallery URL on a laptop/projector/TV. Tap any photo → **Save
  photo** (on phones this opens the share sheet → Save to Photos).
- To remove a photo: Cloudflare dashboard → R2 → `photobooth` bucket → delete the object
  (or `bunx wrangler r2 object delete "photobooth/<event>/<file>.jpg" --remote`).
- Event galleries are public to anyone who knows the event name — use a
  non-obvious slug (e.g. `tb9-x7k2`, not `wedding`) for private events.
