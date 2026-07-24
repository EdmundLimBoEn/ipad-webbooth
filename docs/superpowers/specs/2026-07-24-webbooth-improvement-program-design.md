# Webbooth improvement program

**Date:** 2026-07-24  
**Status:** Draft for review

## Problem

Webbooth already has strong storage isolation, exact-key moderation, durable
photo recovery, data-driven Frames, and staged releases. Its remaining risks
are concentrated at the product boundaries:

- The Booth can appear usable before its credential, camera, storage, or
  upload path has been verified.
- Temporary upload failures require operator intervention, and a lost upload
  response can produce a duplicate when retried.
- Admin cannot see whether an actual Booth device is healthy or whether its
  local Photo Outbox is draining.
- The projector Live Gallery also serves phone users, despite those audiences
  needing different interaction models.
- Configuration has no immutable history, reusable presets, or private capture
  metadata for meaningful post-event reporting.

This program delivers the fifteen approved improvements without weakening the
accepted architecture or event-day safety rules.

## Goals

1. Make a Booth prove readiness before accepting guests.
2. Recover from transient connectivity failures automatically and without
   duplicate photos.
3. Give operators private, actionable device and rehearsal evidence.
4. Improve capture review, personal photo handoff, accessibility, and
   localization without reducing guest throughput.
5. Separate projector and phone gallery experiences while retaining the
   incremental Photo Feed.
6. Make moderation scale beyond the recent contact sheet without weakening
   complete-key Event ownership checks.
7. Add immutable configuration history, reusable safe presets, and richer
   streamed post-event packages.

## Non-goals

- No database, WebSockets, or Durable Object control plane.
- No guest accounts, facial recognition, personal profiles, or stable guest
  identifiers.
- No bulk, prefix, or cross-Event photo deletion.
- No secret, operational record, index, or metadata sidecar in public
  `PHOTOS`.
- No background-upload guarantee after iOS has killed or suspended the app.
- No replacement for the real-iPad and projector rehearsal.
- No automatic deletion or destructive migration of legacy records.

## Approaches considered

### Reliability-first

Complete Booth and operations work before guest-facing changes. This minimizes
event-day risk but delays visible product value.

### Guest-experience-first

Ship review, handoff, browse gallery, and localization first. This produces the
fastest visible improvement but builds on an upload contract that is not yet
idempotent.

### Balanced dependency ladder — selected

First establish immutable configuration, stable capture identity, and shared
authentication. Then ship Booth reliability, guest capture, gallery and
moderation, operator reuse, and post-event reporting as independent releases.
This gives early reliability wins while keeping every release deployable and
reversible at the Worker-code level.

## Architectural decisions

### Preserve the existing seams

- `app/event-store.ts` remains the only owner of `PHOTOS` and `STATE` keys,
  photo identity, configuration, indexes, exact deletion, and migrations.
- Route handlers authenticate, canonicalize and validate HTTP input, then
  delegate storage behavior to the Event Store.
- The Booth Session owns accepted-photo durability, ordering, retry, and
  upload acknowledgment.
- Frame manifests continue to drive capture. A completed capture always
  returns to a fresh Frame choice.
- The Live Gallery and new browse Gallery share a Photo Feed controller but
  keep separate presentations.

### Make uploads idempotent before retrying automatically

Every accepted capture receives one cryptographically random `captureId` and
one monotonic `capturedAt` when it enters the Photo Outbox. The upload sends
both values. The Event Store validates them and derives the same exact object
key on every attempt:

```text
{event}/{13-digit-capturedAt}-{captureId}.jpg
```

A retry therefore acknowledges the existing object instead of creating a
second photo. Old Booth clients without the new headers keep the current
random-key upload path during rollout.

The upload response adds `key`, `url`, and `duplicate` without removing the
existing `url` field.

### Keep operational state out of revisioned experience configuration

Long-lived Event experience settings are revisioned. Transient pause state,
device heartbeats, rehearsals, health, and photo indexes have separate private
records. Pausing a Booth does not create a configuration revision.

### Use private, rebuildable derived records

