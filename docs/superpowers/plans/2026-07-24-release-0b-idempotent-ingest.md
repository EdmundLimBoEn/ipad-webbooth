# Release 0B Idempotent Photo Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every durable Outbox item a stable upload identity so repeated or concurrent attempts produce one public photo and one private moderation index record.

**Architecture:** A browser-safe upload-contract module parses and emits strict stable identity headers. `EventStore` uses conditional create for deterministic photo keys, requires a private immutable index before acknowledging stable clients, and writes optional private receipts without requeuing an accepted photo. Booth Session passes the complete durable Outbox item to its upload adapter so identity survives reload and rollback-compatible old rows remain uploadable.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers, R2, IndexedDB.

## Global Constraints

- Use Bun commands only.
- This plan starts after Release 0A; reuse its `ObjectStore` conditional-write primitives and config revision types.
- `EventStore` remains the sole owner of public and private object keys.
- Only image bytes are written to public `PHOTOS`.
- Indexes, receipts, capture metadata, credentials, and revisions remain in private `STATE`.
- Stable uploads require both the deterministic photo and immutable index before acknowledgment.
- Receipt failure is best-effort and never causes an acknowledged photo to retry.
- Legacy clients without stable headers preserve the random-key acknowledgment behavior.
- Accepted Photo Outbox items are removed only after storage acknowledgment.
- Existing IndexedDB rows remain readable without destructive migration.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.

---

## File structure

- Create `app/upload-contract.ts` — stable identity/metadata types and strict header codec.
- Create `app/upload-contract.test.ts` — legacy, malformed, and round-trip contracts.
- Modify `app/event-store.ts` — conditional photo create, deterministic keys, private index/receipt.
- Modify `app/event-store.test.ts` — lost acknowledgment, concurrency, partial private failure.
- Refactor `app/api/upload/route.ts` — dependency-injected handler and additive response.
- Create `app/api/upload/route.test.ts` — real HTTP contract over in-memory stores.
- Modify `app/upload-auth.ts` — shared Booth-or-Admin authentication helper.
- Modify `app/upload-auth.test.ts` — shared authentication behavior.
- Modify `app/[event]/booth-session/outbox.ts` — additive metadata fields.
- Modify `app/[event]/booth-session/session.ts` — upload complete Outbox items.
- Modify `app/[event]/booth-session/session.test.ts` — identity persistence and old-row compatibility.
- Create `app/[event]/booth-session/upload.ts` — pure Outbox-to-header adapter.
- Create `app/[event]/booth-session/upload.test.ts` — stable header tests.
- Modify `app/[event]/page.tsx` — upload item body/headers and capture source/Frame metadata.

### Task 1: Define the stable upload header contract

**Files:**
- Create: `app/upload-contract.ts`
- Create: `app/upload-contract.test.ts`

**Interfaces:**
- Produces: `CaptureMetadata`, `StableCaptureIdentity`, `StableUpload`, `UploadIntent`.
- Produces: `parseUploadHeaders(headers)` and `stableUploadHeaders(input)`.
- Consumed by: Tasks 2–4.

- [ ] **Step 1: Write failing parser and round-trip tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  InvalidUploadHeadersError,
  parseUploadHeaders,
  stableUploadHeaders,
} from "./upload-contract";

const headers = (values: Record<string, string>) => new Headers(values);

