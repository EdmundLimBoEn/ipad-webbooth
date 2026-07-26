# Release 1 Reliable Booth Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Booth safely operable through unreliable connectivity, authenticated startup, remote pause/resume, private device monitoring, and installed iPad mode.

**Architecture:** The Booth Session remains the owner of durable ordered retry and storage acknowledgment. `EventStore` remains the only owner of private Booth heartbeat and operational-state keys, while HTTP handlers authenticate, canonicalize, validate, and delegate. The Booth recovers the Photo Outbox before authentication but starts no camera and accepts no new capture until online preflight succeeds.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers, R2, IndexedDB, Web App Manifest, Screen Wake Lock API, Playwright WebKit.

## Global Constraints

- Start only after Release 0B stable Outbox identity, idempotent upload, and shared `boothOrAdminOk()` are complete.
- Use Bun commands only.
- `EventStore` remains the sole owner of `PHOTOS` and `STATE` keys.
- Heartbeats and operational pause state live only in private `STATE`.
- Never store credentials, hashes, thumbnails, arbitrary exception text, URLs, headers, user agents, or guest identifiers in a heartbeat.
- Outbox items leave storage only after upload acknowledgment.
- Automatic retry preserves oldest-first ordering and never skips a blocked first item.
- Pause blocks new captures but never blocks Photo Outbox draining.
- A fresh capture requires successful online preflight.
- Existing Outbox rows and IndexedDB data remain readable; migrations are additive only.
- Event HTTP parameters use `canonicalEvent()` and reject aliases.
- Never silently slug an Event at an HTTP boundary.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never deploy the unnamed Wrangler environment to an Event domain.

---

## File Structure

- Create `app/[event]/booth-session/retry-policy.ts` — upload failure classification and retry timing.
- Create `app/[event]/booth-session/retry-policy.test.ts` — status, backoff, and `Retry-After` contracts.
- Modify `app/[event]/booth-session/outbox.ts` — additive failure fields and atomic Event leases.
- Modify `app/[event]/booth-session/session.ts` — automatic scheduling, lease ownership, and auth-required state.
- Modify `app/[event]/booth-session/session.test.ts` — reload, ordering, reconnect, and lease coverage.
- Create `app/booth-control.ts` — bounded private Booth schemas and safe public projections.
- Create `app/booth-control.test.ts` — schema and projection tests.
- Modify `app/event-store.ts` — private Booth records and paging.
- Modify `app/event-store.test.ts` — private storage, stale derivation, and Event isolation.
- Modify `app/event-config.ts` — explicit safe `EventExperience` projection.
- Modify `app/event-config.test.ts` — preflight projection redaction.
- Create `app/api/booth/handlers.ts` — dependency-injected Booth control handlers.
- Create `app/api/booth/handlers.test.ts` — auth, redaction, validation, and paging.
- Create `app/api/booth/preflight/route.ts` — preflight route adapter.
- Create `app/api/booths/route.ts` — heartbeat write and Admin list adapter.
- Create `app/api/booth-state/route.ts` — public read and Admin pause adapter.
- Create `app/[event]/booth-session/credential.ts` — session/local Booth credential persistence.
- Create `app/[event]/booth-session/credential.test.ts` — persistence and clearing tests.
- Create `app/[event]/booth-session/access.ts` — pure Booth access state transitions.
- Create `app/[event]/booth-session/access.test.ts` — lock, checking, recovery, and unavailable transitions.
- Create `app/[event]/booth-unlock.tsx` — accessible unlock form.
- Create `app/[event]/booth-unlock.test.tsx` — unlock markup and secret-redaction tests.
- Create `app/[event]/booth-session/operational-client.ts` — pause polling and heartbeat reporting.
- Create `app/[event]/booth-session/operational-client.test.ts` — no-overlap and failure tests.
- Create `app/[event]/booth-session/device-identity.ts` — credential-independent local device UUID.
- Create `app/[event]/booth-session/device-identity.test.ts` — stable ID and fallback tests.
- Modify `app/[event]/page.tsx` — unlock, preflight, retry triggers, pause, heartbeat, wake, and exit integration.
- Modify `app/[event]/booth.module.css` — Booth control surfaces and status states.
- Create `app/[event]/admin/booth-operations.ts` — pure Admin Booth paging/merge helpers.
- Create `app/[event]/admin/booth-operations.test.ts` — paging and merge behavior.
- Create `app/[event]/admin/booth-operations-panel.tsx` — pause controls and private device status.
- Create `app/[event]/admin/booth-operations-panel.test.tsx` — Admin rendering and busy-state tests.
- Modify `app/[event]/admin/page.tsx` — authenticated operational polling and mutations.
- Modify `app/[event]/admin/admin.module.css` — operations panel styling.
- Create `app/[event]/manifest.ts` — public per-Event installed Booth manifest.
- Create `app/[event]/manifest.test.ts` — canonical installed-mode contract.
- Create `public/booth-icon.svg` — credential-free Booth icon.
- Create `app/[event]/booth-session/installed-mode.ts` — standalone detection, wake lock, and navigation rules.
- Create `app/[event]/booth-session/installed-mode.test.ts` — installed behavior tests.
- Create `app/[event]/operator-controls.tsx` — authenticated operator exit.
- Create `app/[event]/operator-controls.test.tsx` — exit validation and queue-preservation markup.
- Modify `app/layout.tsx` — iOS installed-mode metadata.
- Modify `package.json` and `bun.lock` — WebKit browser test command/dependency.
- Create `playwright.config.ts` — local WebKit test server.
- Create `tests/booth-control.spec.ts` — mocked-camera Booth control journey.
- Modify `.github/workflows/verify.yml` — browser verification.
- Modify `docs/runbooks/pre-event-readiness.md` — Release 1 real-iPad checks.
- Modify `docs/runbooks/deployment.md` — Release 1 staging smoke gate.

