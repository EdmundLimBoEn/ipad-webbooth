# Release 3 Gallery and Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the phone browse Gallery from the projector Live Gallery, share one adaptive incremental Photo Feed controller, make full-Event moderation privately pageable and rebuildable, and complete localization and accessibility coverage without weakening exact-key deletion.

**Architecture:** A pure Photo Feed reducer owns cursor retention, exact-key deduplication, request generations, visibility, cadence, and abort/scheduling effects; a thin React interpreter performs fetches and timers for both Gallery presentations. The existing projector marquee remains intact while the Release 2 direct-photo route grows into a phone-first browse Gallery with a shared focus-managed lightbox and pure scroll anchoring. `EventStore` remains the only owner of private reverse-time index, rebuild-checkpoint, receipt, and exact deletion keys. Admin routes authenticate and validate, then delegate paged reads, bounded add-only rebuilds, and exact public-first deletion to the Event Store.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers/R2, typed message catalogs, Playwright WebKit, `@axe-core/playwright`.

## Global Constraints

- Start only after Release 0B idempotent upload/private index and Release 2 direct-photo Gallery pass their complete gates.
- Use Bun commands only.
- `EventStore` remains the only owner of `PHOTOS` and `STATE` keys.
- `PHOTOS` remains authoritative for whether a photo exists.
- Existing public `GET /api/photos?event=&after=` remains incremental and backward compatible.
- `/{event}/live` remains the projector marquee with balanced independent columns, newest-first insertion, manual scroll pause, lightbox, and reduced-motion behavior.
- `/{event}/gallery?photo=<complete-key>` remains the direct-photo handoff contract.
- Public responses never expose receipts, private index records, rebuild state, config revisions, credentials, Booth records, or other operational state.
- New private writes are create-only, add-only, or exact-key cleanup. Rebuild never deletes or overwrites photos or existing index records.
- Moderation accepts only one complete Event-owned image key. Never accept a prefix, filename fragment, alias, traversal path, or cross-Event key.
- Delete the public photo first. Cleanup then targets only its one exact receipt key and one exact index key.
- A cleanup failure after confirmed public deletion must not turn the deletion into an ambiguous retry.
- Every Event parameter uses `canonicalEvent()` and rejects aliases.
- Gallery failures retain already-visible photos and provide manual retry.
- Hidden tabs stop polling; requests never overlap.
- Existing and future unsupported stored versions fail explicitly.
- No browser simulator replaces physical iPhone/iPad VoiceOver, native Share/Save, Safari visibility/suspension, or projector checks.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never deploy the unnamed Wrangler environment to an Event domain.

---

## File Structure

