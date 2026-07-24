# Release 4 Repeatable Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe reusable Event presets and a guided private rehearsal that proves real-device readiness without copying credentials, weakening exact-key deletion, or automatically cleaning up test photos.

**Architecture:** Presets store only explicitly serialized `EventExperience` in private `STATE`; applying one passes through the existing revision/CAS path with reason `"preset"` and preserves the target Event's Booth credential. Rehearsals are immutable private snapshots plus append-only evidence. A pure reducer derives completion, staleness, manual checks, and outstanding exact photo keys, while a small durable Booth evidence outbox preserves evidence created during the required offline/reload sequence.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers, R2, IndexedDB, typed `en`/`zh-SG`/`ar` catalogs, QRCode, Playwright WebKit.

## Global Constraints

- Start only after Release 1 Booth auth/retry/heartbeat, Release 2 localization/handoff, and Release 3 public feed, exact-photo lookup, moderation, and exact deletion pass their complete gates.
- Use Bun commands only.
- `EventStore` remains the sole owner of `PHOTOS` and `STATE` keys.
- Presets and rehearsals live only in private `STATE`.
- Preset serialization constructs every allowed `EventExperience` field explicitly.
- Presets cannot contain Event identity, Booth credentials or hashes, revision IDs, health, heartbeat, moderation, photo, or rehearsal state.
- Applying a preset creates a normal config revision with `reason: "preset"`, a stable mutation ID, and the current `baseRevisionId`.
- Applying a preset preserves an existing target Booth Key and leaves a new target Event visibly without one.
- A config revision change makes an existing rehearsal stale even when the resulting experience is otherwise equivalent.
- Rehearsal uploads retain stable capture identity and remain idempotent under retries or lost acknowledgements.
- Rehearsal evidence is private, bounded, versioned, append-only, and idempotent by exact evidence identity.
- Rehearsal completion never authorizes prefix deletion, automatic photo cleanup, or bulk cleanup.
- The designated moderation canary is one exact rehearsal photo key deleted through the existing `DELETE /api/photos?event=&key=` contract.
- Every other rehearsal photo is explicitly retained or individually deleted by complete key.
- The rehearsal canary is not the short-lived `_health/canary`; `app/health.ts` keeps its existing independent exact cleanup behavior.
- A stale or abandoned rehearsal continues to show every outstanding exact test-photo key.
- All Event HTTP parameters use `canonicalEvent()` and reject aliases.
- Every changed UI uses complete `en`, `zh-SG`, and `ar` catalogs, English fallback, at least 44×44 controls, visible forced-color focus, reduced-motion behavior, RTL-safe exact keys, and concise live announcements.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never deploy the unnamed Wrangler environment to an Event domain.

---

## File Structure

- Create `app/event-preset.ts` — strict preset schema and explicit experience serialization.
- Create `app/event-preset.test.ts` — preset validation, privacy, and serialization tests.
- Modify `app/event-config.ts` — reuse/export explicit safe experience parsing/projection.
- Modify `app/event-config.test.ts` — projection and preset-boundary regression tests.
- Modify `app/event-store.ts` — private preset storage, preset application, rehearsal storage, and upload evidence.
- Modify `app/event-store.test.ts` — CAS, idempotency, privacy, staleness, evidence, and exact-key tests.
- Create `app/api/presets/handlers.ts` — dependency-injected Admin preset handlers.
- Create `app/api/presets/handlers.test.ts` — auth, validation, conflict, and redaction tests.
- Create `app/api/presets/route.ts` — preset list adapter.
- Create `app/api/presets/[presetId]/route.ts` — preset create/update adapter.
- Create `app/api/presets/apply/route.ts` — revisioned preset application adapter.
- Create `app/[event]/admin/preset-state.ts` — pure preset request/reconciliation state.
- Create `app/[event]/admin/preset-state.test.ts` — conflict, retry, and rebase tests.
- Create `app/[event]/admin/preset-panel.tsx` — localized safe preset controls.
- Create `app/[event]/admin/preset-panel.test.tsx` — accessible preset markup and busy-state tests.
- Modify `app/[event]/admin/page.tsx` — authenticated preset and rehearsal integration.
- Modify `app/[event]/admin/config-mutation.ts` — complete experience reconciliation after preset application.
- Modify `app/[event]/admin/config-mutation.test.ts` — preset rebase and Booth-key preservation tests.
- Modify `app/[event]/admin/config-history-panel.tsx` — localized preset revision reason.
- Modify `app/[event]/admin/config-history-panel.test.tsx` — preset-source summary tests.
- Create `app/rehearsal.ts` — strict session/evidence schemas and pure completion reducer.
- Create `app/rehearsal.test.ts` — reduction, staleness, exact correlation, and bounds tests.
- Modify `app/upload-contract.ts` — optional stable rehearsal identity header.
- Modify `app/upload-contract.test.ts` — rehearsal header validation and legacy compatibility.
- Modify `app/api/upload/handlers.ts` — require upload evidence before acknowledging rehearsal uploads.
- Modify `app/api/upload/route.test.ts` — retry, evidence failure, and cross-Event tests.
- Create `app/api/rehearsals/handlers.ts` — start/read/join/evidence HTTP handlers.
- Create `app/api/rehearsals/handlers.test.ts` — role, auth, canonicalization, and evidence tests.
- Create `app/api/rehearsals/route.ts` — Admin start/read adapter.
- Create `app/api/rehearsals/join/route.ts` — Booth-or-Admin join adapter.
- Create `app/api/rehearsals/evidence/route.ts` — append-only evidence adapter.
- Create `app/[event]/booth-session/rehearsal-evidence-outbox.ts` — durable private operational evidence queue.
- Create `app/[event]/booth-session/rehearsal-evidence-outbox.test.ts` — reload, ordering, and Event isolation tests.
- Create `app/[event]/booth-session/rehearsal-client.ts` — join, evidence capture, and durable drain controller.
- Create `app/[event]/booth-session/rehearsal-client.test.ts` — offline failure, reload, and ordered-drain tests.
- Modify `app/[event]/booth-session/session.ts` — exact item/failure callbacks needed by rehearsal.
- Modify `app/[event]/booth-session/session.test.ts` — callback isolation and acknowledgement ordering.
- Modify `app/[event]/booth-session/upload.ts` — emit rehearsal identity from durable Outbox rows.
- Modify `app/[event]/booth-session/upload.test.ts` — stable rehearsal header tests.
- Create `app/[event]/rehearsal-status.tsx` — localized Booth rehearsal guidance.
- Create `app/[event]/rehearsal-status.test.tsx` — accessible Booth status tests.
- Create `app/[event]/admin/rehearsal-panel.tsx` — guided Admin checklist and exact photo disposition.
- Create `app/[event]/admin/rehearsal-panel.test.tsx` — checklist, canary, stale, and abandon tests.
- Modify `app/[event]/page.tsx` — safe rehearsal join/tag/recovery integration.
- Modify `app/[event]/booth.module.css` — rehearsal guidance and accessibility.
- Modify `app/[event]/admin/admin.module.css` — preset and rehearsal layouts.
- Modify `app/i18n/catalog.ts` — complete preset/rehearsal messages.
- Modify `app/i18n/catalog.test.ts` — exact key and placeholder parity.
- Create `tests/rehearsal-operations.spec.ts` — mocked WebKit preset and rehearsal journeys.
- Modify `docs/runbooks/pre-event-readiness.md` — real-device rehearsal procedure.
- Modify `docs/runbooks/deployment.md` — Release 4 staging gate and exact disposition rules.

