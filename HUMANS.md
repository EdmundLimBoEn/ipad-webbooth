# Human action checklist — Photo Booth

Things only you can do. Everything else (code, Blob store, env vars, production
deploy, adding the domain to the project) is already done.

## One-time (Cloudflare dashboard)

- [x] Bind a custom domain to the R2 bucket (`bucket.photobooth.edmundlim.systems`
  was already attached with SSL active; `R2_PUBLIC_BASE` now points at it,
  2026-07-10). The r2.dev subdomain still works as a fallback.
- [ ] Create a Cloudflare API token with **Account Analytics: Read** and set it
  as the `CF_ANALYTICS_TOKEN` Worker secret
  (`bunx wrangler secret put CF_ANALYTICS_TOKEN`) — enables the health cron's
  request-headroom check (Upload component goes *degraded* at 80% of the
  100k req/day free-tier cap). Until set, the check is silently skipped.
- [ ] Set up a free external uptime monitor (e.g. UptimeRobot) hitting
  `https://photobooth.edmundlim.systems/api/photos?event=uptime` every 5 min —
  this catches a fully dead Worker, which the self-hosted health cron
  structurally can't (a broken deploy kills the cron too).
- [ ] Add a WAF rate-limiting rule on `/api/*` (e.g. block an IP that gets
  many 401s, and cap request rate per IP) — the code has a per-isolate
  micro-cache but the WAF is the real brute-force/DoS backstop.

## One-time (this Mac)

- [ ] Get this repo out of iCloud sync. iCloud's Desktop & Documents sync
  keeps evicting `node_modules` file contents (the source of the random
  `CouldntReadCurrentDirectory` / `ERR_INVALID_PACKAGE_CONFIG` / timeout
  errors and the `" 2"` duplicate files). Either move `~/Documents/apps`
  somewhere unsynced (e.g. `~/dev`), or turn off System Settings → Apple ID →
  iCloud → Drive → Desktop & Documents Folders. Until then, the workaround is
  `rm -rf node_modules && bun install`.

## One-time (statuspage.io health reporting)

- [x] API key created + the four Worker secrets set (2026-07-08; values in
  `EDMUNDS-STUFF.md`). Probes map R2 binding → **Upload**, public bucket →
  **Live page**.
- [ ] After deploy, wait one 5-minute cron tick and confirm both Statuspage
  components stay **Operational** (cron logs: dashboard → Workers →
  ipad-webbooth → Logs).

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
- Lost or leaked booth key mid-event: open `/{event}/admin`, Generate a new
  key, Save. The old key is revoked instantly — devices still holding it get a
  401, drop their saved copy, and prompt for the new key.
- Event galleries are public to anyone who knows the event name — use a
  non-obvious slug (e.g. `tb9-x7k2`, not `wedding`) for private events.