- Create `app/photo-feed/types.ts` — shared public Photo Feed types and profiles.
- Create `app/photo-feed/controller.ts` — pure feed reducer, merge, cadence, and effect model.
- Create `app/photo-feed/controller.test.ts` — cursor, dedupe, cadence, visibility, and no-overlap tests.
- Create `app/photo-feed/use-photo-feed.ts` — React fetch/timer/abort effect interpreter.
- Create `app/photo-feed/use-photo-feed.test.ts` — deterministic interpreter lifecycle tests.
- Create `app/[event]/gallery/photo-actions.ts` — exact Gallery URLs and save/share behavior.
- Create `app/[event]/gallery/photo-actions.test.ts` — URL, native share, and fallback tests.
- Create `app/[event]/gallery/photo-lightbox.tsx` — shared accessible localized lightbox.
- Create `app/[event]/gallery/photo-lightbox.test.tsx` — semantic/focus/action markup tests.
- Modify `app/[event]/live/page.tsx` — shared feed/lightbox integration and browse QR.
- Modify `app/[event]/live/live.module.css` — semantic tiles, forced colors, and focus.
- Modify `app/[event]/live/wrap.test.ts` — retain marquee wrapping characterization.
- Modify `app/[event]/gallery/page.tsx` — preserve the direct-photo route contract.
- Replace or expand `app/[event]/gallery/handoff-gallery.tsx` — phone browse Gallery.
- Create `app/[event]/gallery/browse-gallery.test.tsx` — feed/deep-link/error markup tests.
- Create `app/[event]/gallery/scroll-anchor.ts` — pure visible-anchor and scroll-delta logic.
- Create `app/[event]/gallery/scroll-anchor.test.ts` — mixed-height/prepend tests.
- Modify `app/[event]/gallery/gallery.module.css` — phone-first browse and notices.
- Create `app/moderation.ts` — private moderation schemas and opaque cursor codec.
- Create `app/moderation.test.ts` — strict schema/cursor validation.
- Modify `app/event-store.ts` — moderation paging, rebuild, and exact derived cleanup.
- Modify `app/event-store.test.ts` — paging, rebuild, races, privacy, and deletion tests.
- Create `app/api/moderation/photos/handlers.ts` — dependency-injected moderation read/rebuild handlers.
- Create `app/api/moderation/photos/handlers.test.ts` — auth/input/status/redaction tests.
- Create `app/api/moderation/photos/route.ts` — thin Admin-only page adapter.
- Create `app/api/moderation/photos/rebuild/route.ts` — thin Admin-only bounded rebuild adapter.
- Create `app/api/photos/handlers.ts` — dependency-injected public feed and exact delete handlers.
- Create `app/api/photos/handlers.test.ts` — compatibility and exact cleanup status tests.
- Modify `app/api/photos/route.ts` — thin Cloudflare route adapter.
- Create `app/[event]/admin/moderation-state.ts` — pure page merge/filter/deletion state.
- Create `app/[event]/admin/moderation-state.test.ts` — paging, reset, and focus-target tests.
- Create `app/[event]/admin/moderation-panel.tsx` — filters, pages, rebuild, and photo grid.
- Create `app/[event]/admin/moderation-panel.test.tsx` — accessible localized panel markup.
- Create `app/[event]/admin/moderation-dialog.tsx` — inspection, keyboard navigation, and exact confirmation.
- Create `app/[event]/admin/moderation-dialog.test.tsx` — focus, exact key, and cleanup-warning tests.
- Modify `app/[event]/admin/page.tsx` — authenticated moderation integration.
- Modify `app/[event]/admin/admin.module.css` — scalable grid/dialog/filter styling.
- Modify `app/i18n/catalog.ts` — complete projector, browse, moderation, and Admin messages.
- Modify `app/i18n/catalog.test.ts` — exact locale-key and placeholder parity.
- Modify `app/i18n/locale.ts` — reusable Event/device locale client integration if absent.
- Modify `app/i18n/locale.test.ts` — Admin/Gallery locale persistence and direction.
- Create `tests/gallery-moderation.spec.ts` — WebKit gallery/moderation/accessibility journey.
- Modify `package.json` and `bun.lock` — axe browser dependency only if absent.
- Modify `.github/workflows/verify.yml` — retain browser verification.
- Modify `docs/runbooks/pre-event-readiness.md` — phone/projector/moderation/VoiceOver checks.
- Modify `docs/runbooks/deployment.md` — Release 3 staging gate and add-only rebuild procedure.

### Task 1: Add the shared pure adaptive Photo Feed controller

**Files:**
- Create: `app/photo-feed/types.ts`
- Create: `app/photo-feed/controller.ts`
- Create: `app/photo-feed/controller.test.ts`
- Create: `app/photo-feed/use-photo-feed.ts`
- Create: `app/photo-feed/use-photo-feed.test.ts`

**Interfaces:**
- Consumes: the existing public `GET /api/photos?event=&after=` response.
- Produces: pure cursor/dedupe/request/scheduling state shared by projector and browse.
- Produces: a thin React interpreter that owns real abort controllers and timers.

- [ ] **Step 1: Write failing merge and state-transition tests**

Define:

```ts
export type FeedPhoto = {
  key: string;
  url: string;
  uploadedAt: string;
};

export type FeedProfile = {
  activeMs: number;
  quietMinMs: number;
  quietMaxMs: number;
  errorBaseMs: number;
  errorMaxMs: number;
};

export type PhotoFeedState = {
  event: string;
  photos: FeedPhoto[];
  cursor: string | null;
  status: "loading" | "ready" | "error";
  visible: boolean;
  request: { id: number; after: string | null } | null;
  refreshPending: boolean;
  quietCount: number;
  failureCount: number;
  error: string | null;
  generation: number;
};

export function reducePhotoFeed(
  state: PhotoFeedState,
  event: PhotoFeedEvent
): { state: PhotoFeedState; effects: PhotoFeedEffect[] };

export function mergePhotoFeed(
  current: readonly FeedPhoto[],
  incoming: readonly FeedPhoto[]
): { photos: FeedPhoto[]; inserted: FeedPhoto[] };
```

Test:

- Exact-key deduplication, including duplicates inside one response.
- Incoming copies replace stale same-key URL/timestamp values.
- New photos prepend while retained photos keep their relative order.
- Empty deltas retain cursor and photos.
- A successful response adopts only a valid non-empty response cursor.
- Event change clears cursor/photos/errors, increments generation, and aborts the old request.
- Stale response, error, or abort completion from an old request/generation is ignored.
- Manual refresh while idle schedules immediately.
- Manual refresh while active marks one serialized refresh and emits an abort, never a second simultaneous request.
- Hidden visibility emits abort, clears scheduling, and retains photos.
- Foreground visibility refreshes immediately.
- Request failure retains photos and increments capped error delay.

- [ ] **Step 2: Write failing deterministic cadence tests**

