# Release 2 Guest Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-composite review and Retake, guarded acceptance, exact-current-photo QR handoff, and the first complete localized and accessibility-aware guest flow.

**Architecture:** Composition produces an unencoded canvas. A pure capture-flow reducer and guarded decision gate own review state; only the winning acceptance encodes and hands one JPEG to the Booth Session. The Session reports acknowledgements with both the exact Outbox item and server result so a pure handoff reducer can ignore stale uploads. Release 2 also creates a minimal exact-photo `/{event}/gallery?photo=` shell because the QR must work now; Release 3 expands that route without changing its direct-photo contract.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Canvas, IndexedDB, Web Audio, local `qrcode`, Cloudflare Workers/R2, Playwright WebKit.

## Global Constraints

- Start only after Release 0B stable Outbox identity/idempotent upload and Release 1 Booth control pass their complete gates.
- Use Bun commands only.
- The Booth Session remains the owner of accepted-photo durability, ordered upload, retry, and acknowledgement.
- `EventStore` remains the only owner of `PHOTOS` keys, exact Event-owned photo validation, and public photo URLs.
- Review shows the exact final composite canvas; composition never JPEG-encodes before acceptance.
- Only one guarded acceptance may encode and enqueue a candidate.
- Retake keeps the same Frame; durable acceptance clears the Frame immediately.
- An older delayed acknowledgement never replaces or reopens the current guest handoff.
- Offline/queued handoff never blocks the next guest and never invents a QR before acknowledgement.
- Every QR is generated locally and has a visible text link.
- The direct-photo endpoint exposes no receipt, index, revision, credential, heartbeat, or other private state.
- Existing Outbox rows and legacy config locale tokens remain readable.
- No service worker or iOS background-upload guarantee is added.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never silently slug an Event at an HTTP boundary.
- Never deploy the unnamed Wrangler environment to an Event domain.

---

## File Structure

- Create `app/i18n/catalog.ts` — complete typed guest message catalogs.
- Create `app/i18n/catalog.test.ts` — catalog completeness and interpolation tests.
- Create `app/i18n/locale.ts` — supported-locale resolution, persistence, and document direction.
- Create `app/i18n/locale.test.ts` — fallback, storage, and RTL tests.
- Modify `app/event-config.ts` — safe supported-locale helpers without breaking legacy reads.
- Modify `app/event-config.test.ts` — locale and capture-setting validation.
- Modify `app/api/config/handlers.ts` — save the complete allowlisted experience.
- Modify `app/api/config/handlers.test.ts` — settings preservation and rejection tests.
- Modify `app/frame-packs/types.ts` — optional localized Frame labels.
- Modify `app/frame-packs/catalog.ts` — runtime label preservation.
- Modify `app/frame-packs/validate.ts` — bounded localized-label validation.
- Modify `app/frame-packs/validate.test.ts` — fallback and invalid-label tests.
- Modify `app/[event]/admin/page.tsx` — load/save/restore capture and locale settings.
- Modify `app/[event]/admin/admin-config-controls.tsx` — locale and capture controls.
- Modify `app/[event]/admin/admin-config-controls.test.tsx` — control markup and disabled states.
- Modify `app/[event]/admin/config-mutation.ts` — complete experience rebasing.
- Modify `app/[event]/admin/config-mutation.test.ts` — setting preservation.
- Modify `app/[event]/admin/config-history-panel.tsx` — summarize revision capture/locales.
- Modify `app/[event]/admin/config-history-panel.test.tsx` — revision summary tests.
- Modify `app/[event]/admin/admin.module.css` — settings controls.
- Modify `app/templates.ts` — separate exact canvas composition from JPEG encoding.
- Modify `app/templates.test.ts` — draw order and encoding-boundary tests.
- Create `app/[event]/booth-session/review.ts` — guarded review timeout decisions.
- Create `app/[event]/booth-session/review.test.ts` — timer/button race tests.
- Create `app/[event]/booth-session/capture-flow.ts` — pure guest capture state reducer.
- Create `app/[event]/booth-session/capture-flow.test.ts` — transition and stale-action tests.
- Create `app/[event]/capture-review.tsx` — exact-canvas review presentation.
- Create `app/[event]/capture-review.test.tsx` — accessible review markup.
- Create `app/[event]/booth-session/countdown-audio.ts` — gesture-activated optional tones.
- Create `app/[event]/booth-session/countdown-audio.test.ts` — activation and failure tests.
- Modify `app/[event]/page.tsx` — review, acceptance, localization, audio, and pause integration.
- Modify `app/[event]/booth.module.css` — review/handoff/accessibility styling.
- Modify `app/event-store.ts` — exact public photo lookup.
- Modify `app/event-store.test.ts` — exact ownership and privacy tests.
- Create `app/api/photo/handlers.ts` — dependency-injected exact-photo handler.
- Create `app/api/photo/handlers.test.ts` — canonical Event/key/error tests.
- Create `app/api/photo/route.ts` — thin Cloudflare route adapter.
- Create `app/[event]/gallery/page.tsx` — direct-photo Gallery route.
- Create `app/[event]/gallery/handoff-gallery.tsx` — minimal exact-photo landing.
- Create `app/[event]/gallery/handoff-gallery.test.tsx` — query/error/save markup tests.
- Create `app/[event]/gallery/gallery.module.css` — phone-first landing styles.
- Modify `app/[event]/booth-session/session.ts` — exact item acknowledgement callback.
- Modify `app/[event]/booth-session/session.test.ts` — acknowledgement ordering/correlation.
- Create `app/[event]/booth-session/handoff.ts` — pure current-handoff state and URL builder.
- Create `app/[event]/booth-session/handoff.test.ts` — stale/delayed acknowledgement tests.
- Create `app/[event]/handoff-panel.tsx` — local QR, visible link, and queued state.
- Create `app/[event]/handoff-panel.test.tsx` — stale QR and link identity tests.
- Create `tests/guest-capture.spec.ts` — mocked-camera WebKit guest journey.
- Modify `docs/runbooks/pre-event-readiness.md` — real-iPad Release 2 checks.
- Modify `docs/runbooks/deployment.md` — Release 2 staging gate.

