# CLAUDE.md

Guidance for coding agents working in this repository. Read `CONTEXT.md` for domain language, `docs/adr/` for settled decisions, and `docs/runbooks/` before release or event operations. Never read or print secrets from `EDMUNDS-STUFF.md`.

## Commands

Use Bun:

```bash
bun install
bun dev
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
```

`getUserMedia` works only on HTTPS or localhost. A browser simulator cannot replace a real iPad camera test. If iCloud has evicted `node_modules`, reinstall dependencies before diagnosing application code.

## Non-negotiable safety

- Never bulk-delete or empty `PHOTOS`, `STATE`, or Vercel Blob. Delete a test or moderated photo only by its complete object key under the intended canonical Event.
- Never make backup reconciliation destructive. `scripts/reconcile-vercel-backup.ts` is add-only and the old `scripts/migrate-to-r2.ts` command is only a compatibility entry.
- Never put Event state or Booth Key hashes into new public objects. `PHOTOS` is public delivery; `STATE` is private operational data.
- Never silently slug an Event at an HTTP interface. UI helpers may suggest a slug, but route handlers use `canonicalEvent()` and reject non-canonical input.
- Never deploy the default/local Wrangler environment to an event domain. Staging and production must stay isolated.
- Root PDFs are design sources, not runtime assets. Runtime artwork and manifests live under `public/templates/<pack>/`.

## Architecture seams

`app/event-store.ts` is the Event Store. It owns canonical Event validation, public and private object keys, photo URLs, the Photo Feed, configuration, exact deletion, and lazy legacy-state migration. Route modules should authenticate and validate HTTP input, then delegate storage behavior to it. Preserve the storage split:

- `PHOTOS`: publicly delivered photo bytes and the short-lived health canary.
- `STATE`: Event configuration, Booth Key hashes, and health transition state.

Legacy `_config/` and `_health/` objects may still exist in `PHOTOS`. Reads lazily copy them to `STATE` without deleting the legacy records, which is required for rollback.

`app/[event]/booth-session/` owns the Booth Session and Photo Outbox. A composite is persisted before network upload and removed only after storage acknowledges it. IndexedDB is the durable implementation; the memory fallback must expose that reload recovery is unavailable. Preserve ordered retry, multi-failure recovery, and event isolation.

`app/frame-packs/` and `public/templates/<pack>/manifest.json` are the Frame Pack source of truth. Do not add bespoke per-frame capture branches. Use `bun run scaffold:frames <key> [label]`, calibrate in `/frame-lab`, and run `bun run validate:frames`. Frame selection is always fresh after a completed capture.

The Live Gallery consumes the incremental Photo Feed. It keeps the returned cursor and requests `after=<cursor>`; do not restore full-bucket polling. Preserve newest-first ordering, the projector marquee, manual-scroll pause, lightbox, and mobile save behavior.

Moderation uses `DELETE /api/photos?event=<event>&key=<complete-key>` with the Admin Key. The Event Store verifies that the key is an image owned by that Event. Never accept a prefix, filename fragment, or cross-Event key.

Health checks write a unique canary to `PHOTOS`, read it through the binding, read the same bytes through `R2_PUBLIC_BASE`, and delete that exact canary in cleanup. Reporting state lives in `STATE`. A binding list alone is not proof that uploads work. External uptime monitoring is still required because a dead Worker cannot run its own cron.

## Release discipline

Wrangler environments `staging` and `production` use separate Worker names, buckets, domains, and secrets. Follow `docs/runbooks/deployment.md`: verify locally, use `bun run deploy:staging`, run smoke checks (including a throwaway exact-key upload/delete), then use `bun run deploy:production`. Bare `bun run deploy` intentionally fails. Roll back Worker code without rolling back or deleting stored data.

Required secrets are environment-specific: `BOOTH_UPLOAD_KEY`, the Statuspage values, and `CF_ANALYTICS_TOKEN`. `ALLOW_KEYLESS=1` is local development only. `BLOB_READ_WRITE_TOKEN` is local-only for backup reconciliation and is never a Worker secret.

CI in `.github/workflows/verify.yml` must continue to run application type-checking, test type-checking via `tsconfig.test.json`, unit tests, Frame Pack validation, and a production build.