Export profiles:

```ts
export const PROJECTOR_FEED_PROFILE: FeedProfile;
export const BROWSE_FEED_PROFILE: FeedProfile;
```

Prove:

- Projector active arrival cadence is approximately 2 seconds.
- Browse active arrival cadence is approximately 3.5 seconds.
- Consecutive quiet responses slow into their configured 10–20 second range.
- Errors use injected jittered exponential backoff capped at 60 seconds.
- Success clears failure backoff.
- Injected random/clock values make every assertion exact.

- [ ] **Step 3: Run focused tests and verify missing-module failures**

```bash
bun test app/photo-feed/controller.test.ts app/photo-feed/use-photo-feed.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the pure reducer and response validation**

Effects explicitly describe:

```ts
type PhotoFeedEffect =
  | { type: "request"; requestId: number; generation: number; after: string | null }
  | { type: "abort"; requestId: number }
  | { type: "schedule"; delayMs: number }
  | { type: "cancel-schedule" };
```

Validate every response field before a success action. Unknown top-level fields
are ignored; malformed `photos` or `cursor` fail the request without clearing
existing photos. Do not sort by client clock: retain server newest-first order
and exact-key tie behavior.

- [ ] **Step 5: Implement the React effect interpreter**

The interpreter:

- Uses one active `AbortController`.
- Awaits abort settlement before executing a queued immediate refresh.
- Uses one timer and cancels it before replacement.
- Listens to `visibilitychange`; hidden stops, visible refreshes.
- Aborts and resets on Event change/unmount.
- Exposes `{photos,status,error,refresh}` plus the exact inserted photos from
  the latest applied response.
- Never calls `setInterval`.

Test it with injected fetch, clock, timer, visibility, and abort providers.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test app/photo-feed/controller.test.ts app/photo-feed/use-photo-feed.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/photo-feed
git commit -m "feat: share adaptive photo feed polling"
```

### Task 2: Share accessible photo actions and preserve the projector marquee

**Files:**
- Create: `app/[event]/gallery/photo-actions.ts`
- Create: `app/[event]/gallery/photo-actions.test.ts`
- Create: `app/[event]/gallery/photo-lightbox.tsx`
- Create: `app/[event]/gallery/photo-lightbox.test.tsx`
- Modify: `app/[event]/live/page.tsx`
- Modify: `app/[event]/live/live.module.css`
- Modify: `app/[event]/live/wrap.test.ts`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 controller and Release 2 typed locale/message helpers.
- Produces: one exact-photo save/share implementation and focus-managed lightbox.
- Preserves: every existing projector marquee/manual-scroll invariant.

- [ ] **Step 1: Characterize the existing projector before refactoring**

Add focused tests for:

- `wrap()` positive, negative, and multi-period positions.
- Independent per-column periods.
- Newest-first stable tile keys.
- Duplicate copy is `aria-hidden`.
- Ten-pixel drag threshold suppresses a tile activation.
- Manual wheel/drag pause is four seconds.
- Reduced motion removes auto-marquee but keeps the photos available.

Extract only small pure marquee calculations when needed for tests; do not
replace the working rendering model.

- [ ] **Step 2: Write failing exact action and lightbox tests**

Define:

```ts
export function exactGalleryUrl(
  origin: string,
  event: string,
  completeKey: string
): string;

export async function savePhoto(input: PhotoActionInput): Promise<PhotoActionResult>;
export async function sharePhoto(input: PhotoActionInput): Promise<PhotoActionResult>;
```

Test:

- The complete key is one percent-encoded `photo` query value.
- Native file share is preferred when supported.
- Link share and object-URL download are bounded fallbacks.
- Share cancellation is not rendered as an error.
- Object URLs are always revoked.
- A stale prefetched Blob cannot be used for a newer photo.
- The visible exact-photo link and share URL are identical.

Render the lightbox and assert a labelled modal, semantic image, Save, Share,
Close, status/error regions, localized labels, and 44×44 controls.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test 'app/[event]/gallery/photo-actions.test.ts' \
  'app/[event]/gallery/photo-lightbox.test.tsx' \
  'app/[event]/live/wrap.test.ts'