### Task 1: Define and store safe reusable Event presets

**Files:**
- Create: `app/event-preset.ts`
- Create: `app/event-preset.test.ts`
- Modify: `app/event-config.ts`
- Modify: `app/event-config.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Release 0A revision-aware `EventExperience` and explicit safe projection.
- Produces: strict `EventPreset` parsing and explicit safe serialization.
- Produces: private bounded preset get/list/create/update methods.
- Consumed by: Tasks 2–3.

- [ ] **Step 1: Write failing preset schema and privacy tests**

Define and test:

```ts
export type EventPreset = {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  config: EventExperience;
};

export function parseEventPreset(value: unknown): EventPreset | null;

export function serializePresetExperience(
  experience: EventExperience
): EventExperience;
```

Prove a complete experience round-trips:

```ts
const experience: EventExperience = {
  frames: ["square", "strip"],
  locales: ["en", "zh-SG", "ar"],
  defaultLocale: "en",
  timeZone: "Asia/Singapore",
  capture: {
    reviewEnabled: true,
    autoAcceptSeconds: 5,
    countdownAudioDefault: false,
  },
  gallery: {
    title: "Launch Night",
    accentColor: "#c45f39",
  },
};
```

The serialized result must contain only those explicitly named fields and
fresh nested arrays/objects. Add attempts containing `event`, `boothKey`,
`boothKeyHash`, `currentRevisionId`, `health`, `booths`, `rehearsal`,
`photos`, and arbitrary nested fields; none may enter the serialized or stored
result. Reject unknown versions, invalid IDs, blank labels, labels over 80
characters, invalid safe experience fields, and unexpected top-level keys.

- [ ] **Step 2: Run focused tests and verify missing exports**

```bash
bun test app/event-preset.test.ts app/event-config.test.ts
```

Expected: FAIL because the preset module and exported safe experience helpers
do not exist.

- [ ] **Step 3: Implement explicit preset parsing and serialization**

Use one strict preset ID contract:

```ts
export const isPresetId = (value: unknown): value is string =>
  typeof value === "string"
  && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
```

Export or reuse `parseEventExperience()` and `projectEventExperience()` from
`app/event-config.ts`. `serializePresetExperience()` must construct `frames`,
`locales`, `defaultLocale`, `timeZone`, `capture`, and `gallery` explicitly;
never spread an HTTP body or `EventConfig`.

- [ ] **Step 4: Write failing private store and conflict tests**

Define:

```ts
export const eventPresetKey = (presetId: string) =>
  `presets/${presetId}.json`;

export const eventPresetPrefix = () => "presets/";

EventStore.getEventPreset(
  presetId: string
): Promise<EventPreset | null>;

EventStore.listEventPresets(options?: {
  cursor?: string;
  limit?: number;
}): Promise<{
  presets: EventPreset[];
  cursor: string | null;
}>;

EventStore.putEventPreset(
  presetId: string,
  input: {
    label: string;
    config: EventExperience;
    expectedUpdatedAt: string | null;
  }
): Promise<EventPreset>;
```

Test:

- `expectedUpdatedAt: null` is create-only.
- Updating requires the exact currently observed `updatedAt`.
- `createdAt` remains unchanged and server time controls `updatedAt`.
- Concurrent stale updates produce a dedicated preset conflict.
- Lists accept opaque cursors and limits `1..100`, default `50`.
- Corrupt or unsupported stored versions fail explicitly.
- Presets are sorted by label then ID without trusting client locale.
- The authoritative record is only `STATE/presets/{id}.json`; bounded global
  ordering may additionally write version-unique derived entries under the
  private `STATE/presets/_index/v1/` namespace.
- `PHOTOS`, Events, config revisions, and adjacent presets stay untouched.
- No preset delete method or prefix cleanup exists. Updating a preset may
  delete only the exact superseded derived index key.

- [ ] **Step 5: Implement CAS-backed private preset methods**

Use `ObjectStore.compareAndSwap()` with the exact stored etag. For create,
compare against `null`. For update, read and validate the record, compare
`expectedUpdatedAt`, then CAS against its etag. A lost response followed by a
retry may return a conflict; the Admin reconciles by reloading and comparing
the safe content rather than overwriting a newer change.

Keep list work bounded with a private sortable index whose key encodes the
label, preset ID, and exact `updatedAt`. The opaque cursor carries the last
scanned derived key and resumes with `startAfter`. Readers validate every
entry against the authoritative preset and advance across stale entries.
Version-unique index keys make exact cleanup safe from delayed ABA updates.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test app/event-preset.test.ts app/event-config.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/event-preset.ts app/event-preset.test.ts \
  app/event-config.ts app/event-config.test.ts \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: store reusable event presets"
```