Photo metadata and the moderation index live in `STATE`. `PHOTOS` remains the
source of truth for whether a photo exists. Derived records are add-only or
exact-key cleaned, can tolerate partial failure, and can be rebuilt from
stored photos.

## Private data model

All keys below are in `STATE`:

```text
events/{event}/config.json
events/{event}/config-revisions/{revisionId}.json
events/{event}/booth-state.json
events/{event}/booths/{deviceId}.json
events/{event}/rehearsals/{rehearsalId}/session.json
events/{event}/rehearsals/{rehearsalId}/evidence/{time}-{id}.json
events/{event}/rehearsals/latest.json
events/{event}/photo-index/v1/{inverseTime}-{encodedPhotoKey}.json
events/{event}/photo-metadata/{photoFilename}.json
presets/{presetId}.json
```

No new object type is stored under the public photo prefix except image bytes.

### Event experience and revisions

```ts
type EventExperience = {
  frames: string[];
  locales?: LocaleCode[];
  defaultLocale?: LocaleCode;
  timeZone?: string;
  capture?: {
    reviewEnabled?: boolean;
    autoAcceptSeconds?: number;
    countdownAudioDefault?: boolean;
  };
  gallery?: {
    title?: string;
    accentColor?: string;
  };
};

type EventConfig = EventExperience & {
  boothKeyHash?: string;
  currentRevisionId?: string;
};

type ConfigRevision = {
  version: 1;
  id: string;
  createdAt: string;
  parentRevisionId: string | null;
  reason: "baseline" | "save" | "restore" | "preset";
  sourceRevisionId?: string;
  sourcePresetId?: string;
  config: EventExperience;
};
```

Revision records cannot contain a Booth Key hash. Saving requires a client
mutation ID and the current base revision. A stale base returns `409`. The
first revision-aware save appends a baseline for the legacy head. Restore
creates a new revision and preserves the current Booth credential.

R2 cannot transact the revision and head writes. An appended revision whose
head update fails is harmless and is hidden unless it becomes reachable from
the head. Retrying the same mutation ID is idempotent.

### Outbox and private photo metadata

The Outbox schema grows additively, so old IndexedDB rows remain readable:

```ts
type CaptureMetadata = {
  frameKey?: string;
  capturedAt: number;
  source: "framed" | "camera-fallback";
  configRevisionId?: string;
};

type OutboxItem = {
  id: string;
  event: string;
  blob: Blob;
  createdAt: number;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
  metadata?: CaptureMetadata;
  rehearsalId?: string;
};
```

After the photo write succeeds, the Event Store writes a best-effort private
receipt with the complete key, upload and capture times, Frame, source, and
config revision. Receipt failure must not cause an acknowledged photo to be
retried. The export reports missing metadata as `unknown`.

The private moderation index has different acknowledgment semantics: a new
upload is acknowledged only after its deterministic photo key and immutable
index record both exist. If indexing fails after the photo write, the route
returns a retryable failure; the retry targets the same exact photo key and
finishes the missing index without producing another image.

### Booth heartbeat

Each installed Booth has a locally generated UUID independent of its
credential. Its bounded record includes server-controlled `lastSeenAt`,
session start, pending count, durable-storage flag, online/camera/upload
states, last successful upload, sanitized error class, and build identifier.

It never includes credentials, hashes, thumbnails, arbitrary exception text,
URLs, headers, user-agent strings, or guest identifiers.

### Operational pause

```ts
type BoothOperationalState = {
  version: 1;
  paused: boolean;
  messages?: Partial<Record<LocaleCode, string>>;
  updatedAt: string;
};
```

Pausing blocks new captures, lets an in-progress capture or review finish,
stops the camera at the picker, and always lets the Photo Outbox drain.

### Presets

```ts
type EventPreset = {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  config: EventExperience;
};
```

Preset serialization constructs every field explicitly. It cannot copy Event
identity, Booth credentials, revision IDs, health, device, or rehearsal state.
Applying a preset creates a normal configuration revision. It preserves an
existing target Booth Key and leaves a new Event visibly without one.

## HTTP interfaces

All Event parameters use `canonicalEvent()` and reject aliases.

### Booth control