```

Expected: FAIL because shared actions/lightbox do not exist.

- [ ] **Step 4: Implement the shared lightbox**

The lightbox:

- Focuses its heading or Close button on open.
- Traps Tab/Shift+Tab, closes on Escape, and restores the exact trigger focus.
- Prefetches bytes for Safari without requiring an external service.
- Uses a visible exact-photo text link.
- Announces non-cancelled failures concisely.
- Uses `<bdi>` for exact keys/URLs in RTL.
- Supports previous/next callbacks without owning moderation state.
- Ignores stale prefetch/action promises after the photo changes.

- [ ] **Step 5: Refactor only projector feed and photo presentation**

In `app/[event]/live/page.tsx`:

- Replace fixed polling with `usePhotoFeed(PROJECTOR_FEED_PROFILE)`.
- Keep existing photos visible during errors and wire manual retry.
- Replace `img role="button"` with a semantic button containing the image.
- Use the shared lightbox.
- Generate the projector QR locally for `/{event}/gallery`, not `/live`.
- Preserve balanced masonry, duplicated copies, independent loop periods,
  manual scrolling, momentum, four-second resume, click suppression, and
  newest-first insertion.

Add forced-color focus outlines and reduced-motion coverage without changing
the projector's visual hierarchy.

- [ ] **Step 6: Extend every complete catalog**

Add all projector and shared-lightbox keys to `en`, `zh-SG`, and `ar`. Prove
exact key parity and exact interpolation-placeholder parity.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test 'app/[event]/gallery/photo-actions.test.ts' \
  'app/[event]/gallery/photo-lightbox.test.tsx' \
  'app/[event]/live/wrap.test.ts' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'app/[event]/gallery' 'app/[event]/live' app/i18n
git commit -m "feat: preserve projector with shared gallery controls"
```

### Task 3: Expand the direct-photo shell into the phone browse Gallery

**Files:**
- Modify: `app/[event]/gallery/page.tsx`
- Modify: `app/[event]/gallery/handoff-gallery.tsx`
- Create: `app/[event]/gallery/browse-gallery.test.tsx`
- Create: `app/[event]/gallery/scroll-anchor.ts`
- Create: `app/[event]/gallery/scroll-anchor.test.ts`
- Modify: `app/[event]/gallery/gallery.module.css`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 browse feed, Task 2 lightbox, and Release 2 exact-photo API.
- Preserves: `/{event}/gallery?photo=<complete-key>`.
- Produces: naturally scrolling newest-first browse with stable anchoring.

- [ ] **Step 1: Write failing pure scroll-anchor tests**

Define:

```ts
export type ScrollAnchor = { key: string; top: number };

export function chooseScrollAnchor(
  visible: readonly { key: string; top: number; bottom: number }[]
): ScrollAnchor | null;

export function anchoredScrollTop(input: {
  previousScrollTop: number;
  beforeTop: number;
  afterTop: number;
}): number;
```

Test mixed-height photos, partially visible first rows, several prepends,
deleted/missing anchors, zero/negative offsets, and no adjustment while at the
top.

- [ ] **Step 2: Write failing browse/deep-link tests**

Test:

- No query opens the browse feed.
- One decoded `photo` query value is fetched immediately through `/api/photo`.
- Direct photo opens before the initial feed completes.
- Direct photo is deduplicated if it later appears in the feed.
- Invalid/not-found direct photo shows a localized retryable state while browse
  remains available.
- Opening a feed tile writes the exact-photo query without full navigation.
- Closing restores the browse URL.
- Old deep-link requests cannot open over a newer selected photo.
- Feed errors retain tiles and manual retry.
- Loading, empty, offline, and ready states.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test 'app/[event]/gallery/scroll-anchor.test.ts' \
  'app/[event]/gallery/browse-gallery.test.tsx'
```

Expected: FAIL because browse/anchor behavior does not exist.

- [ ] **Step 4: Implement browse rendering and direct-photo correlation**

Use `usePhotoFeed(BROWSE_FEED_PROFILE)`. Render a phone-first lazy-image grid
in natural document flow. Use exact keys for React and DOM anchor identity.

For `?photo=`:

- Preserve the complete-key query contract from Release 2.
- Fetch `/api/photo` immediately and open the shared lightbox.
- Never infer or reconstruct private metadata.
- Use `history.pushState`/`replaceState` only after exact URL construction.
- Keep link/share URLs identical to the current exact key.

- [ ] **Step 5: Implement anchoring and new-photo notice**

When the user is away from the top:

1. Capture the first visible exact-key element and its top before the prepend.
2. Render the merged feed.
3. In a layout effect, find the same exact key and adjust `scrollTop` by its
   measured top delta.
4. Increment a localized `N new photos` notice.

“Jump to Latest” scrolls to zero and clears the count. Reduced-motion users get
an immediate jump. A missing or stale anchor performs no adjustment.

- [ ] **Step 6: Complete responsive and accessible presentation**

- Use semantic photo buttons and useful localized accessible names.
- Keep targets at least 44×44.
- Preserve focus while new photos prepend.
- Add high-contrast/forced-color focus, RTL layout, reduced motion, and 200%
  text reflow.
- Do not turn the browse Gallery into the projector marquee.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test 'app/[event]/gallery/scroll-anchor.test.ts' \
  'app/[event]/gallery/browse-gallery.test.tsx' \
  'app/[event]/gallery/photo-lightbox.test.tsx' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'app/[event]/gallery' app/i18n
git commit -m "feat: add the phone browse gallery"
```