### Task 2: Apply presets through configuration history and expose Admin APIs

**Files:**
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`
- Modify: `app/api/config/handlers.ts`
- Modify: `app/api/config/handlers.test.ts`
- Create: `app/api/presets/handlers.ts`
- Create: `app/api/presets/handlers.test.ts`
- Create: `app/api/presets/route.ts`
- Create: `app/api/presets/[presetId]/route.ts`
- Create: `app/api/presets/apply/route.ts`

**Interfaces:**
- Consumes: Task 1 presets and Release 0A config revision CAS/idempotency.
- Produces: normal `reason: "preset"` revisions with `sourcePresetId`.
- Produces: Admin-only list, create/update, and apply HTTP contracts.
- Consumed by: Task 3 and rehearsal staleness in Task 4.

- [ ] **Step 1: Write failing preset-application mutation tests**

Define:

```ts
export type ConfigPresetApplyInput = {
  presetId: string;
  mutationId: string;
  baseRevisionId: string | null;
};

EventStore.applyEventPreset(
  event: string,
  input: ConfigPresetApplyInput
): Promise<ConfigMutationResult>;
```

Extend the private config mutation intent with an exact preset variant:

```ts
type ConfigPresetMutationIntent = {
  version: 1;
  config: EventExperience;
  baseRevisionId: string | null;
  boothKeyMutationFingerprint: null;
  reason: "preset";
  sourcePresetId: string;
};
```

Test:

- Applying creates a reachable revision with `reason: "preset"` and the exact
  `sourcePresetId`.
- The revision contains only preset `EventExperience`.
- An existing target `boothKeyHash` remains byte-identical.
- A target without a Booth Key remains without one.
- Applying over a legacy unrevisioned head creates the normal baseline.
- Same mutation ID/body retry is idempotent.
- Reusing a mutation ID for another preset, another base, or changed preset
  content conflicts.
- Stale base returns `ConfigConflictError`.
- Missing preset returns a dedicated not-found error.
- Concurrent apply/save has one head winner and harmless unreachable records.
- Save and Restore behavior remains unchanged.

- [ ] **Step 2: Run Event Store tests and verify failures**

```bash
bun test app/event-store.test.ts
```

Expected: FAIL because preset application and the preset mutation-intent
variant do not exist.

- [ ] **Step 3: Extend the existing revision append seam**

Extend `ConfigAppendInput`, intent parsing, matching, and revision construction
to accept:

```ts
{
  reason: "preset";
  sourcePresetId: string;
  sourceRevisionId?: never;
  boothKeyMutationFingerprint: null;
}
```

Call the same private `appendConfigRevision()` used by Save and Restore.
`mergedRevisionHead()` remains the only place that preserves the current Booth
hash. Do not create a preset-specific config head write path.

- [ ] **Step 4: Write failing handler and route tests**

HTTP contracts:

```text
GET  /api/presets?cursor=&limit=
PUT  /api/presets/{presetId}
POST /api/presets/apply?event=
```

PUT body:

```ts
{
  label: string;
  config: EventExperience;
  expectedUpdatedAt: string | null;
}
```

Apply body:

```ts
{
  presetId: string;
  mutationId: string;
  baseRevisionId: string | null;
}
```

Test missing Admin secret `503`, wrong key `401`, invalid ID/body `400`,
missing preset `404`, stale preset/config `409`, opaque bounded paging,
canonical Event rejection, exact response allowlists, and zero store calls
after failed auth. Attempt credential/state fields in the PUT body and prove
they are rejected before any write.

- [ ] **Step 5: Implement dependency-injected handlers and thin routes**

Add:

```ts
export type PresetHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};
```

All handlers require Admin auth before storage. The apply response is:

```ts
{
  config: PublicEventConfig;
  currentRevisionId: string;
  sourcePresetId: string;
  idempotent: boolean;
}
```

Construct every response field explicitly. Route modules only obtain
Cloudflare bindings, construct `EventStore`, and delegate.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test app/event-store.test.ts \
  app/api/config/handlers.test.ts \
  app/api/presets/handlers.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/event-store.ts app/event-store.test.ts \
  app/api/config app/api/presets
git commit -m "feat: apply presets through config revisions"
```

### Task 3: Add the localized Admin preset workflow

**Files:**
- Create: `app/[event]/admin/preset-state.ts`
- Create: `app/[event]/admin/preset-state.test.ts`
- Create: `app/[event]/admin/preset-panel.tsx`
- Create: `app/[event]/admin/preset-panel.test.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/config-mutation.ts`
- Modify: `app/[event]/admin/config-mutation.test.ts`
- Modify: `app/[event]/admin/config-history-panel.tsx`
- Modify: `app/[event]/admin/config-history-panel.test.tsx`
- Modify: `app/[event]/admin/admin.module.css`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`

**Interfaces:**
- Consumes: Task 2 APIs and Release 2 complete safe Admin experience state.
- Produces: safe preset create/update/apply controls with retry reconciliation.
- Preserves: the one shared config mutation guard and Booth plaintext rules.

- [ ] **Step 1: Write failing pure preset-state tests**

Define:

```ts
export type PendingPresetApply = {
  presetId: string;
  mutationId: string;
  baseRevisionId: string | null;
};

export function mergePresetPage(
  current: readonly EventPreset[],
  incoming: readonly EventPreset[]
): EventPreset[];

export function getOrCreatePresetApply(
  pending: Map<string, PendingPresetApply>,
  presetId: string,
  baseRevisionId: string | null,
  makeId: () => string
): PendingPresetApply;