### Task 1: Add automatic retry and an atomic cross-tab Event lease

**Files:**
- Create: `app/[event]/booth-session/retry-policy.ts`
- Create: `app/[event]/booth-session/retry-policy.test.ts`
- Modify: `app/[event]/booth-session/outbox.ts`
- Modify: `app/[event]/booth-session/session.ts`
- Modify: `app/[event]/booth-session/session.test.ts`
- Modify: `app/[event]/page.tsx`

**Interfaces:**
- Consumes: Release 0B `OutboxItem`, stable upload identity, and idempotent upload response.
- Produces: `HttpUploadError`, `UploadErrorClass`, `RetryDisposition`, and `classifyUploadFailure()`.
- Produces: `OutboxStore.acquireLease()`, `renewLease()`, and `releaseLease()`.
- Produces: automatic `BoothSession.start()`, `stop()`, `reconsider()`, and retained manual `retry()`.

- [ ] **Step 1: Write failing retry-policy tests**

```ts
import { describe, expect, test } from "bun:test";
import { HttpUploadError, classifyUploadFailure } from "./retry-policy";

describe("upload retry policy", () => {
  test("retries network, 408, 425, 429, and 5xx failures", () => {
    for (const status of [408, 425, 429, 500, 503]) {
      expect(classifyUploadFailure(
        new HttpUploadError(status, null, status >= 500 ? "server" : "timeout"),
        1,
        1_000,
        () => 0.5
      ).kind).toBe("retryable");
    }
    expect(classifyUploadFailure(new TypeError("fetch failed"), 1, 1_000, () => 0.5).kind)
      .toBe("retryable");
  });

  test("401 requires auth and permanent statuses do not loop", () => {
    expect(classifyUploadFailure(new HttpUploadError(401, null, "auth"), 1, 0, () => 0.5))
      .toEqual({ kind: "auth-required", errorClass: "auth" });
    for (const status of [400, 403, 413, 415]) {
      expect(classifyUploadFailure(new HttpUploadError(status, null, "payload"), 1, 0, () => 0.5).kind)
        .toBe("permanent");
    }
  });
});
```

Add cases for delta-seconds and HTTP-date `Retry-After`, deterministic jitter,
exponential growth, and the 30-second cap.

- [ ] **Step 2: Run the retry-policy test and verify missing-module failure**

Run: `bun test 'app/[event]/booth-session/retry-policy.test.ts'`

Expected: FAIL because `retry-policy.ts` does not exist.

- [ ] **Step 3: Implement strict failure classification**

```ts
export type UploadErrorClass =
  | "network" | "timeout" | "auth" | "payload" | "server" | "unknown";

export class HttpUploadError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    readonly errorClass: UploadErrorClass
  ) {
    super(`upload failed with status ${status}`);
  }
}

export type RetryDisposition =
  | { kind: "retryable"; delayMs: number; errorClass: UploadErrorClass }
  | { kind: "auth-required"; errorClass: "auth" }
  | { kind: "permanent"; errorClass: UploadErrorClass };
```

`classifyUploadFailure(error, attempt, now, random)` retries thrown network
errors and HTTP `408`, `425`, `429`, and `5xx`; returns `auth-required` for
`401`; and returns `permanent` for `400`, `403`, `413`, and `415`. Backoff is
`min(30_000, 1_000 * 2 ** (attempt - 1) * (0.5 + random()))`. A valid
`Retry-After` delta or date chooses the later delay before the same 30-second
cap.

- [ ] **Step 4: Write failing Session reload, ordering, and lease tests**

Add tests proving:

- `nextAttemptAt`, `failureKind`, and `errorClass` survive reload.
- The oldest failed item blocks every later item.
- Reconnect and foreground immediately reconsider the oldest retryable item.
- A permanent or auth failure does not automatically restart.
- Manual retry can reconsider the first blocked item.
- Concurrent `process()` calls coalesce.
- Two sessions for one Event cannot drain simultaneously.
- An expired lease can be acquired by a second owner.
- Different Events have independent leases.

- [ ] **Step 5: Implement additive Outbox failure state and leases**

Extend `OutboxItem`:

```ts
nextAttemptAt?: number;
failureKind?: "retryable" | "permanent" | "auth";
errorClass?: UploadErrorClass;
```

Extend `OutboxStore`:

```ts
acquireLease(event: string, ownerId: string, now: number, ttlMs: number): Promise<boolean>;
renewLease(event: string, ownerId: string, now: number, ttlMs: number): Promise<boolean>;
releaseLease(event: string, ownerId: string): Promise<void>;
```

Bump IndexedDB to version `2` and add only `photo-outbox-leases`. Implement
lease acquisition as one read/write transaction that replaces only a missing,
expired, or same-owner record. Never delete or rewrite `photo-outbox`.

- [ ] **Step 6: Implement automatic Session scheduling**

Add `start()`, `stop()`, `reconsider("connectivity" | "foreground")`, and keep
manual `retry()`. Acquire the Event lease before drain, renew it during drain,
release it on stop, persist retry eligibility before publishing state, and
schedule one timer for the first retryable item. A `401` invokes
`onAuthRequired` without removing the item. Keep `processing` coalescing.

In the Booth page, convert non-OK upload responses to `HttpUploadError`, call
`session.start()` after valid preflight, call `reconsider("connectivity")` on
`online`, call `reconsider("foreground")` when the document becomes visible,
and call `stop()` on unmount.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
bun test 'app/[event]/booth-session/retry-policy.test.ts' 'app/[event]/booth-session/session.test.ts'
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'app/[event]/booth-session' 'app/[event]/page.tsx'
git commit -m "feat: retry queued photos automatically"
```

### Task 2: Add bounded private Booth operational records

**Files:**
- Create: `app/booth-control.ts`
- Create: `app/booth-control.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Produces: heartbeat and pause schemas shared by Event Store, handlers, and clients.
- Produces: exact private keys and Event Store read/write/list methods.
- Consumed by: Tasks 3, 5, and 6.

- [ ] **Step 1: Write failing schema and privacy tests**

```ts
expect(parseBoothHeartbeat({
  version: 1,
  deviceId: "018f0000-0000-4000-8000-000000000001",
  sessionStartedAt: 1753315200000,
  pendingCount: 2,
  durableStorage: true,
  online: true,
  installed: true,
  camera: "ready",
  upload: "retry-wait",
  buildId: "release_1",
})).not.toBeNull();

expect(parseBoothHeartbeat({
  version: 1,
  deviceId: "018f0000-0000-4000-8000-000000000001",
  sessionStartedAt: 1753315200000,
  pendingCount: 0,
  durableStorage: true,
  online: true,
  installed: false,
  camera: "ready",
  upload: "idle",
  buildId: "release_1",
  error: "credential=x",
})).toBeNull();
```

Add Event Store tests for server-controlled timestamps, paging, stale
derivation, exact device overwrite, cross-Event isolation, malformed/future
stored versions, pause defaults, localized messages, and zero writes to
`PHOTOS`.

- [ ] **Step 2: Run tests and verify missing exports**

Run: `bun test app/booth-control.test.ts app/event-store.test.ts`

Expected: FAIL because Booth control schemas and Event Store methods do not exist.

- [ ] **Step 3: Implement bounded shared schemas**

```ts
export const BOOTH_HEARTBEAT_INTERVAL_MS = 15_000;
export const BOOTH_STALE_AFTER_MS = 45_000;

export type BoothCameraState =
  | "stopped" | "starting" | "ready" | "denied" | "unavailable";
export type BoothUploadState =
  | "idle" | "uploading" | "retry-wait" | "blocked" | "auth-required";
export type BoothErrorClass =
  | "network" | "timeout" | "auth" | "payload" | "camera-permission"
  | "camera-unavailable" | "storage" | "server" | "unknown";

export type BoothHeartbeatInput = {
  version: 1;
  deviceId: string;
  sessionStartedAt: number;
  pendingCount: number;
  durableStorage: boolean;
  online: boolean;
  installed: boolean;
  camera: BoothCameraState;
  upload: BoothUploadState;
  lastSuccessfulUploadAt?: number;
  errorClass?: BoothErrorClass;
  buildId: string;
};

export type BoothHeartbeatRecord = BoothHeartbeatInput & { lastSeenAt: string };
export type AdminBoothRecord = BoothHeartbeatRecord & { stale: boolean };
export type BoothOperationalState = {
  version: 1;
  paused: boolean;
  messages?: Record<string, string>;
  updatedAt: string;
};
```