describe("stable upload headers", () => {
  test("all stable fields round-trip", () => {
    const stable = {
      captureId: "018f0000-0000-4000-8000-000000000001",
      capturedAt: 1753315200000,
      source: "framed" as const,
      frameKey: "square",
      configRevisionId: "018f0000-0000-7000-8000-000000000002",
    };
    expect(parseUploadHeaders(headers(stableUploadHeaders(stable)))).toEqual({
      kind: "stable",
      ...stable,
    });
  });

  test("no new headers is the legacy contract", () => {
    expect(parseUploadHeaders(headers({ "content-type": "image/jpeg" }))).toEqual({ kind: "legacy" });
  });

  test("partial identity and metadata without identity are rejected", () => {
    expect(() => parseUploadHeaders(headers({ "x-capture-id": "018f0000-0000-4000-8000-000000000001" })))
      .toThrow(InvalidUploadHeadersError);
    expect(() => parseUploadHeaders(headers({ "x-capture-source": "framed" })))
      .toThrow(InvalidUploadHeadersError);
  });

  test("rejects malformed UUID, timestamp, source, and bounded tokens", () => {
    const base = {
      "x-capture-id": "018f0000-0000-4000-8000-000000000001",
      "x-captured-at": "1753315200000",
    };
    for (const invalid of [
      { ...base, "x-capture-id": "../photo" },
      { ...base, "x-captured-at": "1e12" },
      { ...base, "x-capture-source": "video" },
      { ...base, "x-frame-key": "../frame" },
    ]) expect(() => parseUploadHeaders(headers(invalid))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run: `bun test app/upload-contract.test.ts`

Expected: FAIL because `upload-contract.ts` does not exist.

- [ ] **Step 3: Implement strict parsing and emission**

```ts
export type CaptureSource = "framed" | "camera-fallback";
export type CaptureMetadata = {
  frameKey?: string;
  capturedAt: number;
  source: CaptureSource;
  configRevisionId?: string;
};
export type StableCaptureIdentity = { captureId: string; capturedAt: number };
export type StableUpload = StableCaptureIdentity & {
  source?: CaptureSource;
  frameKey?: string;
  configRevisionId?: string;
};
export type UploadIntent = { kind: "legacy" } | ({ kind: "stable" } & StableUpload);

export class InvalidUploadHeadersError extends Error {
  constructor(
    readonly code:
      | "incomplete_capture_identity"
      | "invalid_capture_id"
      | "invalid_captured_at"
      | "invalid_capture_source"
      | "invalid_frame_key"
      | "invalid_config_revision_id",
    message: string
  ) { super(message); }
}
```

Use lowercase RFC-4122 UUID-v4 for `x-capture-id`, exactly 13 decimal digits
for `x-captured-at`, exact source enum values, and 1–128 character
`[A-Za-z0-9][A-Za-z0-9_-]*` tokens for Frame and revision IDs. Both identity
headers absent means legacy. Exactly one, or metadata without identity, throws
`InvalidUploadHeadersError`. Unknown headers are ignored.

`stableUploadHeaders()` emits:

```ts
{
  "x-capture-id": input.captureId,
  "x-captured-at": String(input.capturedAt),
  ...(input.source ? { "x-capture-source": input.source } : {}),
  ...(input.frameKey ? { "x-frame-key": input.frameKey } : {}),
  ...(input.configRevisionId ? { "x-config-revision-id": input.configRevisionId } : {}),
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `bun test app/upload-contract.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/upload-contract.ts app/upload-contract.test.ts
git commit -m "feat: define stable capture upload contract"
```

### Task 2: Make Event Store photo ingest idempotent and privately indexed

**Files:**
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Task 1 upload types and Release 0A conditional-write support.
- Produces: `stablePhotoKey()`, `photoIndexKey()`, `photoReceiptKey()`.
- Produces: `putPhoto(event, body, options)` returning `PutPhotoResult`.
- Produces: `PhotoIndexWriteError`.

- [ ] **Step 1: Write failing lost-acknowledgment and privacy tests**

```ts
test("stable ingest creates one immutable photo across retries", async () => {
  const photos = new InMemoryObjectStore();
  const state = new InMemoryObjectStore();
  const store = new EventStore(photos, state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));
  const upload = {
    captureId: "018f0000-0000-4000-8000-000000000001",
    capturedAt: 1753315200000,
    source: "framed" as const,
    frameKey: "square",
  };
  const first = await store.putPhoto("launch", new TextEncoder().encode("first").buffer, { upload });
  const retry = await store.putPhoto("launch", new TextEncoder().encode("replacement").buffer, { upload });
  expect(first.key).toBe("launch/1753315200000-018f0000-0000-4000-8000-000000000001.jpg");
  expect(retry).toMatchObject({ key: first.key, url: first.url, duplicate: true });
  expect(await (await photos.get(first.key))!.text()).toBe("first");
  expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
  expect(state.has(photoIndexKey("launch", first.key, upload.capturedAt))).toBe(true);
  expect(state.has(photoReceiptKey("launch", first.key))).toBe(true);
});

test("concurrent stable attempts produce one public image", async () => {
  const photos = new InMemoryObjectStore();
  const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
  const upload = {
    captureId: "018f0000-0000-4000-8000-000000000002",
    capturedAt: 1753315200001,
  };
  const results = await Promise.all([
    store.putPhoto("launch", new Uint8Array([1]).buffer, { upload }),
    store.putPhoto("launch", new Uint8Array([2]).buffer, { upload }),
  ]);
  expect(results.filter((x) => x.duplicate)).toHaveLength(1);
  expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
});
```

Add test-local failing `ObjectStore` wrappers to prove:

- Stable index failure leaves one photo, throws `PhotoIndexWriteError`, and an
  identical retry creates the missing index without another photo.
- Receipt failure returns success with `receiptStored: false`.
- Legacy uploads keep random keys and return success even when derived private
  writes fail.
- Same capture identity in two Events produces isolated keys.
- Receipt/index JSON contains no credential or hash fields.

- [ ] **Step 2: Run focused Event Store tests and confirm missing exports**

Run: `bun test app/event-store.test.ts`

Expected: FAIL because stable ingest helpers/options do not exist.

- [ ] **Step 3: Implement deterministic keys and derived private writes**

Add:

```ts
export const stablePhotoKey = (event: string, id: StableCaptureIdentity) =>
  `${event}/${String(id.capturedAt).padStart(13, "0")}-${id.captureId}.jpg`;
export const photoReceiptKey = (event: string, key: string) =>
  `events/${event}/photo-metadata/${key.slice(event.length + 1)}.json`;
export const photoIndexKey = (event: string, key: string, sortTime: number) =>
  `events/${event}/photo-index/v1/${String(9_999_999_999_999 - sortTime).padStart(13, "0")}-${base64url(key)}.json`;

export type PutPhotoResult = {
  key: string;
  url: string;
  duplicate: boolean;
  receiptStored: boolean;
  indexStored: boolean;
};
export class PhotoIndexWriteError extends Error {
  constructor(readonly photo: { key: string; url: string; duplicate: boolean }, options: { cause: unknown }) {
    super("photo index write failed", options);
  }
}
```

Use the Release 0A conditional-create primitive so a stable photo is never
overwritten. Capture one server time per call. For stable uploads:

1. Conditionally create the deterministic `PHOTOS` key.
2. Conditionally create the immutable `STATE` index.
3. Throw `PhotoIndexWriteError` when the index is unavailable.
4. Attempt the immutable receipt; return `receiptStored: false` on failure.

For legacy uploads, retain the current random key. Attempt index/receipt
best-effort and always acknowledge the successful photo write; a retryable
failure would create a second legacy image.

- [ ] **Step 4: Run Event Store tests and both type-checkers**

Run: `bun test app/event-store.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/event-store.ts app/event-store.test.ts
git commit -m "feat: make photo ingest idempotent and privately indexed"
```

### Task 3: Validate stable uploads at the HTTP boundary

**Files:**
- Modify: `app/upload-auth.ts`
- Modify: `app/upload-auth.test.ts`
- Modify: `app/api/upload/route.ts`
- Create: `app/api/upload/route.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: shared `boothOrAdminOk()` auth and a dependency-injected upload handler.
- Produces: additive `{ url, key, duplicate }` upload response.

- [ ] **Step 1: Add failing shared-auth and route contract tests**

```ts
test("boothOrAdminOk preserves the admin-required fail-closed rule", async () => {
  const stored = await hashBoothKey("event-key-123");
  expect(await boothOrAdminOk("admin", "admin", stored)).toBe("ok");
  expect(await boothOrAdminOk("event-key-123", "admin", stored)).toBe("ok");
  expect(await boothOrAdminOk("wrong", "admin", stored)).toBe("unauthorized");
  expect(await boothOrAdminOk("event-key-123", undefined, stored)).toBe("disabled");
});
```

Create route tests against a dependency-injected handler:

```ts
test("a stable retry returns the same key as a duplicate", async () => {
  const photos = new InMemoryObjectStore();
  const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
  const request = () => new NextRequest("https://app.test/api/upload?event=launch", {
    method: "POST",
    headers: {
      "x-booth-key": "admin",
      "content-type": "image/jpeg",
      "x-capture-id": "018f0000-0000-4000-8000-000000000001",
      "x-captured-at": "1753315200000",
    },
    body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  });
  const first = await handleUpload(request(), { store, adminKey: "admin" });
  const retry = await handleUpload(request(), { store, adminKey: "admin" });
  expect(await first.json()).toMatchObject({ duplicate: false });
  expect(await retry.json()).toMatchObject({ duplicate: true });
  expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
});
```

Add cases for legacy response compatibility, partial headers `400` with zero
writes, canonical alias `400`, `401`, `413`, `415`, index failure `503` plus
`Retry-After: 1`, identical recovery retry, and receipt failure `200`.

- [ ] **Step 2: Run auth and route tests and verify failures**

Run: `bun test app/upload-auth.test.ts app/api/upload/route.test.ts`

Expected: FAIL because shared auth and injected handler do not exist.

- [ ] **Step 3: Implement shared auth and injected upload handling**

```ts
export async function boothOrAdminOk(
  provided: string,
  adminKey: string | undefined,
  boothKeyHash?: string
): Promise<"ok" | "unauthorized" | "disabled"> {
  const admin = adminOk(provided, adminKey);
  if (admin !== "unauthorized") return admin;
  return boothKeyHash && provided && await boothKeyMatches(provided, boothKeyHash)
    ? "ok"
    : "unauthorized";
}
```

Export a handler dependency:

```ts
export type UploadHandlerDeps = { store: EventStore; adminKey?: string };
export async function handleUpload(req: NextRequest, deps: UploadHandlerDeps): Promise<NextResponse>;
```

After auth and declared-size validation, parse stable headers before buffering
the body. Map `InvalidUploadHeadersError` to `400` with its code and no writes.
Map `PhotoIndexWriteError` to `503`, `{ retryable: true }`, and
`Retry-After: 1`. Success returns:

```ts
{ url: photo.url, key: photo.key, duplicate: photo.duplicate }
```

Keep `url` for old clients. Log only Event, complete photo key, and bounded
error class; never log credential headers or arbitrary exception strings.

The exported `POST` obtains Cloudflare context and delegates.

- [ ] **Step 4: Run route tests and type-check**

Run: `bun test app/upload-auth.test.ts app/api/upload/route.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/upload-auth.ts app/upload-auth.test.ts app/api/upload/route.ts app/api/upload/route.test.ts
git commit -m "feat: validate and expose stable upload identity"
```

### Task 4: Upload the complete durable Outbox item

**Files:**
- Modify: `app/[event]/booth-session/outbox.ts`
- Modify: `app/[event]/booth-session/session.ts`
- Modify: `app/[event]/booth-session/session.test.ts`
- Create: `app/[event]/booth-session/upload.ts`
- Create: `app/[event]/booth-session/upload.test.ts`
- Modify: `app/[event]/page.tsx`

**Interfaces:**
- Consumes: Task 1 `CaptureMetadata` and header emitter.
- Produces: stable identity from capture through IndexedDB, reload, and upload.

- [ ] **Step 1: Write failing Outbox identity and header tests**

```ts
test("enqueue persists one identity and metadata before upload", async () => {
  const store = new MemoryOutboxStore();
  const seen: OutboxItem[] = [];
  const session = new BoothSession(
    "launch",
    store,
    async (item) => { seen.push(item); return { url: "/photo", key: "launch/photo.jpg" }; },
    () => {},
    () => "018f0000-0000-4000-8000-000000000001",
    () => 1753315200000
  );
  const item = await session.enqueueCapture(
    async () => new Blob(["photo"], { type: "image/jpeg" }),
    { metadata: { source: "framed", frameKey: "square" } }
  );
  expect(item).toMatchObject({
    id: "018f0000-0000-4000-8000-000000000001",
    createdAt: 1753315200000,
    metadata: { capturedAt: 1753315200000, source: "framed", frameKey: "square" },
  });
  await session.process();
  expect(seen[0]).toEqual(item);
});

test("old rows gain stable headers from id and createdAt", () => {
  const item = {
    id: "018f0000-0000-4000-8000-000000000001",
    event: "launch",
    blob: new Blob(["photo"]),
    createdAt: 1753315200000,
    attempts: 0,
  };
  expect(outboxUploadHeaders(item)).toEqual({
    "x-capture-id": item.id,
    "x-captured-at": "1753315200000",
  });
});

test("an invalid historical ID falls back to the legacy upload contract", () => {
  expect(outboxUploadHeaders({
    id: "old-non-uuid-id",
    event: "launch",
    blob: new Blob(["photo"]),
    createdAt: 1753315200000,
    attempts: 0,
  })).toEqual({});
});
```

Update the existing ordered-failure test upload callbacks to accept
`OutboxItem` and read `item.blob`. Add reload/retry assertions that the same
item ID and headers are observed on every attempt.

- [ ] **Step 2: Run Booth Session tests and verify type/interface failures**

Run: `bun test 'app/[event]/booth-session/session.test.ts' 'app/[event]/booth-session/upload.test.ts'`

Expected: FAIL because uploads still receive only `Blob`.

- [ ] **Step 3: Extend the additive Outbox and Session contracts**

```ts
export type OutboxItem = {
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
export type UploadResult = { url: string; key?: string; duplicate?: boolean };
export type Upload = (item: OutboxItem) => Promise<UploadResult>;
export type EnqueueCaptureOptions = {
  signal?: AbortSignal;
  metadata: Omit<CaptureMetadata, "capturedAt">;
  rehearsalId?: string;
};
```

`enqueueCapture(capture, options)` creates the ID and monotonic time only after
capture/composition succeeds, sets both `createdAt` and
`metadata.capturedAt`, writes the item, and returns it. `drain()` passes the
whole stored item. Old records use `metadata?.capturedAt ?? createdAt`.

Do not bump IndexedDB version or delete/transform existing rows.

- [ ] **Step 4: Add the pure header adapter and wire the Booth**

```ts
import { InvalidUploadHeadersError, stableUploadHeaders } from "../../upload-contract";
import type { OutboxItem } from "./outbox";

export function outboxUploadHeaders(item: OutboxItem): Record<string, string> {
  try {
    return stableUploadHeaders({
      captureId: item.id,
      capturedAt: item.metadata?.capturedAt ?? item.createdAt,
      source: item.metadata?.source,
      frameKey: item.metadata?.frameKey,
      configRevisionId: item.metadata?.configRevisionId,
    });
  } catch (error) {
    if (error instanceof InvalidUploadHeadersError) return {};
    throw error;
  }
}
```

In the Booth page, `uploadOne(item)` sends `item.blob` and the adapter headers.
Framed capture supplies `{ source: "framed", frameKey: mode }`; camera fallback
supplies `{ source: "camera-fallback" }`. Read `key` and `duplicate`
additively, tolerating a rolled-back server that returns only `url`.

- [ ] **Step 5: Run Booth tests and the full Release 0 gate**

Run:

```bash
bun test 'app/[event]/booth-session/session.test.ts' 'app/[event]/booth-session/upload.test.ts'
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
```

Expected: every command exits 0.

- [ ] **Step 6: Commit**

```bash
git add 'app/[event]/booth-session' 'app/[event]/page.tsx'
git commit -m "feat: upload stable identity from the durable outbox"
```