export function reconcileAppliedPreset(input: {
  response: PublicEventConfig & { currentRevisionId: string };
  history: ConfigHistoryResponse;
  sourcePresetId: string;
}): {
  experience: EventExperience;
  currentRevisionId: string;
  hasBoothKey: boolean;
};
```

Test exact-ID page dedupe, updated preset replacement, label/ID ordering,
stable apply tuple retries, base changes, stale response rejection, complete
experience rebase, and server-authoritative `hasBoothKey`.

- [ ] **Step 2: Write failing accessible preset-panel tests**

Render and assert:

- Labelled preset ID and label fields.
- “Save current setup as preset” summary covering Frames, locales, capture,
  time zone, and Gallery settings.
- Create-only and selected-preset update states.
- Apply confirmation naming the target Event and preset.
- A visible statement that Booth credentials are never copied.
- A warning when the target Event has no Booth Key.
- No Delete button.
- Separate Apply/Cancel controls, at least 44×44.
- Busy/disabled state under Save, Restore, or Apply.
- Polite success and assertive error regions.
- RTL-safe IDs in `<bdi><code>`.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test 'app/[event]/admin/preset-state.test.ts' \
  'app/[event]/admin/preset-panel.test.tsx'
```

Expected: FAIL because the Admin preset modules do not exist.

- [ ] **Step 4: Implement authenticated loading and safe preset saves**

After Admin authentication, load preset pages with `Cache-Control: no-store`.
Route `401` through the existing Admin invalidation. A preset request failure
must not disable config, moderation, Booth controls, health, or export.

Create the body from the complete current safe experience held by Admin. Never
read Booth plaintext or `hasBoothKey` into preset content. Updates send the
selected preset's exact `updatedAt`.

- [ ] **Step 5: Integrate revisioned Apply with the config mutation guard**

Apply shares `configMutationBusy` with Save and Restore. Retain the complete
request tuple across network, 5xx, body-parse, and history-refresh failures.
Clear it only after response parsing and config-history reconciliation.

On success:

- Rebase every safe experience field, not only Frames.
- Clear unsaved Booth plaintext and copied-key state.
- Preserve `hasBoothKey` only from the server response.
- Reload history and render “Applied preset {label}” using
  `sourcePresetId`.

On `409`, clear the stale tuple, reload both config history and presets, and
show the existing review-before-saving conflict pattern.

- [ ] **Step 6: Extend complete catalogs and accessible styling**

Add every preset label, status, confirmation, warning, conflict, empty, and
error key to `en`, `zh-SG`, and `ar`. Keep exact key and placeholder parity.
Add visible high-contrast/forced-color focus, RTL layout, reduced motion, and
200% text reflow.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test 'app/[event]/admin/preset-state.test.ts' \
  'app/[event]/admin/preset-panel.test.tsx' \
  'app/[event]/admin/config-mutation.test.ts' \
  'app/[event]/admin/config-history-panel.test.tsx' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'app/[event]/admin' app/i18n
git commit -m "feat: manage event presets in admin"
```

### Task 4: Define rehearsal evidence, completion reduction, and private storage

**Files:**
- Create: `app/rehearsal.ts`
- Create: `app/rehearsal.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: config revisions, stable capture IDs, Booth device IDs, and exact photo keys.
- Produces: strict rehearsal session/evidence schemas and pure completion reduction.
- Produces: private create-only session/evidence storage and latest pointer.
- Consumed by: Tasks 5–7.

- [ ] **Step 1: Write failing session and evidence schema tests**

Define:

```ts
export type RehearsalSession = {
  version: 1;
  id: string;
  startedAt: string;
  configRevisionId: string | null;
  frames: string[];
};

type RehearsalEvidenceBase = {
  version: 1;
  id: string;
  rehearsalId: string;
  observedAt: number;
  recordedAt: string;
};
```

Define a strict discriminated evidence union:

```ts
type RehearsalEvidence =
  | (RehearsalEvidenceBase & {
      kind: "booth-ready";
      deviceId: string;
      bootId: string;
      cameraReady: true;
      durableStorage: true;
    })
  | (RehearsalEvidenceBase & {
      kind: "network-failure";
      captureId: string;
      bootId: string;
      errorClass: "network" | "timeout";
    })
  | (RehearsalEvidenceBase & {
      kind: "outbox-recovered";
      previousBootId: string;
      bootId: string;
      captureIds: string[];
    })
  | (RehearsalEvidenceBase & {
      kind: "photo-acknowledged";
      captureId: string;
      capturedAt: number;
      frameKey?: string;
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "ordered-drain";
      bootId: string;
      captureIds: string[];
    })
  | (RehearsalEvidenceBase & {
      kind: "delivery-observed";
      photoKey: string;
      feedObserved: true;
      publicImageObserved: true;
    })
  | (RehearsalEvidenceBase & {
      kind: "canary-designated";
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "canary-deleted";
      photoKey: string;
      cleanupPending: boolean;
    })
  | (RehearsalEvidenceBase & {
      kind: "outbox-empty";
      bootId: string;
      pendingCount: 0;
    })
  | (RehearsalEvidenceBase & {
      kind: "photo-retained" | "photo-deleted";
      photoKey: string;
    })
  | (RehearsalEvidenceBase & {
      kind: "manual-check";
      check: "composition" | "projector" | "power" | "charging" | "backup-network";
    })
  | (RehearsalEvidenceBase & {
      kind: "abandoned";
    });
```

Require lowercase UUID-v4 session, device, boot, capture, and client evidence
IDs; exact safe Frame tokens; integer 13-digit millisecond fields; complete
Event-owned image keys where an Event is supplied; maximum 256 IDs per array;
and exact keys for each union member. Reject unknown fields, arbitrary error
text, credentials, URLs, headers, user agents, unsupported versions, and
cross-Event keys.

- [ ] **Step 2: Write failing completion-reducer tests**

Define:

```ts
export type RehearsalRequirement =
  | "booth-ready"
  | "frames-covered"
  | "two-network-failures"
  | "reload-recovered"
  | "ordered-drain"
  | "public-delivery"
  | "canary-deleted"
  | "outbox-empty";

export function reduceRehearsal(input: {
  session: RehearsalSession;
  evidence: readonly RehearsalEvidence[];
  currentRevisionId: string | null;
}): RehearsalSummary;
```