### Task 1: Add complete catalogs, locale resolution, localized Frame labels, and capture configuration

**Files:**
- Create: `app/i18n/catalog.ts`
- Create: `app/i18n/catalog.test.ts`
- Create: `app/i18n/locale.ts`
- Create: `app/i18n/locale.test.ts`
- Modify: `app/event-config.ts`
- Modify: `app/event-config.test.ts`
- Modify: `app/api/config/handlers.ts`
- Modify: `app/api/config/handlers.test.ts`
- Modify: `app/frame-packs/types.ts`
- Modify: `app/frame-packs/catalog.ts`
- Modify: `app/frame-packs/validate.ts`
- Modify: `app/frame-packs/validate.test.ts`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/admin-config-controls.tsx`
- Modify: `app/[event]/admin/admin-config-controls.test.tsx`
- Modify: `app/[event]/admin/config-mutation.ts`
- Modify: `app/[event]/admin/config-mutation.test.ts`
- Modify: `app/[event]/admin/config-history-panel.tsx`
- Modify: `app/[event]/admin/config-history-panel.test.tsx`
- Modify: `app/[event]/admin/admin.module.css`

**Interfaces:**
- Consumes: Release 1 preflight `EventExperience`.
- Produces: complete built-in `en`, `zh-SG`, and `ar` guest catalogs.
- Produces: supported-locale selection and per-Event/device persistence.
- Produces: localized Frame-label fallback and complete revision-aware Admin settings.

- [ ] **Step 1: Write failing catalog, locale, and Frame-label tests**

Test these contracts:

```ts
export const SUPPORTED_LOCALES = ["en", "zh-SG", "ar"] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];
export type MessageKey = keyof typeof englishMessages;

export function isSupportedLocale(value: unknown): value is SupportedLocale;
export function message(
  locale: SupportedLocale,
  key: MessageKey,
  values?: Record<string, string | number>
): string;
export function localeDirection(locale: SupportedLocale): "ltr" | "rtl";
```

Prove every catalog has exactly the English key set and the same interpolation
placeholders. Prove English fallback, Arabic RTL, stored-locale precedence,
configured-default/browser-language fallback, and Event-isolated persistence.

Extend the Frame contract additively:

```ts
type FrameDefinition = {
  label: string;
  labels?: Partial<Record<SupportedLocale, string>>;
  // existing fields unchanged
};
```

Test localized lookup plus fallback to the required default `label`. Validator
tests reject unsupported locale keys, blank labels, and labels longer than 80
characters.

- [ ] **Step 2: Run focused tests and verify missing-module failures**

Run:

```bash
bun test app/i18n/catalog.test.ts app/i18n/locale.test.ts \
  app/frame-packs/validate.test.ts
