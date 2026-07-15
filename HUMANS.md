# Human action checklist

Cloudflare account changes and event-day physical checks require an operator. Agents must not perform these remote mutations without explicit authorization.

## Environment bootstrap (one time)

- [ ] Create `photobooth-state` for production private state.
- [ ] Create `photobooth-staging` and `photobooth-state-staging`; do not reuse either production bucket.
- [ ] Bind a public custom domain to the staging photo bucket (the configured `R2_PUBLIC_BASE` is `bucket-cf.photobooth.edmundlim.systems`). Do not expose either `STATE` bucket publicly.
- [ ] Confirm `bucket.photobooth.edmundlim.systems` remains bound only to production `PHOTOS`.
- [ ] Set a different `BOOTH_UPLOAD_KEY` in each environment with `bunx wrangler secret put BOOTH_UPLOAD_KEY --env staging` and `--env production`.
- [ ] Set production Statuspage secrets and `CF_ANALYTICS_TOKEN` using `--env production`. For staging, either use separate test components or leave the complete Statuspage secret set absent so reporting is a no-op.
- [ ] Configure external uptime monitoring against the production photos API. Self-hosted cron cannot detect a Worker that is completely down.
- [ ] Add Cloudflare rate limiting for `/api/*`, particularly repeated authentication failures.

Exact bucket and secret commands, smoke tests, and rollback steps are in `docs/runbooks/deployment.md`.

## Workstation (one time)

- [ ] Keep the repository outside iCloud Desktop/Documents synchronization. Evicted `node_modules` has caused false package and build failures.
- [ ] Keep `BLOB_READ_WRITE_TOKEN` only in `.env.local`. Run `bun run reconcile:backup -- --env production` when Vercel may contain photos missing from R2. Reconciliation is add-only; never empty either store.

## Before every event

- [ ] Complete `docs/runbooks/pre-event-readiness.md` on the staging deployment first, then production.
- [ ] Use the home page to choose and copy the final canonical Event slug. Avoid names that normalize ambiguously; APIs reject non-canonical aliases.
- [ ] Open `/{event}/admin`, select Frames, generate and save a Booth Key, and store the plaintext key securely—the server stores only its hash in private `STATE`.
- [ ] Exercise every enabled Frame on a real iPad over HTTPS, including camera permission, capture, reload recovery, upload, gallery arrival, and save/share.
- [ ] Test the projector and venue network, then keep a second network path available.

## During the event

- Watch the Booth's pending-photo count. Pending photos remain in the IndexedDB Photo Outbox and retry in order; do not clear site data or uninstall the browser while any are pending. A visible degraded-persistence warning means a reload would lose queued photos.
- Moderate only through the Event Admin UI. Confirm the thumbnail and exact object key before deletion; there is no bulk/prefix delete.
- If a Booth Key leaks, generate and save a replacement. Existing devices are rejected and prompted for the new key on their next upload.
- Keep the Live Gallery open at `/{event}/live`. It uses an incremental cursor and should not require manual refresh.

## After the event

- Confirm the Photo Outbox is empty before taking the Booth device offline.
- Export the Event from Admin and verify the archive opens.
- Do not delete the Event from R2 or Vercel Blob. Retention/removal is a separate, exact-key operator decision.