Test:

- Authenticated readiness requires camera and durable storage in one record.
- Every snapshot Frame requires one acknowledged record with that Frame.
- Camera fallback never satisfies Frame coverage.
- Network failures require two distinct capture IDs.
- Recovery contains both failed IDs and a boot ID different from their failure
  boot.
- Ordered drain exactly matches the recovered order and every ID is
  acknowledged.
- Delivery observation refers to one acknowledged key and proves both feed and
  public bytes.
- Canary designation/deletion use the same acknowledged exact key.
- Empty Outbox is explicit.
- Any revision mismatch marks the summary stale.
- `null` remains non-stale only while both snapshot and current head are
  `null`.
- `remainingExactKeys` includes acknowledged photos without retained/deleted
  disposition and excludes the confirmed canary.
- Abandonment never hides outstanding keys.
- Manual checks are separate from the eight evidence requirements.
- Duplicate/idempotent evidence cannot overcount requirements.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test app/rehearsal.test.ts
```

Expected: FAIL because the schema and reducer do not exist.

- [ ] **Step 4: Implement strict parsing and a deterministic pure reducer**

Sort evidence by `recordedAt`, then exact evidence key/ID; never trust client
clock for sequence. Reduce exact capture/key sets without fuzzy filename or URL
matching. Return:

```ts
type RehearsalSummary = {
  status: "active" | "stale" | "complete" | "abandoned";
  stale: boolean;
  requirements: Record<RehearsalRequirement, {
    complete: boolean;
    evidenceIds: string[];
  }>;
  manualChecks: Record<
    "composition" | "projector" | "power" | "charging" | "backup-network",
    boolean
  >;
  trackedPhotos: {
    captureId: string;
    frameKey?: string;
    photoKey: string;
    disposition: "pending" | "canary-deleted" | "retained" | "deleted";
  }[];
  remainingExactKeys: string[];
};
```

`status: "complete"` means the eight required evidence checks pass and the
session is not stale/abandoned. Manual checks and remaining dispositions stay
visible rather than silently changing the evidence definition.

- [ ] **Step 5: Write failing private Event Store tests**

Define keys:

```ts
export const rehearsalSessionKey = (event: string, rehearsalId: string) =>
  `events/${event}/rehearsals/${rehearsalId}/session.json`;

export const rehearsalEvidencePrefix = (event: string, rehearsalId: string) =>
  `events/${event}/rehearsals/${rehearsalId}/evidence/`;

export const rehearsalEvidenceKey = (
  event: string,
  rehearsalId: string,
  observedAt: number,
  evidenceId: string
) => `${rehearsalEvidencePrefix(event, rehearsalId)}${String(observedAt).padStart(13, "0")}-${evidenceId}.json`;

export const latestRehearsalKey = (event: string) =>
  `events/${event}/rehearsals/latest.json`;
```

Define:

```ts
EventStore.startRehearsal(
  event: string,
  input: { rehearsalId: string }
): Promise<RehearsalSession>;

EventStore.readRehearsal(
  event: string,
  rehearsalId?: string
): Promise<{
  session: RehearsalSession;
  evidence: RehearsalEvidence[];
}>;

EventStore.appendRehearsalEvidence(
  event: string,
  rehearsalId: string,
  evidence: RehearsalEvidenceInput
): Promise<{
  evidence: RehearsalEvidence;
  idempotent: boolean;
}>;
```

Test immutable config-revision/Frame snapshot, create-only session, lost start
response retry, exact latest pointer, same-evidence retry, differing-evidence
collision, server-controlled `recordedAt`, at most 512 records, paged reads,
corrupt/future versions, cross-Event isolation, and zero `PHOTOS` writes or
deletes. A latest-pointer failure may leave a harmless private orphan; retrying
the same rehearsal ID finishes the pointer without replacing the snapshot.

- [ ] **Step 6: Implement private session/evidence storage**

`startRehearsal()` reads the current config head, snapshots its exact
`currentRevisionId` and enabled Frames, create-only writes the session, then
writes the small latest pointer. It never mutates config to manufacture a
revision.

Evidence uses create-only CAS. If the key exists, parse it and require exact
semantic equality for idempotent success. No rehearsal method lists or deletes
a `PHOTOS` prefix, and no completion/abandon method deletes any photo.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test app/rehearsal.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/rehearsal.ts app/rehearsal.test.ts \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: reduce private rehearsal evidence"
```

### Task 5: Expose rehearsal APIs and require upload evidence before acknowledgement

**Files:**
- Modify: `app/upload-contract.ts`
- Modify: `app/upload-contract.test.ts`
- Modify: `app/[event]/booth-session/upload.ts`
- Modify: `app/[event]/booth-session/upload.test.ts`
- Modify: `app/api/upload/handlers.ts`
- Modify: `app/api/upload/route.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`
- Create: `app/api/rehearsals/handlers.ts`
- Create: `app/api/rehearsals/handlers.test.ts`
- Create: `app/api/rehearsals/route.ts`
- Create: `app/api/rehearsals/join/route.ts`
- Create: `app/api/rehearsals/evidence/route.ts`

**Interfaces:**
- Consumes: Task 4 private store, stable upload identity, and shared `boothOrAdminOk()`.
- Produces: Admin start/read, safe Booth join, append-only evidence, and tracked uploads.
- Preserves: legacy/non-rehearsal upload behavior and exact moderation deletion.

- [ ] **Step 1: Write failing rehearsal upload-header tests**

Extend stable upload types:

```ts
export type StableUpload = StableCaptureIdentity & {
  source?: CaptureSource;
  frameKey?: string;
  configRevisionId?: string;
  rehearsalId?: string;
};
```

Emit `x-rehearsal-id` only when present. Test complete round trip, malformed
UUID, metadata without stable capture identity, unknown-header tolerance,
legacy requests with no new headers, and `outboxUploadHeaders()` preserving a
durable row's `rehearsalId` across reload.