Require lowercase UUID-v4, integer millisecond fields, `pendingCount` from
`0..10_000`, exact enums, a 1–128 character token build ID, at most 20 locale
messages, token locale keys, and messages of at most 280 characters. Reject
unknown keys and unsupported versions.

- [ ] **Step 4: Implement exact private keys and Event Store methods**

```ts
export const boothHeartbeatKey = (event: string, deviceId: string) =>
  `events/${event}/booths/${deviceId}.json`;
export const boothHeartbeatPrefix = (event: string) =>
  `events/${event}/booths/`;
export const boothOperationalStateKey = (event: string) =>
  `events/${event}/booth-state.json`;
```

Add:

```ts
writeBoothHeartbeat(event, input): Promise<BoothHeartbeatRecord>;
listBoothHeartbeats(event, options): Promise<{
  booths: AdminBoothRecord[];
  cursor: string | null;
}>;
readBoothOperationalState(event): Promise<BoothOperationalState>;
writeBoothOperationalState(
  event,
  input: { paused: boolean; messages?: Record<string, string> }
): Promise<BoothOperationalState>;
```

Use `STATE` only. Server time controls `lastSeenAt` and `updatedAt`. Listing
accepts an opaque cursor and a `1..100` limit, default `50`, and derives
`stale` at 45 seconds. Missing operational state returns an unpaused version-1
default without forcing a write.

- [ ] **Step 5: Run tests and type-check**

Run:

```bash
bun test app/booth-control.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/booth-control.ts app/booth-control.test.ts app/event-store.ts app/event-store.test.ts
git commit -m "feat: store private booth operations"
```

### Task 3: Expose authenticated Booth control HTTP contracts

**Files:**
- Modify: `app/event-config.ts`
- Modify: `app/event-config.test.ts`
- Create: `app/api/booth/handlers.ts`
- Create: `app/api/booth/handlers.test.ts`
- Create: `app/api/booth/preflight/route.ts`
- Create: `app/api/booths/route.ts`
- Create: `app/api/booth-state/route.ts`

**Interfaces:**
- Consumes: Task 2 Event Store methods and Release 0B `boothOrAdminOk()`.
- Produces: safe preflight, heartbeat, device-list, and operational-state handlers.
- Consumed by: Tasks 4–6.

- [ ] **Step 1: Write failing projection and handler tests**

Add a projection test proving this input:

```ts
{
  frames: ["square"],
  boothKeyHash: "salt:hash",
  currentRevisionId: "018f0000-0000-4000-8000-000000000001",
}
```

projects to `{frames:["square"]}` without either private field.

Add handler tests proving:

- Preflight accepts the matching Booth key or Admin key.
- Missing Admin secret fails closed with `503`.
- Wrong key returns `401`.
- Missing config or zero Frames returns `409`.
- Preflight response contains only safe experience, operational state, and server time.
- Heartbeat rejects unknown/unbounded fields before any write.
- Booth key cannot write another Event's heartbeat.
- Device list and pause mutation are Admin-only.
- Public pause read contains no private device/config data.
- Canonical aliases return `400`.

- [ ] **Step 2: Run tests and verify missing handlers**

Run: `bun test app/event-config.test.ts app/api/booth/handlers.test.ts`

Expected: FAIL because the safe projector and handlers do not exist.

- [ ] **Step 3: Implement the explicit safe experience projector**

```ts
export function projectEventExperience(config: EventConfig): EventExperience {
  return {
    frames: [...config.frames],
    ...(config.locales ? { locales: [...config.locales] } : {}),
    ...(config.defaultLocale ? { defaultLocale: config.defaultLocale } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(config.capture ? { capture: { ...config.capture } } : {}),
    ...(config.gallery ? { gallery: { ...config.gallery } } : {}),
  };
}
```

Do not serialize `EventConfig` directly.

- [ ] **Step 4: Implement dependency-injected handlers**

```ts
export type BoothControlHandlerDeps = {
  store: EventStore;
  adminKey?: string;
};
```

Implement:

- `postBoothPreflight(req, deps)` returning
  `{experience, operationalState, serverTime}`.
- `postBoothHeartbeat(req, deps)` returning the sanitized stored record.
- `getBoothHeartbeats(req, deps)` returning `{booths, cursor}`.
- `getBoothState(req, deps)` returning the safe public state with
  `Cache-Control: no-store`.
- `putBoothState(req, deps)` accepting only `{paused, messages?}`.

All handlers canonicalize Event input. Preflight and heartbeat use the same
`boothOrAdminOk()` rules as upload. Device listing and mutation use Admin auth.