```

Expected: FAIL because catalog and locale modules do not exist.

- [ ] **Step 3: Implement catalogs, locale resolution, and Frame labels**

Add:

```ts
export function resolveEnabledLocales(
  configured: readonly string[] | undefined
): SupportedLocale[];

export function resolveDeviceLocale(input: {
  event: string;
  configured: readonly string[] | undefined;
  defaultLocale?: string;
  storedLocale?: string | null;
  navigatorLanguages?: readonly string[];
}): SupportedLocale;

export function saveDeviceLocale(
  event: string,
  locale: SupportedLocale,
  storage: Pick<Storage, "setItem">
): void;

export function applyDocumentLocale(
  documentElement: Pick<HTMLElement, "lang" | "dir">,
  locale: SupportedLocale
): void;

export function frameLabel(
  frame: Pick<FrameDefinition, "label" | "labels">,
  locale: SupportedLocale
): string;
```

Keep stored `LocaleCode` parsing permissive so old configuration remains
readable. Runtime resolution intersects configured locales with the complete
built-in catalogs and always retains English fallback.

- [ ] **Step 4: Write failing configuration and Admin preservation tests**

Test:

- New saves accept only supported enabled/default locales.
- `defaultLocale` must be enabled.
- `autoAcceptSeconds` remains an integer from `1..30`.
- Admin loads, saves, restores, and rebases locales, default locale,
  `reviewEnabled`, `autoAcceptSeconds`, and `countdownAudioDefault`.
- A save preserves existing `timeZone` and `gallery` values even though their
  controls are outside this release.
- Booth credentials remain preserved when unchanged and are never exposed.
- History summaries make capture/locale changes visible.

- [ ] **Step 5: Implement complete safe experience saving and controls**

The config handler explicitly constructs the whole allowlisted
`EventExperience`; never spread the request body. Keep frames-only requests
compatible. The Admin retains every safe experience field returned by history,
sends the complete experience, and updates all controls after restore.

Controls expose:

- Enabled locale checkboxes.
- Default locale selector.
- Review enabled.
- Auto-accept seconds, default `5`.
- Countdown audio default.

Disable them under the existing config mutation guard.

- [ ] **Step 6: Run focused and full checks**

Run:

```bash
bun test app/i18n/catalog.test.ts app/i18n/locale.test.ts \
  app/event-config.test.ts app/api/config/handlers.test.ts \
  app/frame-packs/validate.test.ts \
  'app/[event]/admin/admin-config-controls.test.tsx' \
  'app/[event]/admin/config-mutation.test.ts' \
  'app/[event]/admin/config-history-panel.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/i18n app/event-config.ts app/event-config.test.ts \
  app/api/config/handlers.ts app/api/config/handlers.test.ts \
  app/frame-packs 'app/[event]/admin'
git commit -m "feat: configure localized guest capture"
```

### Task 2: Separate exact canvas composition from encoding and guard review decisions

**Files:**
- Modify: `app/templates.ts`
- Modify: `app/templates.test.ts`
- Create: `app/[event]/booth-session/review.ts`
- Create: `app/[event]/booth-session/review.test.ts`
- Create: `app/[event]/booth-session/capture-flow.ts`
- Create: `app/[event]/booth-session/capture-flow.test.ts`

**Interfaces:**
- Produces: an exact unencoded composite canvas and one JPEG encoding boundary.
- Produces: a timer/button decision gate and pure capture-flow reducer.
- Consumed by: Task 3.

- [ ] **Step 1: Write failing composition-boundary and decision-race tests**

Define:

```ts
export async function composeToCanvas(
  frames: CanvasImageSource[],
  frameSizes: { w: number; h: number }[],
  template: Template
): Promise<HTMLCanvasElement>;