- [ ] **Step 2: Write failing tracked-upload and retry tests**

Add:

```ts
EventStore.recordRehearsalUpload(
  event: string,
  rehearsalId: string,
  upload: StableUpload,
  photo: Pick<PutPhotoResult, "key" | "duplicate">
): Promise<RehearsalEvidence>;
```

The deterministic evidence identity is `upload-${captureId}`. Test:

- It requires an existing same-Event session.
- The evidence uses the complete returned photo key.
- Exact retry is idempotent.
- Another photo for the same evidence identity conflicts.
- Evidence failure after photo/index write leaves one public image.
- Identical upload retry creates missing evidence and returns the same photo as
  a duplicate.
- Cross-Event rehearsal IDs do not attach evidence.
- Receipt failure remains best-effort.
- Rehearsal evidence failure does not weaken stable index requirements.

- [ ] **Step 3: Write failing rehearsal handler tests**

HTTP contracts:

```text
POST /api/rehearsals?event=
GET  /api/rehearsals?event=&id=
POST /api/rehearsals/join?event=
POST /api/rehearsals/evidence?event=&id=
```

Start body:

```ts
{ rehearsalId: string }
```

Join body:

```ts
{ rehearsalId: string }
```

Join returns only:

```ts
{
  rehearsal: {
    id: string;
    startedAt: string;
    configRevisionId: string | null;
    frames: string[];
    stale: boolean;
  };
  serverTime: string;
}
```

Test:

- Start/read are Admin-only.
- Join and Booth evidence accept matching Booth or Admin auth.
- Missing Admin secret fails closed.
- Canonical aliases return `400`.
- Missing session returns `404`.
- Stale join returns the safe session with `stale: true`.
- Booth can append only readiness/failure/recovery/drain/empty evidence.
- Canary, dispositions, manual checks, and abandon are Admin-only.
- Unknown/unbounded fields are rejected before writes.
- Admin read returns the pure reduced summary and allowlisted evidence without
  storage keys.
- No endpoint returns credentials, hashes, heartbeat records, arbitrary
  errors, or private R2 key names.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
bun test app/upload-contract.test.ts \
  'app/[event]/booth-session/upload.test.ts' \
  app/api/upload/route.test.ts \
  app/api/rehearsals/handlers.test.ts \
  app/event-store.test.ts
```

Expected: FAIL because rehearsal upload tracking and handlers do not exist.

- [ ] **Step 5: Implement tracked upload acknowledgement**

In `handleUpload()`:

1. Parse rehearsal/stable headers before the body.
2. Authenticate and validate the same-Event rehearsal before the photo write.
3. Perform deterministic photo/index ingest.
4. Create server-generated `photo-acknowledged` evidence.
5. Return success only after that evidence exists.

Map rehearsal evidence write failure to:

```ts
NextResponse.json(
  { error: "rehearsal evidence unavailable", retryable: true },
  { status: 503, headers: { "Retry-After": "1" } }
);
```

Stable retry finishes evidence without duplicating the image. Invalid/missing
rehearsal identity returns `409` before photo bytes are written. Non-rehearsal
stable uploads and all legacy behavior remain unchanged.

- [ ] **Step 6: Implement handlers and thin route adapters**

Add:

```ts
export type RehearsalHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};
```

Role-check each evidence kind explicitly. Route modules own no private key
construction. Use `Cache-Control: no-store` for every rehearsal response.

Canary deletion remains outside these routes:

```text
DELETE /api/photos?event={canonical-event}&key={complete-event-owned-key}
```

The evidence endpoint records designation and confirmed outcome but never
performs bulk or prefix cleanup.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test app/upload-contract.test.ts \
  'app/[event]/booth-session/upload.test.ts' \
  app/api/upload/route.test.ts \
  app/api/rehearsals/handlers.test.ts \
  app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/upload-contract.ts app/upload-contract.test.ts \
  'app/[event]/booth-session/upload.ts' \
  'app/[event]/booth-session/upload.test.ts' \
  app/api/upload app/api/rehearsals \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: track authenticated rehearsal uploads"
```

### Task 6: Guide the Booth and Admin through a durable real-device rehearsal

**Files:**
- Create: `app/[event]/booth-session/rehearsal-evidence-outbox.ts`
- Create: `app/[event]/booth-session/rehearsal-evidence-outbox.test.ts`
- Create: `app/[event]/booth-session/rehearsal-client.ts`
- Create: `app/[event]/booth-session/rehearsal-client.test.ts`
- Modify: `app/[event]/booth-session/session.ts`
- Modify: `app/[event]/booth-session/session.test.ts`
- Create: `app/[event]/rehearsal-status.tsx`
- Create: `app/[event]/rehearsal-status.test.tsx`
- Create: `app/[event]/admin/rehearsal-panel.tsx`
- Create: `app/[event]/admin/rehearsal-panel.test.tsx`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/booth.module.css`
- Modify: `app/[event]/admin/admin.module.css`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`

**Interfaces:**
- Consumes: Release 1 preflight/retry/outbox, Task 5 APIs, Release 3 feed/exact deletion, and Task 4 reducer.
- Produces: durable offline evidence, guided Booth state, and exact Admin rehearsal operations.
- Preserves: Photo Outbox ordering, independent draining, and fresh Frame choice.

- [ ] **Step 1: Write failing durable evidence-outbox tests**

Define:

```ts
export type PendingRehearsalEvidence = {
  id: string;
  event: string;
  rehearsalId: string;
  createdAt: number;
  attempts: number;
  evidence: RehearsalEvidenceInput;
};

export interface RehearsalEvidenceOutbox {
  isDurable(): boolean;
  list(event: string, rehearsalId: string): Promise<PendingRehearsalEvidence[]>;
  put(item: PendingRehearsalEvidence): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createRehearsalEvidenceOutbox(
  indexedDB?: IDBFactory | null
): RehearsalEvidenceOutbox;
```

Use a separate additive database named `ipad-webbooth-rehearsal` with store
`evidence-outbox`; do not version-race or migrate the Photo Outbox database.