- `POST /api/booth/preflight?event=` — Booth-or-Admin authenticated; validates
  the credential and returns the safe enabled experience.
- `POST /api/booths?event=` — Booth-or-Admin authenticated; writes one
  sanitized heartbeat.
- `GET /api/booths?event=` — Admin-only; pages through Booth records.
- `GET /api/booth-state?event=` — public safe pause/message projection.
- `PUT /api/booth-state?event=` — Admin-only pause/resume.

One shared `boothOrAdminOk()` helper supplies identical authentication rules
to preflight, upload, heartbeat, and rehearsal routes.

### Configuration and presets

- Existing `GET /api/config` remains public but constructs an allowlisted safe
  response rather than serializing `EventConfig`.
- Existing `PUT /api/config` becomes revision-aware and remains Admin-only.
- `GET /api/config/revisions?event=` lists redacted history.
- `POST /api/config/revisions/restore?event=` appends a restore revision.
- `GET /api/presets`, `PUT /api/presets/{id}`, and
  `POST /api/presets/apply?event=` are Admin-only.

Initial preset scope omits deletion.

### Photos, gallery, and moderation

- Existing `POST /api/upload` accepts stable capture identity and returns the
  complete key.
- Existing public `GET /api/photos` retains its incremental
  `after=<cursor>` contract.
- `GET /api/photo?event=&key=` validates a complete Event-owned image key and
  returns only public lightbox metadata.
- `GET /api/moderation/photos?event=&cursor=&limit=&from=&to=` is Admin-only
  and uses an opaque reverse-time pagination cursor.
- Existing exact-key `DELETE /api/photos?event=&key=` remains externally
  unchanged.

### Rehearsal and export

- Admin starts and reads a rehearsal through `/api/rehearsals`.
- Booth-or-Admin authenticated actions append bounded evidence records.
- Existing `/api/export` keeps its photo-only compatibility mode.
- `GET /api/export?event=&format=package&contactSheet=1` streams the enriched
  package and remains Admin-only.

## User flows

### Unlock and preflight

The Booth state machine becomes:

```text
locked → checking → ready → capturing
                 ↘ recovery-only
                 ↘ unavailable
```

The Booth recovers and displays pending Outbox state before authentication,
but does not start the camera or allow new captures until online preflight
succeeds. The key lives in memory, with session persistence by default and an
explicit “Remember on this iPad” local option. A `401` preserves the Outbox,
clears the credential, and relocks.

### Automatic retry

Retryable network, `408`, `425`, `429`, and `5xx` failures use jittered
exponential delays capped at 30 seconds and honor `Retry-After`. Reconnect and
foreground events immediately reconsider the oldest eligible item.

`400`, `401`, `403`, `413`, and `415` do not loop automatically. A `401`
enters `auth-required`; manual Retry remains available. One permanent failure
continues to block later items, preserving order.

An IndexedDB Event lease prevents two tabs from actively draining the same
queue. Server idempotency remains the final defense against races and lost
acknowledgments.

### Review, acceptance, and handoff

```text
picker → ready → capturing → reviewing → accepting → handoff
                         ↘ retake → ready with the same Frame
```

The exact final composite is shown for a default five seconds with Use Photo,
Retake, and More Time. Only acceptance encodes and enqueues the JPEG. A guarded
decision prevents timer/button races. More Time cancels auto-accept.

After acceptance, the Frame selection clears immediately. When the exact
current handoff item is acknowledged, the Booth generates a local QR for:

```text
/{event}/gallery?photo={complete-object-key}
```

The complete key is percent-encoded as one query value. An older delayed upload
never replaces the current guest’s handoff. Offline guests may continue
without blocking the Booth; the Photo Outbox remains safe.

### Projector and browse galleries

`/{event}/live` remains the projector marquee with its existing newest-first
insertion, independent looping columns, manual scrolling, lightbox, and
reduced-motion behavior.

`/{event}/gallery` is a phone-first, naturally scrolling newest-first view
with shared save/share lightbox, direct-photo opening, scroll anchoring, an
“N new photos” notice, and Jump to Latest. The projector QR points to
`/{event}/gallery`.