### Task 4: Page and rebuild the private reverse-time moderation index

**Files:**
- Create: `app/moderation.ts`
- Create: `app/moderation.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Release 0B `photoIndexKey()` and private version-1 metadata.
- Produces: strict Admin-only page records and opaque stable cursors.
- Produces: bounded add-only legacy index rebuild with CAS checkpoint.

- [ ] **Step 1: Write failing schema and opaque cursor tests**

Define:

```ts
export type ModerationPhoto = {
  key: string;
  url: string;
  uploadedAt: string;
  capturedAt: number;
  source?: "framed" | "camera-fallback";
  frameKey?: string;
};

export type ModerationCursor = {
  version: 1;
  event: string;
  afterIndexKey: string;
  from: number | null;
  to: number | null;
};

export function encodeModerationCursor(cursor: ModerationCursor): string;
export function decodeModerationCursor(
  encoded: string,
  expected: Pick<ModerationCursor, "event" | "from" | "to">
): ModerationCursor;
```

Test malformed base64/JSON, extra/missing fields, unsupported versions,
cross-Event cursors, changed filters, non-index `afterIndexKey`, and a valid
round trip. The encoded value is opaque API state, not a storage cursor.

- [ ] **Step 2: Write failing EventStore paging tests**

Define:

```ts
EventStore.listModerationPhotos(
  event: string,
  options: {
    cursor?: string;
    limit: number;
    from?: number;
    to?: number;
  }
): Promise<{
  photos: ModerationPhoto[];
  nextCursor: string | null;
}>;
```

Test:

- Ascending inverse-time keys produce newest-first photos.
- Stable key tie-breaking.
- Default/bounded limits and pages larger than one R2 response.
- Inclusive from/to filtering by `capturedAt`.
- Stable `startAfter` continuation while new uploads arrive.
- Exact-key deduplication.
- Missing public photos are skipped because `PHOTOS` is authoritative.
- Corrupt/future private records fail explicitly.
- A record naming another Event never becomes public/Admin output.
- No receipt, revision, credential, heartbeat, or rebuild field is returned.

- [ ] **Step 3: Write failing checkpointed rebuild tests**

Add private keys:

```ts
export const photoIndexRebuildCheckpointKey = (event: string) =>
  `events/${event}/photo-index-rebuild/v1/checkpoint.json`;

export const photoIndexRebuildCompleteKey = (event: string) =>
  `events/${event}/photo-index-rebuild/v1/complete.json`;
```

Define:

```ts
EventStore.rebuildPhotoIndex(
  event: string,
  options: { batchSize: number }
): Promise<{
  complete: boolean;
  scanned: number;
  indexed: number;
  checkpoint: string | null;
}>;
```

Test:

- Legacy photos gain create-only reverse-time index records.
- Existing index bytes/etag are never replaced.
- Rebuild never creates a synthetic receipt.
- A failed index write does not checkpoint past the failed batch.
- Retrying safely re-observes prior create-only writes.
- Resume uses the last complete photo key via `startAfter`.
- Concurrent checkpoint CAS cannot regress or skip progress.
- Non-image objects advance scanning but do not get indexed.
- A photo deleted during scanning is not treated as current source truth.
- Completion marker appears only after a full successful final scan.
- A crash after final checkpoint but before marker is recoverable.
- Cross-Event photos and state are untouched.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
bun test app/moderation.test.ts app/event-store.test.ts
```

Expected: FAIL because moderation page/rebuild APIs do not exist.

- [ ] **Step 5: Implement strict parsing and stable paging**

List only under `events/{event}/photo-index/v1/`. Use `startAfter` from the
validated opaque cursor, not an offset/R2 cursor. Read bounded chunks until the
requested number of current public photos is filled or the index is exhausted.
Advance the returned cursor by the last scanned private index key so stale
deleted records cannot cause loops.

- [ ] **Step 6: Implement bounded add-only rebuild**

For each legacy public image, derive the sort time from its 13-digit filename
timestamp, falling back to its stored upload time. Recheck source existence
before create-only index write. Commit the checkpoint only after the entire
batch succeeds. CAS prevents concurrent workers from overwriting progress.
Never list/delete a private prefix for cleanup.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test app/moderation.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/moderation.ts app/moderation.test.ts \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: page and rebuild private moderation index"
```

### Task 5: Add Admin moderation HTTP boundaries and exact derived cleanup

**Files:**
- Create: `app/api/moderation/photos/handlers.ts`
- Create: `app/api/moderation/photos/handlers.test.ts`
- Create: `app/api/moderation/photos/route.ts`
- Create: `app/api/moderation/photos/rebuild/route.ts`
- Create: `app/api/photos/handlers.ts`
- Create: `app/api/photos/handlers.test.ts`
- Modify: `app/api/photos/route.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Task 4 paging/rebuild and existing `adminOk()`.
- Produces: strict Admin-only moderation pages and rebuild batches.
- Preserves: public incremental feed and exact-key DELETE routes.