Test durable reload, created-at/ID ordering, exact remove, retry fields,
Event/rehearsal isolation, memory fallback, visible degraded durability, and
zero access to `photo-outbox`.

- [ ] **Step 2: Write failing Session callback and rehearsal-controller tests**

Extend Session observation without letting callbacks affect persistence:

```ts
type BoothSessionObserver = {
  onAcknowledged?: (item: OutboxItem, result: UploadResult) => void;
  onUploadFailure?: (
    item: OutboxItem,
    failure: { kind: "retryable" | "permanent" | "auth"; errorClass: UploadErrorClass }
  ) => void;
};
```

Test callbacks run only after durable state is saved, throwing callbacks cannot
change queue state, and acknowledgement identifies the exact removed item.

Define:

```ts
export class RehearsalClient {
  join(): Promise<void>;
  recordReadiness(input: {
    deviceId: string;
    cameraReady: boolean;
    durableStorage: boolean;
  }): Promise<void>;
  recordUploadFailure(item: OutboxItem, failure: ClassifiedFailure): Promise<void>;
  recordRecovery(items: readonly OutboxItem[]): Promise<void>;
  recordAcknowledgement(item: OutboxItem): Promise<void>;
  recordEmptyOutbox(): Promise<void>;
  drainEvidence(): Promise<void>;
  stop(): void;
}
```

Test:

- Join occurs only after successful preflight.
- One new `bootId` is generated per page load.
- Only new accepted rows receive the active `rehearsalId`.
- Two network-class failures are persisted before scheduling/reload.
- Permanent/auth/server failures do not masquerade as network evidence.
- Reload under a new boot ID records the exact prior ordered capture IDs.
- Acknowledgement sequence creates matching ordered-drain evidence.
- Empty Outbox creates one idempotent evidence item.
- Evidence drains oldest-first and leaves storage only after server ack.
- Evidence failure never blocks Photo Outbox drain.
- Online/foreground immediately reconsiders evidence.
- Leaving rehearsal stops tagging new rows but does not alter existing rows.

- [ ] **Step 3: Write failing Booth and Admin component tests**

Booth status must render:

- Rehearsal name/ID and visible operator context.
- Stale warning that blocks new rehearsal captures but allows Outbox drain.
- Current Frame coverage and pending evidence count.
- Durable-evidence warning.
- Localized next-step guidance.
- A visible Leave Rehearsal action.

Admin panel must render:

- Start/new-session control and confirmation.
- Local QR plus visible `/{event}?rehearsal={id}` link.
- All eight reducer requirements.
- Five explicit manual checks.
- Exact tracked keys in `<bdi><code>`.
- Canary selector limited to acknowledged rehearsal photos.
- Exact delete confirmation with filename and complete key.
- Separate Retain and Delete Exact Photo actions for every non-canary photo.
- No cleanup-all or bulk-delete control.
- Stale and abandoned state with outstanding exact keys still visible.
- Focus restoration, live status, 44×44 controls, forced-color focus, RTL,
  and reduced motion.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
bun test 'app/[event]/booth-session/rehearsal-evidence-outbox.test.ts' \
  'app/[event]/booth-session/rehearsal-client.test.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/rehearsal-status.test.tsx' \
  'app/[event]/admin/rehearsal-panel.test.tsx'
```

Expected: FAIL because the durable evidence controller and presentations do
not exist.

- [ ] **Step 5: Implement Booth rehearsal integration**

Admin generates a link with only the public rehearsal ID; never include a
credential. The Booth:

1. Recovers the Photo Outbox before auth as Release 1 requires.
2. Completes online authenticated preflight.
3. Joins the rehearsal and displays stale state if applicable.
4. Starts camera/readiness evidence only after join.
5. Tags only newly accepted captures with `rehearsalId`.
6. Persists network evidence locally before any reload can lose it.
7. On reload, filters recovered exact rows by rehearsal ID and records their
   order with the new boot ID.
8. Lets stable uploads create server acknowledgement evidence.
9. Records ordered drain and empty Outbox without blocking the next guest.

Pause, auth-required, installed exit, Retake, handoff, and fresh Frame choice
retain their existing semantics.

- [ ] **Step 6: Implement Admin public observation and exact canary flow**

The “Observe public delivery” action:

1. Fetches public `GET /api/photos?event={event}`.
2. Locates one exact acknowledged rehearsal key.
3. Fetches the exact public URL returned by that response.
4. Requires a successful byte response.
5. Appends `delivery-observed` for that same exact key.

The canary action:

1. Appends `canary-designated` for one acknowledged exact key.
2. Calls the existing exact `DELETE /api/photos?event=&key=`.
3. Treats `deleted: true` as authoritative even when cleanup is pending.
4. Appends `canary-deleted` with the exact same key and cleanup status.
5. Never retries a confirmed public deletion.

All other photos receive individual Retain or Delete Exact Photo actions.
Completion and abandonment trigger no photo cleanup.

- [ ] **Step 7: Integrate Admin polling and staleness**

After Admin auth, load the latest rehearsal and refresh with completion-driven
non-overlapping requests. Route `401` through the shared invalidation. Config
revision mismatch derives stale state client/server-side; do not write stale
markers or overwrite evidence. “Start new rehearsal” creates a new immutable
session and leaves the old one readable.

- [ ] **Step 8: Extend complete catalogs and styles**

Add every Booth/Admin rehearsal action, requirement, manual check, error,
empty, stale, abandon, canary, exact-disposition, and evidence durability key
to `en`, `zh-SG`, and `ar`. Preserve exact key and placeholder parity.

- [ ] **Step 9: Run focused and full checks**

```bash
bun test 'app/[event]/booth-session/rehearsal-evidence-outbox.test.ts' \
  'app/[event]/booth-session/rehearsal-client.test.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/rehearsal-status.test.tsx' \
  'app/[event]/admin/rehearsal-panel.test.tsx' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add 'app/[event]/booth-session' \
  'app/[event]/rehearsal-status.tsx' \
  'app/[event]/rehearsal-status.test.tsx' \
  'app/[event]/page.tsx' \
  'app/[event]/booth.module.css' \
  'app/[event]/admin' app/i18n