- [ ] **Step 5: Add thin route adapters**

Each `route.ts` obtains `getCloudflareContext()`, constructs
`EventStore.fromEnv(env)`, supplies `env.BOOTH_UPLOAD_KEY`, and delegates.
Route modules own no key construction or storage logic.

- [ ] **Step 6: Run route tests and type-check**

Run:

```bash
bun test app/event-config.test.ts app/api/booth/handlers.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/event-config.ts app/event-config.test.ts app/api/booth app/api/booths app/api/booth-state
git commit -m "feat: expose booth control APIs"
```

### Task 4: Replace prompt startup with unlock and online preflight

**Files:**
- Create: `app/[event]/booth-session/credential.ts`
- Create: `app/[event]/booth-session/credential.test.ts`
- Create: `app/[event]/booth-session/access.ts`
- Create: `app/[event]/booth-session/access.test.ts`
- Create: `app/[event]/booth-unlock.tsx`
- Create: `app/[event]/booth-unlock.test.tsx`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/booth.module.css`

**Interfaces:**
- Consumes: Task 3 preflight response and Task 1 Session auth-required callback.
- Produces: credential persistence and a tested Booth access state machine.
- Consumed by: Tasks 5 and 7.

- [ ] **Step 1: Write failing persistence and access-state tests**

```ts
expect(loadBoothCredential("launch", session, local)).toEqual({
  key: "session-key",
  persistence: "session",
});

saveBoothCredential("launch", "remembered-key", true, session, local);
expect(session.getItem("webbooth:launch:booth-key")).toBeNull();
expect(local.getItem("webbooth:launch:booth-key")).toBe("remembered-key");

clearBoothCredential("launch", session, local);
expect(session.length).toBe(0);
expect(local.length).toBe(0);
```

Add pure transition tests for:

```text
locked → checking → ready
                 ↘ recovery-only
                 ↘ unavailable
401 → locked
operator exit → exited
```

Add static markup tests proving the unlock form exposes a password input and
“Remember on this iPad” checkbox without rendering a supplied secret.

- [ ] **Step 2: Run tests and verify missing modules**

Run:

```bash
bun test 'app/[event]/booth-session/credential.test.ts' \
  'app/[event]/booth-session/access.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement credential persistence**

```ts
export type StoredCredential = {
  key: string;
  persistence: "session" | "local";
};

export function loadBoothCredential(event, session, local): StoredCredential | null;
export function saveBoothCredential(event, key, remember, session, local): void;
export function clearBoothCredential(event, session, local): void;
```

Default saves use `sessionStorage`. The explicit remember option moves the key
to `localStorage`. Clearing removes both. Storage failures retain an in-memory
key for the current page without claiming persistence.

- [ ] **Step 4: Implement access state and unlock form**

```ts
export type BoothAccessState =
  | "locked" | "checking" | "ready" | "recovery-only"
  | "unavailable" | "exited";
```

The unlock form uses labeled controls, an error/status region, and a retry
preflight action. It accepts callbacks and never owns Outbox or camera state.

- [ ] **Step 5: Integrate preflight before camera**

In `page.tsx`:

1. Construct and recover the Photo Outbox before reading credentials.
2. Remove `window.prompt` and the public `/api/config` startup fetch.
3. Load a stored credential and attempt preflight.
4. Install enabled Frames only from a successful preflight.
5. Start Session retry and camera only after success.
6. Enter `recovery-only` on network failure while retaining pending state.
7. Enter `unavailable` on `409` or `503`.
8. Clear both credential stores, keep Outbox, and relock on preflight/upload `401`.
9. Disable camera and file fallback outside `ready`.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
bun test 'app/[event]/booth-session/credential.test.ts' \
  'app/[event]/booth-session/access.test.ts' \
  'app/[event]/booth-unlock.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'app/[event]/booth-session' 'app/[event]/booth-unlock.tsx' \
  'app/[event]/booth-unlock.test.tsx' 'app/[event]/page.tsx' \
  'app/[event]/booth.module.css'
git commit -m "feat: unlock booths with authenticated preflight"
```

### Task 5: Poll pause state and report private Booth heartbeat

**Files:**
- Create: `app/[event]/booth-session/operational-client.ts`
- Create: `app/[event]/booth-session/operational-client.test.ts`
- Create: `app/[event]/booth-session/device-identity.ts`
- Create: `app/[event]/booth-session/device-identity.test.ts`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/booth.module.css`

**Interfaces:**
- Consumes: Task 2 types, Task 3 routes, Task 4 credential/access state, and Task 1 upload state.
- Produces: non-overlapping pause polling, bounded heartbeat reporting, and stable device identity.

- [ ] **Step 1: Write failing device and client-controller tests**