export function encodeCanvas(
  canvas: HTMLCanvasElement,
  quality?: number
): Promise<Blob>;
```

Keep `composite()` as a compatibility wrapper over both functions. Tests prove
background/photo/overlay draw order is unchanged and `composeToCanvas()` never
calls `toBlob()` or `toDataURL()`.

Define:

```ts
export type ReviewChoice = "accept" | "retake";

export interface ReviewClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class ReviewDecisionGate {
  constructor(
    autoAcceptSeconds: number,
    onDecision: (choice: ReviewChoice) => void,
    clock?: ReviewClock
  );
  start(): void;
  accept(): boolean;
  retake(): boolean;
  moreTime(): boolean;
  cancel(): void;
}
```

Test five-second timeout, More Time cancellation, Retake-before-timeout,
button/timer race, repeated clicks, and unmount cancellation.

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```bash
bun test app/templates.test.ts \
  'app/[event]/booth-session/review.test.ts' \
  'app/[event]/booth-session/capture-flow.test.ts'
```

Expected: FAIL because the new APIs do not exist.

- [ ] **Step 3: Implement composition and guarded decisions**

The first `accept()`, `retake()`, or timer callback wins synchronously. Losing
decisions return `false`. `moreTime()` cancels automatic acceptance without
choosing, and `cancel()` prevents stale callbacks.

Add a pure reducer:

```ts
type CapturePhase =
  | "picker" | "ready" | "capturing"
  | "reviewing" | "accepting" | "handoff";

type ReviewCandidate = {
  id: string;
  source: "framed" | "camera-fallback";
  frameKey?: string;
  canvas: HTMLCanvasElement;
};

export function reduceCaptureFlow(
  state: CaptureFlowState,
  action: CaptureFlowAction
): CaptureFlowState;
```

Required transitions:

- Capture completion retains the Frame and enters review.
- Retake returns to ready with the same Frame.
- Acceptance synchronously enters `accepting`.
- Encode/enqueue failure returns to review with no restarted timer.
- Durable enqueue success clears the Frame and enters handoff.
- Review-disabled capture moves directly to accepting.
- Candidate IDs make stale callbacks/actions no-ops.

- [ ] **Step 4: Run focused and full checks**

Run:

```bash
bun test app/templates.test.ts \
  'app/[event]/booth-session/review.test.ts' \
  'app/[event]/booth-session/capture-flow.test.ts'
bun run typecheck
bun run typecheck:tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/templates.ts app/templates.test.ts 'app/[event]/booth-session'
git commit -m "feat: guard exact composite review decisions"
```

### Task 3: Integrate review, Retake, More Time, localization, and countdown tones

**Files:**
- Create: `app/[event]/capture-review.tsx`
- Create: `app/[event]/capture-review.test.tsx`
- Create: `app/[event]/booth-session/countdown-audio.ts`
- Create: `app/[event]/booth-session/countdown-audio.test.ts`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/booth.module.css`

**Interfaces:**
- Consumes: Tasks 1–2, Release 0B Outbox metadata, and Release 1 pause/access state.
- Produces: exact-canvas guest review and one guarded durable acceptance.

- [ ] **Step 1: Write failing review markup, acceptance, and audio tests**

Define:

```ts
type CaptureReviewProps = {
  canvas: HTMLCanvasElement;
  autoAcceptSeconds: number;
  accepting: boolean;
  error: string | null;
  labels: {
    usePhoto: string;
    retake: string;
    moreTime: string;
    accepting: string;
    preview: string;
  };
  onAccept(): void;
  onRetake(): void;
  onMoreTime(): void;
};
```

Test semantic canvas labeling, default-focus target, disabled accepting
controls, status/error regions, and localized labels.

Define:

```ts
export class CountdownToneController {
  activate(): Promise<boolean>;
  tick(count: number): void;
  captured(): void;
  dispose(): Promise<void>;
}
```

Test that calls before activation are no-ops, activation requires an explicit
caller gesture, unsupported/denied audio degrades silently, ticks are bounded,
and disposal releases resources.

- [ ] **Step 2: Run focused tests and verify missing components**

Run:

```bash
bun test 'app/[event]/capture-review.test.tsx' \
  'app/[event]/booth-session/countdown-audio.test.ts'
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the exact review and acceptance flow**

In the Booth:

1. Capture frames and call `composeToCanvas()`.
2. Display that exact canvas in review.
3. Focus Use Photo when review opens.
4. Start the configured timer, default five seconds.
5. More Time permanently cancels auto-accept for that candidate.
6. The winning acceptance disables all actions before any `await`.
7. Call `encodeCanvas()` and then `session.enqueueCapture()` with
   framed/fallback metadata.
8. Only after the Outbox write succeeds, release the canvas, clear the Frame,
   and enter handoff.
9. Encode/Outbox failure keeps the same Frame/canvas, creates no Outbox item,
   shows an accessible error, and requires an explicit retry or Retake.
10. Retake releases the candidate and returns to camera-ready with the same
    Frame.
11. File-camera fallback decodes to a canvas first and uses the same review
    path; undecodable input is never enqueued under a JPEG content type.

- [ ] **Step 4: Apply locale, pause, audio, and accessibility behavior**

- Persist locale per canonical Event/device and update document `lang`/`dir`.
- Localize all changed picker, countdown, review, queued, handoff, and
  direct-photo strings.
- Use localized Frame labels with default-label fallback.
- Activate optional tones only from a guest gesture; visual countdown remains.
- Pause during capture/review/accepting lets the current flow finish or Retake,
  then clears the Frame and stops camera tracks. Outbox drain continues.
- Make every target at least `44×44px`.
- Add visible `:focus-visible`, forced-color outlines, reduced-motion removal
  of flash/fade/scale animation, concise live announcements, and pointer-
  independent error dismissal.
- Retake returns focus to the shutter; handoff later focuses its heading.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
bun test 'app/[event]/capture-review.test.tsx' \
  'app/[event]/booth-session/countdown-audio.test.ts' \
  'app/[event]/booth-session/capture-flow.test.ts' \
  'app/[event]/booth-session/session.test.ts'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'app/[event]/capture-review.tsx' \
  'app/[event]/capture-review.test.tsx' \
  'app/[event]/booth-session/countdown-audio.ts' \
  'app/[event]/booth-session/countdown-audio.test.ts' \
  'app/[event]/page.tsx' 'app/[event]/booth.module.css'
git commit -m "feat: review and retake guest captures"
```

### Task 4: Add a safe exact-photo endpoint and minimal direct-photo Gallery shell

**Files:**
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`
- Create: `app/api/photo/handlers.ts`
- Create: `app/api/photo/handlers.test.ts`
- Create: `app/api/photo/route.ts`
- Create: `app/[event]/gallery/page.tsx`
- Create: `app/[event]/gallery/handoff-gallery.tsx`
- Create: `app/[event]/gallery/handoff-gallery.test.tsx`
- Create: `app/[event]/gallery/gallery.module.css`

**Interfaces:**
- Produces: an exact Event-owned public-photo lookup.
- Produces: the stable `/{event}/gallery?photo=<complete-key>` landing contract.
- Consumed by: Task 5 and expanded, not replaced, by Release 3.

- [ ] **Step 1: Write failing exact ownership and privacy tests**

Define:

```ts
export type PublicPhoto = {
  key: string;
  url: string;
  uploadedAt: string;
};

EventStore.getPublicPhoto(
  event: string,
  completeKey: string
): Promise<PublicPhoto | null>;
```

Test:

- Exact Event-owned image success.
- Canonical alias, prefix, filename fragment, traversal, and cross-Event
  rejection before a storage read.
- A valid exact missing key returns not found.
- Only the exact `PHOTOS` key is read.
- Response contains no receipt, Frame, revision, index, credential, or
  operational data.

- [ ] **Step 2: Run focused tests and verify missing APIs**

Run:

```bash
bun test app/api/photo/handlers.test.ts app/event-store.test.ts
```

Expected: FAIL because exact public-photo lookup does not exist.

- [ ] **Step 3: Implement EventStore lookup, handler, and route**

Add:

```ts
export async function getPublicPhoto(
  request: NextRequest,
  deps: { store: EventStore }
): Promise<NextResponse>;
```

Canonicalize Event first. Require a complete owned image key. Return `400` for
malformed/cross-Event keys, `404` for an exact missing photo, and only
`{key,url,uploadedAt}` with `Cache-Control: no-store` on success. The route is
a thin Cloudflare adapter and owns no key logic.

- [ ] **Step 4: Write and implement the direct-photo Gallery shell**

Tests cover one decoded `photo` query value, loading/success/invalid/not-found/
offline states, manual retry, semantic image markup, and save/share fallback.

The shell:

- Fetches `/api/photo?event=…&key=…`.
- Shows only the exact photo.
- Provides a visible save/share action.
- Uses localized, focus-managed status and error UI.
- Does not poll or implement the Release 3 browse feed.

- [ ] **Step 5: Run focused and full checks**

Run:

```bash
bun test app/api/photo/handlers.test.ts app/event-store.test.ts \
  'app/[event]/gallery/handoff-gallery.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/event-store.ts app/event-store.test.ts app/api/photo \
  'app/[event]/gallery'