git commit -m "feat: guide real-device rehearsals"
```

### Task 7: Add browser coverage, runbooks, and the Release 4 gate

**Files:**
- Create: `tests/rehearsal-operations.spec.ts`
- Modify: `.github/workflows/verify.yml` only if Release 1–3 browser coverage is not already retained.
- Modify: `docs/runbooks/pre-event-readiness.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: Tasks 1–6 and the Release 1 Playwright WebKit setup.
- Produces: repeatable automated coverage plus mandatory staging/real-device evidence.

- [ ] **Step 1: Add failing WebKit preset journeys**

Intercept preset/config APIs and test:

- Create, list, update, and apply a complete safe preset.
- Attempted credential/state fields are rejected.
- Existing Booth Key remains installed after apply.
- A new Event remains visibly keyless after apply.
- Lost response retry reconciles without a second revision.
- Stale preset/config conflicts reload before another mutation.
- Applying changes every safe experience control.
- History shows the exact preset source.
- Keyboard, Arabic RTL, forced colors, reduced motion, 200% text, and no
  serious axe violations.

- [ ] **Step 2: Add failing WebKit rehearsal journeys**

Mock camera, IndexedDB, upload, feed, public bytes, exact delete, and evidence
APIs. Test:

- Booth never joins before authenticated preflight.
- Camera readiness and durable storage evidence.
- One acknowledged capture for every enabled Frame.
- Two distinct network-class failures persisted before reload.
- Reload creates another boot ID and recovers both exact rows in order.
- Reconnection drains in order and creates no duplicate photos.
- Feed and public byte observation correlate one exact key.
- One exact canary deletion leaves adjacent photos intact.
- Cleanup-pending does not invite another public DELETE.
- Empty Outbox completes the eighth requirement.
- Remaining photos are not deleted at completion.
- Each Retain/Delete action targets one complete key.
- Config mutation marks the rehearsal stale.
- Abandonment retains the exact outstanding-key inventory.
- Evidence endpoint failure never blocks Photo Outbox drain.
- Keyboard/focus/live regions, Arabic RTL, forced colors, reduced motion,
  200% text, and no serious axe violations.

- [ ] **Step 3: Run browser coverage and fix deterministic failures**

```bash
bun run test:browser -- tests/rehearsal-operations.spec.ts
```

Expected: PASS without staging or production traffic.

- [ ] **Step 4: Update the pre-event readiness runbook**

Add a mandatory staging-first guided rehearsal:

1. Use a throwaway canonical staging Event distinct from production.
2. Apply the intended preset and separately install/verify its Booth Key.
3. Open the generated rehearsal link on the actual iPad over HTTPS.
4. Verify camera readiness and durable IndexedDB.
5. Capture one accepted photo with every enabled Frame and inspect physical
   composition.
6. Create two genuine network-class upload failures on two distinct items.
7. Reload Safari and confirm a different boot ID recovers both exact items.
8. Reconnect and confirm exact oldest-first drain with no duplicates.
9. Observe one exact key in the public Photo Feed and fetch its public bytes.
10. Designate and delete one exact canary; verify adjacent photos remain.
11. Explicitly retain or individually delete every other test photo.
12. Confirm the Outbox and evidence outbox are empty.
13. Complete projector, power, charging, and backup-network manual checks.
14. Change config once and verify the old rehearsal becomes stale rather than
    mutating its evidence.

State explicitly that a browser simulator cannot prove real camera,
IndexedDB/Safari suspension, genuine venue-network failure, installed wake
behavior, projector crop/brightness/motion, charging/power, backup network, or
VoiceOver.

- [ ] **Step 5: Update deployment and rollback guidance**

Add:

- Release 4 uses only explicit `deploy:staging` then `deploy:production`.
- Inspect exact staging records to confirm presets/rehearsals/evidence exist
  only in staging `STATE`.
- Rehearsal photo bytes remain normal exact public photos in staging `PHOTOS`.
- Never use the health canary prefix for rehearsal.
- Never add a cleanup-all command.
- Rollback changes Worker code only; it does not delete presets, sessions,
  evidence, photos, indexes, or receipts.
- An abandoned/stale session is resolved through visible exact keys, one at a
  time.

- [ ] **Step 6: Run the complete Release 4 gate**

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
bun run test:browser -- tests/rehearsal-operations.spec.ts
```

Expected: every command passes. Do not claim the release operationally ready
until the staging real-iPad and projector checklist also passes.

- [ ] **Step 7: Self-review safety and compatibility**

Verify:

- No preset or rehearsal object was written to `PHOTOS`.
- No credential/hash/revision head entered a preset.
- No rehearsal route accepts a prefix, filename fragment, or cross-Event key.
- Completion/abandonment performs zero automatic photo deletion.
- Existing upload, Photo Feed, exact-photo, moderation, health, and export
  contracts remain backward compatible.
- Unsupported future stored versions fail explicitly.
- Existing Outbox rows and Photo Outbox IndexedDB remain readable.
- CI retains application typecheck, test typecheck, unit tests, Frame
  validation, production build, and established browser coverage.

- [ ] **Step 8: Commit**

```bash
git add tests/rehearsal-operations.spec.ts \
  .github/workflows/verify.yml \
  docs/runbooks/pre-event-readiness.md \
  docs/runbooks/deployment.md
git commit -m "test: verify repeatable event operations"
```

## Manual Acceptance Boundary

Release 4 automation proves protocol, storage, reducer, accessibility markup,
and mocked browser behavior. It does not replace the staging rehearsal on a
real iPad and projector. Production promotion remains blocked until an
operator verifies real camera permissions/composition, durable Safari reload,
two actual network failures, ordered recovery, installed/wake behavior,
VoiceOver, projector output, charging/power, backup network, exact canary
deletion, explicit disposition of every other test photo, and empty Outboxes.
