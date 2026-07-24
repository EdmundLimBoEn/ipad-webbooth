# Deployment and rollback

Staging and production are isolated releases. Each needs its own Worker, public `PHOTOS` bucket, private `STATE` bucket, public photo domain, and secrets. These commands are operator steps; do not run them against Cloudflare merely to inspect the project.

## One-time bootstrap

Create missing buckets (never run `r2 bucket delete`):

```bash
bunx wrangler r2 bucket create photobooth-state
bunx wrangler r2 bucket create photobooth-staging
bunx wrangler r2 bucket create photobooth-state-staging
```

In the Cloudflare dashboard, bind the configured public domain to each `PHOTOS` bucket. Do not enable public access or attach a domain to a `STATE` bucket.

Set secrets separately. Use different Admin Keys:

```bash
bunx wrangler secret put BOOTH_UPLOAD_KEY --env staging
bunx wrangler secret put BOOTH_UPLOAD_KEY --env production
bunx wrangler secret put CF_ANALYTICS_TOKEN --env production
bunx wrangler secret put STATUSPAGE_API_KEY --env production
bunx wrangler secret put STATUSPAGE_PAGE_ID --env production
bunx wrangler secret put STATUSPAGE_COMPONENT_UPLOAD --env production
bunx wrangler secret put STATUSPAGE_COMPONENT_LIVE --env production
```

Set Statuspage secrets on staging only when staging has separate test components. An incomplete set is intentionally a reporting no-op. `ALLOW_KEYLESS` must never be set remotely.

## Verify and deploy

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
bunx playwright install webkit
bun run test:browser
bun run deploy:staging
```

Run the complete real-iPad section in `pre-event-readiness.md` with a
throwaway canonical staging Event that is distinct from production. The
automated WebKit journey does not prove real Safari camera permission,
orientation/crop, camera-indicator shutdown, Add-to-Home-Screen launch,
standalone background/foreground behavior, Screen Wake Lock, IndexedDB
survival across relaunch, Safari cross-tab leases, venue-network reconnect
timing, real multi-shot pause timing, or camera/wake release during Operator
exit.

Confirm staging photos do not appear in production and staging config does not
affect production. For smoke-test moderation, delete only one complete
Event-owned throwaway image key. Stop promotion on any failed real-device
check. Only after recording a passing iPad rehearsal should you promote
explicitly:

```bash
bun run deploy:production
```

After production deployment, verify the home page, Event config read/write, one exact-key throwaway upload/delete, incremental Live Gallery arrival, export, Worker logs, and the next health cron tick. The canary proves R2 write/read and public delivery; external uptime proves the Worker can be reached.

## Lazy legacy-state migration

The first read of an Event whose config exists only at `PHOTOS/_config/{event}.json` copies it to `STATE/events/{event}/config.json`. Health state migrates similarly. The legacy objects stay in place for rollback. Validate important Events through Admin after introducing a new `STATE` bucket; do not bulk-move or delete legacy objects.

The former Vercel migration is now backup reconciliation:

```bash
bun run reconcile:backup -- --env production
```

It checks each destination key, copies only missing Vercel objects into production `PHOTOS`, and never deletes or overwrites either side. `bun run migrate:vercel` remains a compatibility alias.

## Rollback

1. Stop promotion. If only staging is affected, leave production untouched.
2. Identify the last known-good source revision, rebuild it with OpenNext, and deploy that revision with the explicit affected environment, for example `bun run deploy:production`.
3. Do not roll back, empty, or recreate `PHOTOS` or `STATE`. Code rollback and data deletion are unrelated operations.
4. Keep legacy `_config/` and `_health/` objects. They are the compatibility path for older code.
5. Smoke-test authentication, config, one throwaway upload, Live Gallery, exact-key deletion, and export.
6. Confirm health and external uptime, then document the failed version and symptoms before retrying.

If the current code writes a state shape older code cannot read, roll forward with a compatibility fix rather than editing live objects by hand.