- [ ] **Step 1: Write failing exact deletion/cleanup tests**

Change the EventStore result additively:

```ts
export type DeletePhotoResult =
  | { deleted: false }
  | {
      deleted: true;
      cleanup: {
        index: "deleted" | "missing" | "failed";
        receipt: "deleted" | "missing" | "failed";
      };
    };
```

Test:

- Alias, prefix, filename fragment, traversal, non-image, and cross-Event key
  are rejected before deletion.
- The exact public object is read and deleted first.
- Exact receipt metadata supplies the index sort time when valid.
- Filename/upload time supplies the safe fallback.
- Only `photoReceiptKey(event,key)` and
  `photoIndexKey(event,key,exactSortTime)` are cleaned.
- No prefix list/delete is called.
- Public deletion failure performs no private cleanup.
- Index/receipt cleanup failure after public deletion returns `deleted: true`
  with failed cleanup, rather than throwing an ambiguous delete error.
- An exact missing public photo preserves the existing `deleted: false` result.
- Adjacent and cross-Event photos/indexes/receipts remain byte-identical.

- [ ] **Step 2: Write failing handler tests**

HTTP contracts:

```text
GET  /api/moderation/photos?event=&cursor=&limit=&from=&to=
POST /api/moderation/photos/rebuild?event=
GET  /api/photos?event=&after=
DELETE /api/photos?event=&key=
```

Test:

- Missing Admin secret is `503`; wrong key is `401`.
- No store call occurs after failed authentication.
- Canonical Event validation rejects aliases.
- `limit` defaults to 48 and accepts only integers `1..100`.
- `from`/`to` require RFC3339 instants with a time-zone and `from <= to`.
- Malformed cursor returns `400`.
- Page response is explicitly allowlisted.
- Rebuild is bounded, returns `202` while incomplete and `200` when complete.
- Public GET retains its existing response and `after` compatibility.
- Exact DELETE retains `404` for a missing photo.
- Confirmed delete returns `200 {deleted:true,key}` and additively reports
  `cleanupPending` without exposing private key names.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test app/api/moderation/photos/handlers.test.ts \
  app/api/photos/handlers.test.ts app/event-store.test.ts
```

Expected: FAIL because the handlers and cleanup result do not exist.

- [ ] **Step 4: Implement public-first exact cleanup**

Before deleting the public photo, read only its exact receipt and public object
to determine the one exact index key. Delete the public photo. Then perform the
two exact private deletes independently and capture failures. Never turn a
confirmed photo deletion into a 5xx that invites an ambiguous retry.

Moderation reads must skip stale index records whose public photo is missing,
so cleanup failure cannot resurrect a deleted photo in Admin.

- [ ] **Step 5: Implement dependency-injected handlers and thin routes**

Handlers authenticate and validate before delegating. Route modules only obtain
Cloudflare bindings and call handlers. Response construction explicitly
allowlists fields and adds `Cache-Control: no-store`.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test app/api/moderation/photos/handlers.test.ts \
  app/api/photos/handlers.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/moderation app/api/photos \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: moderate photos with exact private cleanup"
```

### Task 6: Replace the recent contact sheet with scalable localized Admin moderation

**Files:**
- Create: `app/[event]/admin/moderation-state.ts`
- Create: `app/[event]/admin/moderation-state.test.ts`
- Create: `app/[event]/admin/moderation-panel.tsx`
- Create: `app/[event]/admin/moderation-panel.test.tsx`
- Create: `app/[event]/admin/moderation-dialog.tsx`
- Create: `app/[event]/admin/moderation-dialog.test.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/admin.module.css`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`
- Modify: `app/i18n/locale.ts`
- Modify: `app/i18n/locale.test.ts`

**Interfaces:**
- Consumes: Task 5 Admin APIs and Release 2 Event/device locale.
- Produces: full-Event paging, time filters, inspection, rebuild, and exact deletion.
- Completes: typed localization and accessibility coverage for product-facing screens.

- [ ] **Step 1: Write failing pure moderation-state tests**

Define:

```ts
export function mergeModerationPage(
  current: readonly ModerationPhoto[],
  incoming: readonly ModerationPhoto[]
): ModerationPhoto[];

export function removeModeratedPhoto(
  photos: readonly ModerationPhoto[],
  exactKey: string
): {
  photos: ModerationPhoto[];
  nextFocusKey: string | null;
};

