# Release 1 Task 4 report

## Outcome

Implemented Booth credential persistence, the pure Booth access state machine,
the operator unlock surface, and authenticated online preflight gating in the
Task 4 worktree.

- The Photo Outbox is constructed and `await`-recovered before stored
  credentials are read.
- Startup no longer uses `window.prompt` or public `/api/config`.
- A stored or newly entered Booth Key is sent only in the
  `x-booth-key` header of `POST /api/booth/preflight`.
- Enabled Frames, automatic Session retry, and camera startup are installed
  only after a successful authenticated preflight.
- Network/preflight parsing failures enter `recovery-only`; `409` and `503`
  enter `unavailable`.
- Preflight or upload `401` clears both Event credential stores, stops/invalidates
  camera work, stops Session retry, preserves the Outbox, and relocks.
- Camera capture and the native file fallback are both gated by `ready`.
- Task 5 pause/heartbeat and Task 7 installed/exit UI were not added.

## Strict TDD record

### RED 1 — new Task 4 modules

Command:

```bash
bun test 'app/[event]/booth-session/credential.test.ts' \
  'app/[event]/booth-session/access.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Observed: `0 pass`, `3 fail`, with the expected missing-module errors for
`credential`, `access`, and `booth-unlock`.

### GREEN 1 — persistence, reducer, and static unlock markup

After the minimal implementations, the focused suite reached `24 pass`,
`0 fail`. It covers:

- session-first load precedence;
- remembered and session-default moves;
- exact per-Event clearing without broad storage deletion;
- blocked-storage behavior that leaves the caller's active in-memory key intact;
- locked → checking → ready, recovery-only, unavailable, 401 relock, retry,
  and exited transitions;
- labeled password and remember controls;
- fixed status copy that cannot render the submitted secret.

### RED 2 — page integration and accessibility

The next test additions failed `4` integration/presentation checks against the
old page and CSS:

- no completed Outbox recovery before credential read;
- no authenticated successful-preflight start branch;
- no 44px/forced-colors focus contract;
- no reduced-motion override.

### GREEN 2 — authenticated preflight gate

After page and CSS integration, the focused suite reached `28 pass`, `0 fail`.
The ordering regression checks require the source to complete
`await session.recover()` before `loadBoothCredential()`, and require both
`session.start()` and `startCamera()` to live in the `response.ok` branch.

### RED/GREEN 3 — late camera result after relock

Lifecycle review found that `getUserMedia()` cannot be aborted. A new regression
failed until the page used a camera request generation. Relock, Event teardown,
and unmount now invalidate pending camera work; a late stream has all tracks
stopped and is never attached after access is lost.

The Session auth callback is also fenced to its owning Session so a stale
Session cannot relock or stop a newer Event Session.

## Design plan and self-critique

Subject: a real event operator unlocking a dedicated iPad Booth under pressure.
Single job: reach a trustworthy camera-ready state without risking queued
photos.

Tokens reuse the existing Booth language:

- Booth black `#07070c`
- raised ink `#111119`
- signal pink `#ff2d8b`
- safe mint `#70e0bb`
- muted lavender-gray `#b9b8c6`
- white `#ffffff`

Typography keeps the existing system stack, using a restrained rounded display
role for the state title and monospace only for operational labels. The
signature element is the three-part readiness rail: Photo Outbox, Booth access,
Camera. It encodes actual startup order rather than acting as decoration.

Self-critique:

- Kept the panel to one primary action and plain verbs: “Unlock Booth” and
  “Try again.”
- Removed decorative pressure: solid surfaces only, no generic gradient, and
  no competing illustration.
- Pending-photo safety is visible before authentication and does not expose raw
  server errors or secrets.
- Controls provide at least 44px hit areas; focus stays visible in forced-color
  mode; the one short panel entrance is removed under reduced motion.
- The rail stacks on narrow screens and the panel respects safe-area insets.
- An in-app browser backend was not attached to this Codex session, so no
  screenshot is claimed as evidence. A real iPad camera/permission pass remains
  required by repository policy.

## Final verification

After reinstalling the documented iCloud-evicted dependency tree with
`bun install`:

```text
focused Task 4 tests: 28 pass, 0 fail, 64 expectations
bun run typecheck: exit 0
bun run typecheck:tests: exit 0
full bun test: 290 pass, 0 fail, 936 expectations across 25 files
bun run build: exit 0; /[event] production route compiled
git diff --check: clean
```

One pre-reinstall final build failed because the local `next` package was
missing its own internal files. The repository runbook explicitly identifies
iCloud-evicted `node_modules`; `bun install` restored 370 packages, changed no
tracked dependency files, and the fresh production build then passed.

## Remaining concerns

- Browser simulation is not evidence for a real iPad camera. Validate the
  unlocked → permission → picker path, rotation, password-manager behavior, and
  file fallback on the event iPad over HTTPS/localhost.
- Task 5 will own pause/heartbeat behavior and Task 7 will own installed mode
  and operator exit integration; the pure `exited` transition is present now
  without prematurely adding either feature.

## Review follow-up — async lifecycle ownership