Test that `loadOrCreateDeviceId()` returns the stored lowercase UUID-v4,
creates one when missing, and falls back to a session-only ID if local storage
throws. Clearing Booth credentials must not clear the device ID.

Using injected fetch, clock, and timer fakes, test:

- Immediate poll plus completion-driven 5-second scheduling.
- No overlapping state requests.
- Poll failure retains the last-known pause value and reports disconnected.
- Heartbeat sends immediately, every 15 seconds, and after a coalesced state change.
- Heartbeat failure never rejects the caller or blocks Session work.
- Heartbeat `401` invokes the auth-required callback.
- `stop()` aborts requests and timers.

- [ ] **Step 2: Run tests and verify missing modules**

Run:

```bash
bun test 'app/[event]/booth-session/device-identity.test.ts' \
  'app/[event]/booth-session/operational-client.test.ts'
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement device identity and controllers**

```ts
export function loadOrCreateDeviceId(
  storage: Pick<Storage, "getItem" | "setItem">,
  makeId: () => string = () => crypto.randomUUID()
): string;

export class BoothStatePoller {
  start(): void;
  refresh(): Promise<void>;
  stop(): void;
}

export class BoothHeartbeatReporter {
  start(): void;
  update(snapshot: BoothHeartbeatInput): void;
  flush(): Promise<void>;
  stop(): void;
}
```

Use `setTimeout` only after a request settles. Heartbeat payload construction
must explicitly enumerate every allowed field and use only bounded error
classes.

- [ ] **Step 4: Integrate pause semantics**

In the Booth page:

- At picker or Frame-ready, pause clears the Frame, blocks capture/file input,
  and stops all camera tracks.
- During active capture or durable handoff, pause allows the operation to
  finish, returns to the fresh picker, then stops the camera.
- Resume restarts the camera after the server is observed unpaused.
- Poll failure retains last-known state and shows a connectivity indicator.
- Session retry continues regardless of pause.

- [ ] **Step 5: Integrate heartbeat snapshots**

Generate one device ID independent of credentials. Send session start,
pending count, durable-storage flag, online/installed status, bounded camera
and upload states, last successful upload time, sanitized error class, and
`process.env.NEXT_PUBLIC_BUILD_ID ?? "development"`. Never send arbitrary
exception messages. Start after preflight; stop on unmount or exit.

- [ ] **Step 6: Run tests and build**

Run:

```bash
bun test 'app/[event]/booth-session/device-identity.test.ts' \
  'app/[event]/booth-session/operational-client.test.ts' \
  'app/[event]/booth-session/session.test.ts'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'app/[event]/booth-session' 'app/[event]/page.tsx' 'app/[event]/booth.module.css'
git commit -m "feat: pause and monitor booth sessions"
```

### Task 6: Add Admin pause controls and paged device status

**Files:**
- Create: `app/[event]/admin/booth-operations.ts`
- Create: `app/[event]/admin/booth-operations.test.ts`
- Create: `app/[event]/admin/booth-operations-panel.tsx`
- Create: `app/[event]/admin/booth-operations-panel.test.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/admin.module.css`

**Interfaces:**
- Consumes: Task 3 Admin APIs and Task 2 safe Admin records.
- Produces: pure page merging and an authenticated operational panel.

- [ ] **Step 1: Write failing paging and static rendering tests**

```ts
expect(mergeBoothPages(
  [{ deviceId: "a", lastSeenAt: "2026-07-24T00:00:00Z" }],
  [{ deviceId: "a", lastSeenAt: "2026-07-24T00:01:00Z" },
   { deviceId: "b", lastSeenAt: "2026-07-24T00:00:30Z" }]
).map((record) => record.deviceId)).toEqual(["a", "b"]);
```

Render the panel to static markup and verify live/stale status, pending count,
durable/degraded storage, installed mode, camera/upload state, build ID,
pause/resume busy state, and absence of `boothKey`, hashes, and raw error text.

- [ ] **Step 2: Run tests and verify missing components**

Run:

```bash
bun test 'app/[event]/admin/booth-operations.test.ts' \
  'app/[event]/admin/booth-operations-panel.test.tsx'
```

Expected: FAIL because the helpers and panel do not exist.

- [ ] **Step 3: Implement pure paging and the operations panel**

`mergeBoothPages()` deduplicates by device ID and retains the newest
`lastSeenAt`. The panel accepts records, cursor, operational state, loading
and mutation flags, an English message draft, and callbacks for refresh, load
more, pause, and resume.

Rows show abbreviated device ID, live/stale, last seen, session start, pending
count, durable state, online, installed, camera, upload, last upload, bounded
error class, and build ID.

- [ ] **Step 4: Integrate authenticated Admin polling**

After Admin authentication:

- Fetch operational state and the first device page.
- Refresh the first page every 15 seconds with a no-overlap guard.
- Merge first-page refreshes with already loaded later pages.
- Use the opaque cursor for “Load more”.
- Preserve non-English messages when editing the default English message.
- Disable pause/resume while `PUT /api/booth-state` is active.
- Route `401` through the existing Admin invalidation.
- Keep config, photos, moderation, and export usable when device polling fails.

- [ ] **Step 5: Run Admin and full tests**

Run:

```bash
bun test 'app/[event]/admin/booth-operations.test.ts' \
  'app/[event]/admin/booth-operations-panel.test.tsx' \
  'app/[event]/admin/admin-config-controls.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'app/[event]/admin'