A shared pure Photo Feed controller owns cursor retention, deduplication,
ordering, aborts, visibility, and scheduling. Projector polling begins around
two seconds, browse around three to four seconds, quiet periods slow to 10–20
seconds, hidden tabs stop, errors back off to 60 seconds, and foreground or
manual retry refreshes immediately. Requests never overlap.

### Scalable moderation

New uploads append immutable reverse-time private index records. An add-only,
checkpointed rebuild indexes legacy photos and writes a completion marker only
after a full successful scan.

Admin pages through the full Event with time filters, a larger inspection
dialog, keyboard navigation, focus restoration, and an exact filename/key in
the deletion confirmation. The photo is deleted first by complete key; index
and receipt cleanup then target only their exact corresponding keys. Cleanup
failure does not turn a confirmed photo deletion into an ambiguous retry.

### Localization and accessibility

A typed message catalog supplies English fallback. Only complete supported
catalogs may be enabled. The selected per-device locale updates document
language and direction. Frame manifests may add localized labels while
retaining their required default label.

Guest flows include at least 44×44 px controls, visible focus in high-contrast
and forced-color modes, concise live announcements, optional countdown tones
after user activation, persistent visual cues, reduced-motion behavior,
semantic photo buttons, and a focus-managed lightbox. Every QR has a visible
text link.

### Guided rehearsal

Admin starts a private rehearsal that snapshots the current Frames and config
revision. Booth evidence is append-only. Completion requires:

1. Valid unlock, camera readiness, and durable IndexedDB.
2. One acknowledged capture for every enabled Frame.
3. Two real network-class upload failures.
4. Reload under a different boot ID with both items recovered.
5. Ordered drain after reconnection.
6. Exact Photo Feed and public-image observation.
7. Exact-key deletion of one designated moderation canary photo.
8. Empty Photo Outbox.

Config changes make the rehearsal stale. Physical composition, projector,
power, charging, and backup-network checks remain manual. Abandoned sessions
show any remaining exact test keys and never bulk-clean them.

Every rehearsal upload is tracked. Photos other than the designated moderation
canary are either explicitly retained or individually removed by complete key;
rehearsal completion never authorizes automatic or prefix cleanup.

### Installed Booth mode

A public per-Event manifest opens the same canonical Event in standalone
landscape mode without credentials in its URL or manifest. Operator actions
request and reacquire Screen Wake Lock where supported, with iPad Auto-Lock
instructions as fallback.

Navigation warnings appear only during capture, durable handoff, or a non-empty
Outbox. A discoverable authenticated operator exit stops camera tracks and
wake lock but preserves pending photos.

If an offline shell is added, it caches only the Booth shell, build-versioned
static assets, icons, and Frame artwork. It never caches authenticated APIs,
photos, Admin, export, moderation, heartbeat, health, or rehearsal requests,
and it never touches Outbox IndexedDB. Offline reload permits recovery only;
fresh capture still requires online preflight.

Release 1 requires the manifest, standalone detection, wake behavior,
navigation protection, and operator exit. A service-worker shell is included
only if staging tests show that installed-mode relaunch cannot reliably load
the network shell; it is not required for accepted-photo durability.

### Post-event package

The streamed package contains:

```text
photos/{filename}.jpg
manifest.csv
summary.json
contact-sheet.html
```

The manifest records complete key, filename, size, upload and capture times,
timestamp source, Frame key/label, and capture source. The summary includes
photo and byte counts, metadata coverage, Frame usage, first/last capture,
hourly buckets, and busiest periods in the configured time zone.

Analytics are rebuilt from current photos joined to optional private receipts.
Missing receipts produce `unknown`; deleted photos are excluded. The contact
sheet is printable, self-contained HTML with relative photo references, inline
CSS, no JavaScript, and no external requests. CSV cells and HTML are escaped,
including spreadsheet-formula prefixes.

## Delivery plan

### Release 0 — compatible foundations