### RED

Added behavioral tests for the review findings before implementation:

```bash
bun test 'app/[event]/booth-session/lifecycle.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Observed: `0 pass`, `2 fail`, with the expected missing
`booth-session/lifecycle` module and missing unlock-form reducer export.

The new tests drive deferred Session recovery and stop promises, out-of-order
preflight responses, StrictMode-style cleanup, Event switches, stale uploaded
callbacks, 401 relock/re-unlock/automatic acknowledgement, current Frame
validation, fixed non-secret announcements, and typed-key Event reset.

### GREEN

Minimal coordinator behavior first:

```bash
bun test 'app/[event]/booth-session/lifecycle.test.ts'
```

Observed: `14 pass`, `0 fail`, `45` expectations.

After page integration and capture/file fencing:

```bash
bun test 'app/[event]/booth-session/credential.test.ts' \
  'app/[event]/booth-session/access.test.ts' \
  'app/[event]/booth-session/lifecycle.test.ts' \
  'app/[event]/booth-unlock.test.tsx' \
  'app/[event]/booth-session/session.test.ts'
```

Observed: `78 pass`, `0 fail`, `200` expectations.

Source-text checks are no longer the primary lifecycle evidence. The remaining
small page-source assertion checks only safety wiring: authenticated preflight,
no prompt/public-config startup, and Event-keyed unlock remounting.

### Review fixes

- `BoothLifecycleCoordinator` owns the active Event, Session, preflight
  generation, abort controller, auth-blocked flag, and one retained stop
  promise per Session.
- Upload `401` clears credentials and relocks immediately, but a successful
  new preflight awaits the exact owning stop promise before `start()` and an
  automatic `retry()` of the auth-blocked oldest item.
- Stale preflight results, deferred old recovery, old Session uploads, state
  subscriptions, capture tails, and file-decode tails cannot mutate the new
  Event.
- A successful response is filtered through the current Frame catalog using
  `availableTemplates`; malformed, empty, or unknown-only Frames never enter
  `ready`, start Session work, or start the camera.
- Event reset now clears status, mode, last URL, errors, countdown, shot,
  flash, capture/camera work, enabled Frames, access feedback, and current
  credential. `BoothUnlock` is Event-keyed and its tested form reducer also
  clears key/remember state on Event identity changes.
- Checking, network failure, Event unavailable, and rejected-key states have
  fixed non-secret live-region copy. Rejected credentials use an assertive
  alert without echoing the key.

### Fresh review verification

```text
focused review suite: 78 pass, 0 fail, 200 expectations
bun run typecheck: exit 0
bun run typecheck:tests: exit 0
full bun test: 308 pass, 0 fail, 980 expectations across 26 files
bun run build: exit 0; /[event] production route compiled
git diff --check: clean
```

## Second review follow-up — credential and auth retry identity

### RED

The repository shell did not have Bun on `PATH`, so the first literal command
confirmed the environment issue:

```bash
bun test 'app/[event]/booth-session/lifecycle.test.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Observed: exit `127`, `zsh:1: command not found: bun`.

The same focused RED suite was then run with the installed Bun executable:

```bash
/Users/limboenedmund/.bun/bin/bun test \
  'app/[event]/booth-session/lifecycle.test.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Observed: exit `1`, `50 pass`, `14 fail`, `134` expectations. The failures
showed the missing per-Session credential holder, missing exact-ID auth resume,
reused stop promise, missing auth callback ID, and unsafe memory-outbox copy.

### GREEN

After the fixes, the focused lifecycle, Session, and unlock suite:

```bash
/Users/limboenedmund/.bun/bin/bun test \
  'app/[event]/booth-session/lifecycle.test.ts' \
  'app/[event]/booth-session/session.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Observed: exit `0`, `64 pass`, `0 fail`, `200` expectations.

Application and test type checks:

```bash
/Users/limboenedmund/.bun/bin/bun run typecheck && \
  /Users/limboenedmund/.bun/bin/bun run typecheck:tests
```

Observed: exit `0`; both TypeScript checks passed.

Full test and production build:

```bash
/Users/limboenedmund/.bun/bin/bun test && \
  /Users/limboenedmund/.bun/bin/bun run build
```

Observed: exit `0`; `313 pass`, `0 fail`, `1009` expectations across `26`
test files, followed by a successful Next.js production build including the
dynamic `/[event]` route.

### Second review fixes

- Every Booth Session upload closure now owns a distinct mutable credential
  holder. Only the current successful preflight populates it; Event switch,
  cleanup, and relock blank the old holder before deferred work can continue.
- Auth-required callbacks expose only the exact persisted outbox item ID.
  `resumeAuth(id)` may clear failure state only while holding the Event lease
  and only when that exact ID is still the auth-failed oldest row. Manual
  `retry()` remains a separate operator override.
- A completed stop promise is cleared only for its exact epoch after the same
  active Session restarts, so consecutive 401 recovery cycles each stop before
  resuming.
- Memory-only outbox copy says photos are waiting in the open page and that
  reload recovery is unavailable; it never describes those photos as safe.