git commit -m "feat: control and inspect event booths"
```

### Task 7: Add installed Booth mode, wake behavior, and authenticated exit

**Files:**
- Create: `app/[event]/manifest.ts`
- Create: `app/[event]/manifest.test.ts`
- Create: `public/booth-icon.svg`
- Create: `app/[event]/booth-session/installed-mode.ts`
- Create: `app/[event]/booth-session/installed-mode.test.ts`
- Create: `app/[event]/operator-controls.tsx`
- Create: `app/[event]/operator-controls.test.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/[event]/page.tsx`
- Modify: `app/[event]/booth.module.css`

**Interfaces:**
- Consumes: Task 4 preflight/credential flow and Task 5 client controllers.
- Produces: public per-Event manifest, standalone detection, wake management, navigation predicate, and verified operator exit.

- [ ] **Step 1: Write failing manifest and installed-mode tests**

Test that the `launch-night` manifest has:

```ts
{
  id: "/launch-night",
  start_url: "/launch-night",
  scope: "/launch-night",
  display: "standalone",
  orientation: "landscape",
}
```

and that its serialized form has no `?`, `boothKey`, credential, or hash.

Test:

```ts
expect(isStandalone(() => ({ matches: true }), false)).toBe(true);
expect(isStandalone(() => ({ matches: false }), true)).toBe(true);
expect(shouldWarnBeforeUnload({
  captureActive: false,
  durableHandoffActive: false,
  pendingCount: 0,
})).toBe(false);
expect(shouldWarnBeforeUnload({
  captureActive: false,
  durableHandoffActive: false,
  pendingCount: 1,
})).toBe(true);
```

Use a fake wake provider to test acquire, release, denied/unsupported fallback,
and visible-page reacquisition.

- [ ] **Step 2: Run tests and verify missing modules**

Run:

```bash
bun test 'app/[event]/manifest.test.ts' \
  'app/[event]/booth-session/installed-mode.test.ts' \
  'app/[event]/operator-controls.test.tsx'
```

Expected: FAIL because the installed-mode files do not exist.

- [ ] **Step 3: Implement the per-Event manifest and iOS metadata**

Use `canonicalEvent()` for the dynamic Event. Return a black, landscape,
standalone manifest with the Event path as ID/start/scope and
`/booth-icon.svg` as an `"any maskable"` icon. Add root
`appleWebApp.capable`, a black-translucent status bar, and the existing
zoom-accessible viewport behavior. Never include a key or query string.

- [ ] **Step 4: Implement installed-mode helpers**

```ts
export function isStandalone(
  matchMedia: (query: string) => { matches: boolean },
  navigatorStandalone?: boolean
): boolean;

export function shouldWarnBeforeUnload(input: {
  captureActive: boolean;
  durableHandoffActive: boolean;
  pendingCount: number;
}): boolean;

export class ScreenWakeController {
  request(): Promise<"active" | "unsupported" | "denied">;
  release(): Promise<void>;
}
```

Detect both `(display-mode: standalone)` and iOS `navigator.standalone`.
Request wake on unlock/operator gestures and visible-page return. Show iPad
Auto-Lock instructions when unsupported or denied. Register `beforeunload`
only when the pure predicate is true.

- [ ] **Step 5: Implement authenticated operator exit**

The discoverable Operator control asks for a fresh Booth or Admin key and
verifies it through preflight. On success:

1. Stop camera tracks.
2. Release Screen Wake Lock.
3. Stop heartbeat/state polling and Session retry timers/lease.
4. Clear active/session/local credential state.
5. Return to the locked/exited screen.
6. Leave every Outbox record intact.

Failed verification changes no runtime resource or credential state.

- [ ] **Step 6: Run installed-mode and full verification**

Run:

```bash
bun test 'app/[event]/manifest.test.ts' \
  'app/[event]/booth-session/installed-mode.test.ts' \
  'app/[event]/operator-controls.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/layout.tsx 'app/[event]' public/booth-icon.svg