- Characterization and privacy regression tests.
- Revision-aware Event experience schema and configuration history (#13).
- Shared Booth authentication.
- Stable capture identity and idempotent upload.
- Additive Outbox metadata and private photo receipt/index interfaces.

### Release 1 — reliable Booth control

- Automatic Outbox retry (#2).
- Unlock and authenticated preflight (#1).
- Private Booth heartbeat and Admin device status (#3).
- Pause/resume control (#8).
- Installed Booth/PWA behavior (#5).

### Release 2 — guest capture

- Timed review/retake (#6).
- Exact-photo handoff QR (#7).
- Localization and accessibility foundations applied to changed screens (#12).

### Release 3 — gallery and moderation

- Separate browse Gallery while preserving projector Live Gallery (#9).
- Shared adaptive polling controller (#10).
- Reverse-time moderation index, migration, and paged Admin UI (#11).
- Complete accessibility and localization coverage (#12).

### Release 4 — repeatable operations

- Safe Event presets (#14).
- Guided real-device rehearsal and evidence (#4).

### Release 5 — post-event value

- Private capture analytics.
- Streamed manifest, summary, and contact sheet package (#15).

Each release receives its own implementation plan, verification pass, staging
smoke test, and real-device checks where camera, storage, installed mode, or
VoiceOver behavior is involved.

## Error handling and migration

- All schema additions are optional or versioned; old config and Outbox records
  remain readable.
- Unsupported future stored versions fail explicitly rather than falling back
  to stale legacy state.
- Every new private write targets a complete key. Migrations are add-only and
  checkpointed.
- A photo write is authoritative. Private receipt failure is observable but
  does not requeue an acknowledged image.
- Heartbeat failure never blocks capture or upload.
- Pause polling failure retains the last-known state and shows connectivity
  status.
- Gallery failures leave existing photos visible and provide manual retry.
- Config conflicts return `409` and require reload instead of last-writer-wins.
- Staging and production retain separate Workers, buckets, domains, and
  secrets.
- Rollback changes Worker code only; it never rolls back or deletes data.

## Verification

### Unit and contract coverage

- Shared authentication and preflight response redaction.
- Stable upload identity, lost acknowledgment, and concurrent retry behavior.
- Retry policy, `Retry-After`, reconnect, reload, permanent errors, ordering,
  lease expiry, and Event isolation.
- Revision baseline/save/restore, mutation idempotency, stale-head conflict,
  key preservation, and secret redaction.
- Heartbeat validation, server timestamps, paging, stale derivation, and
  cross-Event isolation.
- Review timeout, More Time, button/timer race, encode failure, and retake.
- Current-handoff QR identity and delayed-upload protection.
- Pause during picker, capture, review, and Outbox drain.
- Photo Feed cadence, visibility, abort, no-overlap, deduplication, and cursor
  reset.
- Moderation ordering, opaque cursor, time filters, index rebuild resume, and
  exact deletion cleanup.
- Locale completeness, fallback, direction, Frame label fallback, and pure
  focus/scroll-anchor logic.
- Rehearsal evidence reduction, config invalidation, reload proof, exact
  gallery correlation, and exact deletion.
- Preset validation and proof that credentials and Event identity cannot copy.
- ZIP structure, manifest escaping, metadata gaps, generated-entry limits, and
  absence of private operational records.

### Browser and real-device coverage

- Playwright/WebKit journeys with mocked camera and feed.
- Keyboard-only and automated accessibility checks.
- Real iPad Safari and installed-mode unlock, permissions, wake behavior,
  review, audio, offline queue, reload, reconnect, and exit.
- VoiceOver on iPad/iPhone.
- Projector marquee and phone browse anchoring.
- Multi-page moderation with one exact-key deletion.
- Full rehearsal on staging using a throwaway Event distinct from production.

The standard Bun type checks, tests, Frame validation, and production build
remain mandatory in CI and before every deployment.

## Safety invariants

- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never expose Event state, indexes, metadata, revision records, Booth
  heartbeats, or credential hashes through public objects.
- Never accept a photo prefix or filename fragment for moderation.
- Never silently slug an Event at an HTTP boundary.
- Never auto-select or retain a Frame after a completed capture.
- Never remove an accepted Outbox item before storage acknowledgment.
- Never deploy the unnamed Wrangler environment to an event domain.