export function filtersChanged(
  current: ModerationFilters,
  next: ModerationFilters
): boolean;
```

Test exact-key dedupe, reverse-time retention, filter reset, stale page response
rejection, exact removal, next/previous focus target, and an empty final page.

- [ ] **Step 2: Write failing accessible panel/dialog tests**

Render and assert:

- Labelled from/to filters and Apply/Clear controls.
- Loaded count that does not falsely claim an Event total.
- Semantic photo buttons and lazy images.
- Load More disabled/busy state.
- Index rebuild status and explicit bounded Continue action.
- Larger labelled modal with previous/next, Close, and exact trigger restoration.
- Arrow-key navigation and Escape contract.
- Deletion confirmation includes both exact filename and complete key in
  `<bdi><code>`.
- Confirm/Cancel are separate 44×44 controls.
- Cleanup-pending warning says the public photo is already deleted and does not
  offer a public delete retry.
- Polite success and assertive error regions.
- No private receipt/index/revision/device values appear in markup.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test 'app/[event]/admin/moderation-state.test.ts' \
  'app/[event]/admin/moderation-panel.test.tsx' \
  'app/[event]/admin/moderation-dialog.test.tsx'
```

Expected: FAIL because the Admin moderation modules do not exist.

- [ ] **Step 4: Implement authenticated page/filter/rebuild integration**

After Admin authentication:

- Load the first moderation page.
- Reset rows/cursor atomically when filters change.
- Append Load More pages by exact key.
- Ignore stale responses from prior filters/Event/auth state.
- Route `401` through existing Admin invalidation.
- Keep config, Booth controls, health, and export usable when moderation fails.
- Replace the public Photo Feed/16-item recent contact sheet; do not run both.
- Present rebuild as explicit bounded batches, never an unbounded request.

- [ ] **Step 5: Implement inspection and exact deletion UX**

Opening remembers the exact tile trigger. Previous/next use the loaded reverse-
time order and keyboard arrows. Successful deletion removes only the exact key,
announces it, and focuses the next tile or moderation heading. A private cleanup
warning is informational because the public deletion is already confirmed.

- [ ] **Step 6: Complete localization coverage**

Extend `en`, `zh-SG`, and `ar` with every projector, browse, moderation, Admin
status, filter, empty, busy, confirmation, cleanup, and error key. Preserve
exact catalog and placeholder parity.

Migrate remaining product-facing Admin shell literals and reusable Admin panel
strings to the typed catalog so “complete coverage” is not limited to the new
panel. Use `Intl.DateTimeFormat` for locale-aware display and retain English
fallback for unsupported legacy locale values. The locale selector and
document `lang`/`dir` remain Event/device scoped.

Frame Lab may remain developer tooling, but audit its semantics/focus/reflow.
If it is considered an operator-facing product route, migrate its literals in
this task as well.

- [ ] **Step 7: Complete accessibility coverage**

- Semantic heading hierarchy and labelled landmarks.
- Keyboard-only access to all actions.
- Focus trap/restoration for both Gallery and moderation dialogs.
- Concise live announcements without repeated feed chatter.
- At least 44×44 pointer targets.
- Visible focus under high contrast and forced colors.
- Reduced-motion removal of nonessential animation/scrolling.
- Arabic RTL with exact keys/URLs isolated using `<bdi>`.
- 200% text and narrow-screen reflow without hidden actions.
- Native images retain useful localized accessible names.

- [ ] **Step 8: Run focused and full checks**

```bash
bun test 'app/[event]/admin/moderation-state.test.ts' \
  'app/[event]/admin/moderation-panel.test.tsx' \
  'app/[event]/admin/moderation-dialog.test.tsx' \
  'app/[event]/admin/admin-config-controls.test.tsx' \
  'app/[event]/admin/config-history-panel.test.tsx' \
  app/i18n/catalog.test.ts app/i18n/locale.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add 'app/[event]/admin' app/i18n
git commit -m "feat: scale and localize admin moderation"
```

### Task 7: Add browser coverage, runbooks, and the Release 3 gate

**Files:**
- Create: `tests/gallery-moderation.spec.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `.github/workflows/verify.yml`
- Modify: `docs/runbooks/pre-event-readiness.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: Tasks 1–6 and the Release 1 Playwright WebKit setup.
- Produces: repeatable browser coverage and exact staging/manual validation.

- [ ] **Step 1: Add failing WebKit gallery/controller journeys**

Intercept Photo Feed, exact-photo, and save/share dependencies. Test:

- Slow response plus several timer ticks never overlaps requests.
- Projector active cadence, quiet slowdown, error backoff, and manual retry.
- Hidden state aborts/stops; foreground immediately refreshes.
- Feed errors retain existing photos.
- Projector retains independent looping columns and four-second manual pause.
- Projector QR targets browse Gallery.
- Browse prepends several photos without moving the visible exact-key anchor.
- New-photo count and Jump to Latest.
- Direct-photo deep link opens the exact complete key before feed completion.
- URL open/close history and exact save/share link.
- Localized loading/empty/offline/error states.