git commit -m "feat: open exact handoff photos safely"
```

### Task 5: Correlate the exact current guest acknowledgement and render local QR handoff

**Files:**
- Modify: `app/[event]/booth-session/session.ts`
- Modify: `app/[event]/booth-session/session.test.ts`
- Create: `app/[event]/booth-session/handoff.ts`
- Create: `app/[event]/booth-session/handoff.test.ts`
- Create: `app/[event]/handoff-panel.tsx`
- Create: `app/[event]/handoff-panel.test.tsx`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/booth.module.css`

**Interfaces:**
- Consumes: Release 0B upload result `{url,key?,duplicate?}` and Task 4 Gallery route.
- Produces: exact item/result acknowledgements and current-handoff correlation.

- [ ] **Step 1: Write failing Session acknowledgement tests**

Extend:

```ts
export type UploadAcknowledgement = {
  item: OutboxItem;
  result: UploadResult;
};

type OnAcknowledged = (acknowledgement: UploadAcknowledgement) => void;
```

Prove the callback receives the exact stored item and response and runs only
after upload acknowledgement plus successful removal of that exact Outbox row.

- [ ] **Step 2: Write failing pure handoff and QR tests**

Define:

```ts
export type CurrentHandoff =
  | { captureId: string; status: "waiting" }
  | {
      captureId: string;
      status: "ready";
      key: string;
      photoUrl: string;
      galleryUrl: string;
    };

export function beginHandoff(item: OutboxItem): CurrentHandoff;

export function applyAcknowledgement(
  current: CurrentHandoff | null,
  acknowledgement: UploadAcknowledgement,
  origin: string
): CurrentHandoff | null;

export function buildPhotoHandoffUrl(
  origin: string,
  event: string,
  completeKey: string
): string;
```

Test:

- Compare by exact Outbox `id`, never URL/time/queue position.
- Older delayed acknowledgement is ignored.
- Current duplicate acknowledgement succeeds.
- Missing/legacy `key` cannot create an exact QR.
- New acceptance replaces an old waiting/ready handoff.
- Dismissed handoff stays dismissed after late acknowledgement.
- The complete key is one percent-encoded query value.
- A stale async QR result cannot overwrite a newer handoff.
- QR data and visible anchor use the identical URL.

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```bash
bun test 'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-session/handoff.test.ts' \
  'app/[event]/handoff-panel.test.tsx'
```

Expected: FAIL because acknowledgement correlation does not exist.

- [ ] **Step 4: Implement Session and handoff state**

Call `onAcknowledged` only after the exact Outbox row is removed. In the page,
begin waiting handoff immediately after durable enqueue and before calling
`process()`. Generate:

```text
/{event}/gallery?photo={complete-object-key}
```

with `URLSearchParams`. Waiting/offline UI states that the photo is safely
queued and offers Continue; it never blocks retry or the next guest. Continue
returns to the fresh picker and late acknowledgement does not reopen handoff.

- [ ] **Step 5: Implement local QR presentation**

Use local `QRCode.toDataURL(galleryUrl)`. Cancel/ignore stale QR promises on
handoff change. Always show a visible text anchor to the same URL. Focus the
handoff heading and retain reduced-motion/forced-color behavior.

- [ ] **Step 6: Run focused and full checks**

Run:

```bash
bun test 'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-session/handoff.test.ts' \
  'app/[event]/handoff-panel.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'app/[event]/booth-session/session.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-session/handoff.ts' \
  'app/[event]/booth-session/handoff.test.ts' \
  'app/[event]/handoff-panel.tsx' \
  'app/[event]/handoff-panel.test.tsx' \
  'app/[event]/page.tsx' 'app/[event]/booth.module.css'
git commit -m "feat: hand off the exact current guest photo"
```

### Task 6: Add WebKit coverage, runbooks, and the Release 2 gate

**Files:**
- Create: `tests/guest-capture.spec.ts`
- Modify: `docs/runbooks/pre-event-readiness.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: Tasks 1–5 and Release 1 Playwright WebKit setup.
- Produces: repeatable mocked-camera coverage and exact real-device validation.

- [ ] **Step 1: Add a failing mocked-camera guest journey**

Intercept preflight, pause, camera, upload delays, exact-photo lookup, and QR
dependencies. Test:

- One-shot and multi-shot exact canvas review.
- Auto-accept at the configured timeout.
- More Time cancellation.
- Same-Frame Retake.
- Button/timer race creates one Outbox item and one identity.
- Encoding failure creates no row and recovers.
- Frame clears after durable acceptance.
- Offline acceptance shows queued handoff and permits the next guest.
- Older delayed acknowledgement cannot replace the current handoff.
- Current acknowledgement creates matching QR/link.
- Direct-photo navigation opens the exact object.
- Locale persistence, Arabic direction, and English fallback.
- Keyboard-only focus, reduced motion, forced colors, and no serious automated
  accessibility violations on changed screens.

- [ ] **Step 2: Run browser coverage and fix only deterministic failures**

Run:

```bash
bun run test:browser -- tests/guest-capture.spec.ts
```

Expected: PASS with no staging or production request.

- [ ] **Step 3: Update staging-first runbooks**

Add real-device checks for:

1. Every enabled Frame's real crop/composite at iPad camera resolution.
2. One-shot and multi-shot review.
3. Auto-accept, More Time, rapid Use Photo/Retake race, and encode recovery.
4. HEIC/file-camera fallback decode and review.
5. Pause during review and accepting.
6. Offline acceptance, next-guest continuation, reconnect, and no duplicates.
7. Two pending guests where the older upload acknowledges after the newer
   handoff starts.
8. QR scan with a second physical phone over the staging HTTPS hostname,
   verifying the exact complete key/photo.
9. VoiceOver focus order and concise announcements on iPad/iPhone.
10. Arabic RTL, `zh-SG`, English fallback, and Frame-label fallback.
11. Countdown audio after user activation plus an audio-unavailable fallback.
12. Installed landscape mode, Larger Text, Reduce Motion, and high contrast.

- [ ] **Step 4: Run the complete automated Release 2 gate**

Run:

```bash
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
bun run test:browser
```

Expected: every command exits 0.

- [ ] **Step 5: Perform required real-device staging validation**

Use a throwaway canonical staging Event distinct from production. A browser
simulator cannot certify camera permission/orientation, full-resolution canvas
memory, Safari HEIC decode, Web Audio activation/silent-mode behavior, QR
readability, VoiceOver timing, iOS suspension, IndexedDB eviction, or installed
mode. A second phone cannot follow a localhost QR, so use the staging HTTPS
hostname.

Do not perform prefix cleanup. Any test photo removal uses its one complete
Event-owned key.

- [ ] **Step 6: Commit**

```bash
git add tests/guest-capture.spec.ts docs/runbooks/pre-event-readiness.md \
  docs/runbooks/deployment.md
git commit -m "test: verify guest capture and handoff"
```

## Release 2 Completion Gate

Release 2 is complete only when:

- Every task review is clean.
- The complete automated gate passes.
- Real iPad Safari review/Retake/acceptance passes for every enabled Frame.
- A second physical phone opens the exact current guest photo from the QR.
- Delayed older acknowledgement cannot replace the current handoff.
- Offline accepted photos remain in the Outbox and the next guest can proceed.
- VoiceOver, RTL, reduced-motion, focus, and visible-link checks pass.
- No private record appears in `PHOTOS` or a public response.