git commit -m "feat: support installed booth operation"
```

Do not add a service worker in this task. The design makes it conditional on a
failed installed-relaunch staging test. If evidence requires one, write a
separate reviewed plan whose cache allowlist contains only the Booth shell,
build-versioned static assets, icons, and Frame artwork, and explicitly
excludes every API, photo, Admin, export, moderation, heartbeat, health, and
rehearsal request plus the Outbox IndexedDB database.

### Task 8: Add WebKit coverage, runbooks, and the Release 1 gate

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `playwright.config.ts`
- Create: `tests/booth-control.spec.ts`
- Modify: `.github/workflows/verify.yml`
- Modify: `docs/runbooks/pre-event-readiness.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: repeatable mocked-camera WebKit coverage and exact operator validation steps.

- [ ] **Step 1: Add Playwright WebKit and a failing Booth control journey**

Add `@playwright/test` as a dev dependency and:

```json
{
  "scripts": {
    "test:browser": "playwright test --project=webkit"
  }
}
```

Configure `bun dev` as the Playwright web server. In
`tests/booth-control.spec.ts`, install a `MediaStream`-returning mocked
`getUserMedia` before page load and intercept preflight, Booth state,
heartbeat, and upload requests.

The journey verifies:

- Outbox recovery UI is available before unlock.
- Camera is not requested before successful preflight.
- Session-default and remembered unlock.
- Wrong credential relocks without removing pending state.
- Pause at picker stops camera.
- Pause during capture finishes durable handoff before stopping.
- Reconnect wakes retry and retains one acknowledged photo identity.
- Operator exit stops camera and preserves pending count.
- Page URL and manifest contain no credential.

- [ ] **Step 2: Run the browser test and verify expected initial failure**

Run:

```bash
bunx playwright install webkit
bun run test:browser
```

Expected: FAIL until the route mocks and selectors match the completed Release
1 UI; no production or staging service is contacted.

- [ ] **Step 3: Complete browser fixtures and CI integration**

Keep API interception scoped to the test context. Update
`.github/workflows/verify.yml` to install WebKit and run `bun run
test:browser` after the existing Bun tests and production build. Preserve all
existing verification steps.

- [ ] **Step 4: Update real-device runbooks**

Add staging-first checks for:

1. Valid unlock and camera readiness.
2. Session-only versus remembered credential.
3. Durable IndexedDB and reload recovery.
4. Offline captures, automatic reconnect drain, and no duplicate after lost acknowledgment.
5. Two-tab Event lease behavior.
6. Pause at picker and during a real multi-shot capture.
7. Heartbeat live/stale transitions in Admin.
8. Add-to-Home-Screen canonical launch and landscape standalone mode.
9. Wake behavior and iPad Auto-Lock fallback.
10. Authenticated exit releasing camera/wake while preserving pending photos.

Use a throwaway canonical staging Event distinct from production. Any
moderation cleanup uses one complete Event-owned image key.

- [ ] **Step 5: Run the complete automated Release 1 gate**

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

- [ ] **Step 6: Perform required real-iPad staging validation**

Automated tests do not prove:

- Real Safari camera permission, orientation, crop, or camera indicator shutdown.
- Add-to-Home-Screen launch into the canonical Event.
- Real standalone/background/foreground behavior.
- Screen Wake Lock or Auto-Lock fallback behavior on the target iPadOS.
- IndexedDB survival across Safari and installed-mode relaunch.
- Cross-tab lease behavior in Safari.
- Venue-network offline/reconnect timing and lost-acknowledgment recovery.
- Pause timing during a real multi-shot capture.
- Camera and wake release during operator exit.

Follow `docs/runbooks/deployment.md`, deploy only the named staging
environment, and stop promotion if any check fails.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock playwright.config.ts tests/booth-control.spec.ts \
  .github/workflows/verify.yml docs/runbooks/pre-event-readiness.md \
  docs/runbooks/deployment.md
git commit -m "test: verify reliable booth control"
```

## Dependency Order

1. Task 1 requires Release 0B.
2. Task 2 is independent of Task 1.
3. Task 3 requires Task 2 and Release 0B shared auth.
4. Task 4 requires Task 3.
5. Task 5 requires Tasks 1, 3, and 4.
6. Task 6 requires Task 3 and may proceed independently of Task 5.
7. Task 7 requires Tasks 4 and 5.
8. Task 8 follows Tasks 1–7.

## Final Safety Review

- Heartbeats, pause state, and device IDs exist only in `STATE`.
- Preflight explicitly constructs `EventExperience`; it never serializes private config.
- No credential is placed in a URL, manifest, heartbeat, public object, or log.
- Pause never deletes or suspends the Photo Outbox drain.
- Operator exit preserves every pending item.
- IndexedDB changes add one store and preserve old rows.
- Fresh capture remains impossible without online authenticated preflight.
- Frame choice returns fresh after every completed capture.
- No unnamed Wrangler environment is deployed.