- [ ] **Step 2: Add failing WebKit moderation/accessibility journeys**

Test:

- Multiple reverse-time pages and from/to filters.
- Stale page response after filter change is ignored.
- Inspection previous/next, arrows, Escape, focus trap, and restoration.
- Confirmation displays the exact filename and complete key.
- One exact-key deletion removes only one tile.
- Cleanup-pending response is not retried as a public deletion.
- Rebuild continues bounded batches and reports completion.
- Keyboard-only operation.
- Arabic direction, reduced motion, forced colors, 200% text reflow.
- No serious automated axe violations on Live, browse Gallery, direct photo,
  Admin moderation, and shared dialogs.

If `@axe-core/playwright` is absent, add it with Bun. Do not add a second browser
runner.

- [ ] **Step 3: Run browser coverage and fix deterministic failures**

```bash
bun run test:browser -- tests/gallery-moderation.spec.ts
```

Expected: PASS without staging or production traffic.

- [ ] **Step 4: Update staging-first runbooks**

Add:

1. Use a throwaway canonical staging Event distinct from production.
2. Upload enough exact photos to require several moderation pages.
3. Interrupt and resume a bounded add-only index rebuild.
4. Confirm checkpoint/completion/index/receipt records exist only in `STATE`.
5. Exercise projector polling and manual scrolling over an extended period.
6. Confirm phone browse anchoring while new photos arrive.
7. Open an exact handoff link and native Share/Save on a physical phone.
8. Delete one designated canary by its complete key.
9. Confirm adjacent public photos and private records remain.
10. Confirm a simulated derived-cleanup failure never resurrects a public photo
    or invites ambiguous re-deletion.
11. Exercise keyboard-only Admin moderation.
12. Check VoiceOver, Arabic RTL, Larger Text, Reduce Motion, high contrast, and
    focus restoration on iPhone/iPad.
13. Obtain native-speaker review for supported non-English catalog changes.

Never use prefix cleanup. Abandoned staging records are retained or removed one
at a time by complete key.

- [ ] **Step 5: Run the complete automated Release 3 gate**

```bash
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
bun run test:browser
```

Expected: every command exits 0.

- [ ] **Step 6: Perform required staging/manual validation**

Automated WebKit cannot certify:

- iOS native Share user activation, cancellation, or Save to Photos.
- VoiceOver timing/focus speech on iPhone/iPad.
- Safari process suspension and real visibility/foreground behavior.
- Long-running physical projector layout, performance, visual gaps, or QR
  readability at venue distance.
- Production-like R2 listing/CAS behavior during rebuild/deletion races.
- Translation quality.

Use staging and physical devices for these checks. Delete only the designated
canary by its complete Event-owned key.

- [ ] **Step 7: Commit**

```bash
git add tests/gallery-moderation.spec.ts package.json bun.lock \
  .github/workflows/verify.yml docs/runbooks/pre-event-readiness.md \
  docs/runbooks/deployment.md
git commit -m "test: verify gallery and moderation release"
```

## Release 3 Completion Gate

Release 3 is complete only when:

- Every task review is clean.
- The complete automated gate passes.
- The shared controller proves cursor retention, exact-key dedupe, request
  serialization, visibility abort, foreground/manual refresh, adaptive quiet
  cadence, capped error backoff, Event reset, and stale-result rejection.
- `/live` retains newest-first balanced independent marquee columns, manual
  scrolling, four-second resume, lightbox, and reduced-motion behavior.
- The projector QR opens `/{event}/gallery`.
- `/{event}/gallery?photo=` remains backward compatible and opens the exact
  public photo without waiting for the browse feed.
- Phone browse preserves the visible anchor across incoming photos and offers
  localized new-photo notice/Jump to Latest.
- Moderation pages the full private reverse-time index with stable opaque
  cursors and inclusive time filters.
- Legacy rebuild is bounded, add-only, resumable, concurrency-safe, and marks
  completion only after a full successful scan.
- Exact moderation never accepts a prefix/fragment/cross-Event key.
- Public photo deletion happens before cleanup; cleanup targets only its exact
  receipt and index keys and cannot make a confirmed deletion ambiguous.
- Stale private index records never make a deleted public photo visible.
- Every supported catalog remains complete with English fallback and correct
  direction.
- Keyboard, focus, forced-color, reduced-motion, large-text, and automated
  accessibility checks pass.
- Staging verifies multiple pages, interrupted rebuild/resume, one exact canary
  deletion, private-state isolation, physical phone browse/share, VoiceOver,
  and real projector behavior.
