# iPad Photo Booth

A live-event photo booth for iPad and mobile browsers. Guests capture framed photos at `/{event}` and the projector-friendly Live Gallery at `/{event}/live` receives incremental updates. The application is Next.js on Cloudflare Workers with two R2 stores and no database or WebSockets.

## Event routes

- `/` — build a canonical Event slug and open its Booth, Live Gallery, or Admin.
- `/{event}` — Booth: choose a Frame, capture, composite, and upload.
- `/{event}/live` — public Live Gallery.
- `/{event}/admin` — select Frames, rotate the Booth Key, moderate exact photos, and export.
- `/frame-lab` — calibrate photo slots against artwork and export manifest JSON.

Event slugs are canonical lowercase `a-z`, `0-9`, and hyphens (for example `tb9-x7k2`). API requests reject aliases instead of silently turning different names into the same Event. Gallery URLs are public capabilities, so use an unguessable slug when the event is private.

## Architecture

`EventStore` owns Event keys, configuration, photo ordering, and the incremental Photo Feed:

- `PHOTOS` is the public-delivery R2 bucket. It contains photo bytes at `{event}/{timestamp}-{suffix}.jpg` and the health canary used to test the complete write/read/public-read path.
- `STATE` is private R2 storage. It contains Event configuration and Booth Key hashes under `events/{event}/` plus health reporting state.
- Old `_config/{event}.json` and `_health/state.json` records in `PHOTOS` are read lazily and copied into `STATE`. They are not deleted; rollback remains possible.

The Live Gallery retains the Photo Feed cursor and asks only for objects after it. The Booth Session writes every completed composite to an ordered Photo Outbox before upload. IndexedDB makes the outbox survive reloads and reconnects; if IndexedDB is unavailable, an explicit in-memory degraded mode keeps the current page usable but cannot survive a reload. A later capture can never replace an earlier failed one.

Deletion is exact-key moderation: the admin must supply both a canonical Event and a complete photo key belonging to that Event. There is no prefix or bulk delete route. The safety rule is absolute: never empty either R2 bucket or the Vercel backup store.

Architecture decisions and vocabulary are in [CONTEXT.md](./CONTEXT.md) and [docs/adr](./docs/adr).

## Frame Packs

Each design drop is a Frame Pack under `public/templates/<pack>/` with a `manifest.json` beside its PNG artwork. The manifest declares the canvas, slots, fit, shot count, timing, and draw layers. Create and validate packs with:

```bash
bun run scaffold:frames summer-party "Summer Party"
bun run validate:frames
```

Use `/frame-lab` to load PNG artwork, drag/resize openings in exact canvas pixels, preview the composite, and copy/download the manifest. Put the exported manifest and artwork in the pack directory, then run validation. The Booth always requires a fresh Frame choice after a completed capture.

## Local development and verification

```bash
bun install
bun dev
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
```

`getUserMedia` requires HTTPS or `localhost`; final camera verification must happen on a real iPad or phone. CI runs application type-checking, test type-checking, tests, Frame Pack validation, and a production build.

## Environments and deployment

Local, staging, and production have distinct Worker names, `PHOTOS` buckets, `STATE` buckets, public photo domains, and secrets. A hostname pointing to production is not staging.

```bash
# Exercise staging, then promote the same reviewed source.
bun run deploy:staging
bun run deploy:production
```

The R2 buckets, public bucket custom domains, and Worker secrets must exist before deployment; commands are in [the deployment runbook](./docs/runbooks/deployment.md). Bare `bun run deploy` intentionally fails so an operator must name staging or production; never deploy the unnamed/default Wrangler environment to an event domain.

For the event-day checklist and rollback procedure, see [pre-event readiness](./docs/runbooks/pre-event-readiness.md) and [deployment and rollback](./docs/runbooks/deployment.md).

## Vercel backup reconciliation

The old Vercel Blob store remains a backup. Reconciliation checks R2 and adds only objects that are missing; it never deletes or overwrites either store.

```bash
bun run reconcile:backup -- --env production
```

`bun run migrate:vercel` and `bun scripts/migrate-to-r2.ts` remain compatibility entries for the same additive reconciliation. Keep `BLOB_READ_WRITE_TOKEN` in `.env.local`, never in source or shell history.
