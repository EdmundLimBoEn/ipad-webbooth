# Release 0A Configuration History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable, conflict-safe Event configuration revisions, restore, and an Admin history panel without exposing or restoring Booth credentials.

**Architecture:** A focused `event-config` module owns versioned parsing and explicit public projection. `EventStore` appends immutable revision objects in private `STATE` and advances the config head with compare-and-swap; API handlers are dependency-injected and route files remain thin. Admin saves and restores against an explicit base revision and retains mutation IDs across ambiguous network failures.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers, R2, CSS Modules.

## Global Constraints

- Use Bun commands only.
- `EventStore` remains the sole owner of `PHOTOS` and `STATE` keys.
- Event route inputs use `canonicalEvent()` and reject non-canonical aliases.
- Config heads, revisions, and Booth Key hashes remain in private `STATE`.
- Public config is constructed from an allowlist and never includes `boothKeyHash` or `currentRevisionId`.
- Revisions are immutable, reachable-history only, and never contain a Booth credential.
- Restore creates a new revision and preserves the current Booth Key hash.
- All migrations are additive; legacy public config remains untouched for rollback.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.

---

## File structure

- Create `app/event-config.ts` — config/revision types, validation, safe projection, revision-ID validation.
- Create `app/event-config.test.ts` — schema and privacy characterization.
- Modify `app/event-store.ts` — object etags/CAS, revision keys, save/restore/history.
- Modify `app/event-store.test.ts` — CAS, concurrency, immutable history, restore.
- Create `app/api/config/handlers.ts` — dependency-injected config HTTP behavior.
- Create `app/api/config/handlers.test.ts` — HTTP status, auth, redaction, conflict tests.
- Modify `app/api/config/route.ts` — thin GET/PUT adapters.
- Create `app/api/config/revisions/route.ts` — thin history GET adapter.
- Create `app/api/config/revisions/restore/route.ts` — thin restore POST adapter.
- Create `app/[event]/admin/config-history-panel.tsx` — focused history presentation.
- Create `app/[event]/admin/config-history-panel.test.tsx` — pure diff and server-render tests.
- Modify `app/[event]/admin/page.tsx` — revision-aware load/save/restore state.
- Modify `app/[event]/admin/admin.module.css` — history panel styling.
- Modify `tsconfig.test.json` — include `.test.tsx`.

### Task 1: Define the revisioned Event schema and safe projection

**Files:**
- Create: `app/event-config.ts`
- Create: `app/event-config.test.ts`

**Interfaces:**
- Produces: `EventExperience`, `EventConfig`, `ConfigRevision`, `PublicEventConfig`.
- Produces: `parseEventConfig(value)`, `parseConfigRevision(value)`, `projectPublicConfig(config)`, `isRevisionId(value)`.
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write the failing schema and privacy tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  isRevisionId,
  parseConfigRevision,
  parseEventConfig,
  projectPublicConfig,
} from "./event-config";

describe("event config schema", () => {
  test("parses the complete additive experience", () => {
    expect(parseEventConfig({
      version: 1,
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en", "zh-SG"],
      defaultLocale: "en",
      timeZone: "Asia/Singapore",
      capture: { reviewEnabled: true, autoAcceptSeconds: 5, countdownAudioDefault: false },
      gallery: { title: "Launch Night", accentColor: "#ff3366" },
    })).toEqual({
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en", "zh-SG"],
      defaultLocale: "en",
      timeZone: "Asia/Singapore",
      capture: { reviewEnabled: true, autoAcceptSeconds: 5, countdownAudioDefault: false },
      gallery: { title: "Launch Night", accentColor: "#ff3366" },
    });
  });

  test("rejects unsupported versions and malformed nested settings", () => {
    expect(parseEventConfig({ version: 2, frames: [] })).toBeNull();
    expect(parseEventConfig({ version: 1, frames: [], capture: { autoAcceptSeconds: -1 } })).toBeNull();
    expect(parseEventConfig({ version: 1, frames: [], gallery: { accentColor: "red<script>" } })).toBeNull();
  });

  test("projects only public allowlisted fields", () => {
    const projected = projectPublicConfig({
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en"],
      defaultLocale: "en",
    });
    expect(projected).toEqual({
      frames: ["square"],
      hasBoothKey: true,
      locales: ["en"],
      defaultLocale: "en",
    });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("boothKeyHash");
    expect(json).not.toContain("currentRevisionId");
    expect(projectPublicConfig(null)).toEqual({ frames: null, hasBoothKey: false });
  });

  test("revision parsing rejects credentials inside experience", () => {
    const base = {
      version: 1,
      id: "018f0000-0000-7000-8000-000000000001",
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "baseline",
    };
    expect(parseConfigRevision({ ...base, config: { frames: ["square"] } })).not.toBeNull();
    expect(parseConfigRevision({ ...base, config: { frames: ["square"], boothKeyHash: "leak" } })).toBeNull();
  });

  test("accepts UUID mutation/revision IDs only", () => {
    expect(isRevisionId("018f0000-0000-7000-8000-000000000001")).toBe(true);
    expect(isRevisionId("../config")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test app/event-config.test.ts`

Expected: FAIL because `./event-config` does not exist.

- [ ] **Step 3: Implement the schema and explicit projection**

```ts
export const EVENT_CONFIG_VERSION = 1 as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type LocaleCode = string;
export type EventExperience = {
  frames: string[];
  locales?: LocaleCode[];
  defaultLocale?: LocaleCode;
  timeZone?: string;
  capture?: {
    reviewEnabled?: boolean;
    autoAcceptSeconds?: number;
    countdownAudioDefault?: boolean;
  };
  gallery?: { title?: string; accentColor?: string };
};
export type EventConfig = EventExperience & {
  boothKeyHash?: string;
  currentRevisionId?: string;
};
export type ConfigRevision = {
  version: 1;
  id: string;
  createdAt: string;
  parentRevisionId: string | null;
  reason: "baseline" | "save" | "restore" | "preset";
  sourceRevisionId?: string;
  sourcePresetId?: string;
  config: EventExperience;
};
export type PublicEventConfig = Omit<EventExperience, "frames"> & {
  frames: string[] | null;
  hasBoothKey: boolean;
};

export const isRevisionId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

function parseExperience(value: unknown): EventExperience | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.frames) || !v.frames.every((x) => typeof x === "string" && TOKEN.test(x))) return null;
  if (v.locales !== undefined && (!Array.isArray(v.locales) || !v.locales.every((x) => typeof x === "string" && TOKEN.test(x)))) return null;
  if (v.defaultLocale !== undefined && (typeof v.defaultLocale !== "string" || !TOKEN.test(v.defaultLocale))) return null;
  if (v.timeZone !== undefined && (typeof v.timeZone !== "string" || v.timeZone.length > 128)) return null;
  const capture = v.capture as Record<string, unknown> | undefined;
  if (capture !== undefined && (!capture || typeof capture !== "object")) return null;
  if (capture?.reviewEnabled !== undefined && typeof capture.reviewEnabled !== "boolean") return null;
  if (capture?.countdownAudioDefault !== undefined && typeof capture.countdownAudioDefault !== "boolean") return null;
  if (capture?.autoAcceptSeconds !== undefined && (typeof capture.autoAcceptSeconds !== "number" || !Number.isInteger(capture.autoAcceptSeconds) || capture.autoAcceptSeconds < 1 || capture.autoAcceptSeconds > 30)) return null;
  const gallery = v.gallery as Record<string, unknown> | undefined;
  if (gallery !== undefined && (!gallery || typeof gallery !== "object")) return null;
  if (gallery?.title !== undefined && (typeof gallery.title !== "string" || gallery.title.length > 120)) return null;
  if (gallery?.accentColor !== undefined && (typeof gallery.accentColor !== "string" || !HEX_COLOR.test(gallery.accentColor))) return null;
  return {
    frames: [...v.frames] as string[],
    ...(v.locales ? { locales: [...v.locales] as string[] } : {}),
    ...(typeof v.defaultLocale === "string" ? { defaultLocale: v.defaultLocale } : {}),
    ...(typeof v.timeZone === "string" ? { timeZone: v.timeZone } : {}),
    ...(capture ? { capture: { ...capture } as EventExperience["capture"] } : {}),
    ...(gallery ? { gallery: { ...gallery } as EventExperience["gallery"] } : {}),
  };
}

export function parseEventConfig(value: unknown): EventConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== undefined && v.version !== EVENT_CONFIG_VERSION) return null;
  const experience = parseExperience({ ...v, frames: v.frames ?? [] });
  if (!experience) return null;
  if (v.boothKeyHash !== undefined && typeof v.boothKeyHash !== "string") return null;
  if (v.currentRevisionId !== undefined && !isRevisionId(v.currentRevisionId)) return null;
  return {
    ...experience,
    ...(typeof v.boothKeyHash === "string" ? { boothKeyHash: v.boothKeyHash } : {}),
    ...(typeof v.currentRevisionId === "string" ? { currentRevisionId: v.currentRevisionId } : {}),
  };
}

export function parseConfigRevision(value: unknown): ConfigRevision | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !isRevisionId(v.id) || typeof v.createdAt !== "string") return null;
  if (v.parentRevisionId !== null && !isRevisionId(v.parentRevisionId)) return null;
  if (!["baseline", "save", "restore", "preset"].includes(String(v.reason))) return null;
  const config = parseExperience(v.config);
  if (!config || (v.config as Record<string, unknown>).boothKeyHash !== undefined) return null;
  return { ...v, config } as ConfigRevision;
}

export function projectPublicConfig(config: EventConfig | null): PublicEventConfig {
  if (!config) return { frames: null, hasBoothKey: false };
  return {
    frames: [...config.frames],
    hasBoothKey: Boolean(config.boothKeyHash),
    ...(config.locales ? { locales: [...config.locales] } : {}),
    ...(config.defaultLocale ? { defaultLocale: config.defaultLocale } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(config.capture ? { capture: { ...config.capture } } : {}),
    ...(config.gallery ? { gallery: { ...config.gallery } } : {}),
  };
}
```

- [ ] **Step 4: Run schema tests and both type-checkers**

Run: `bun test app/event-config.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/event-config.ts app/event-config.test.ts
git commit -m "feat: define revisioned event experience schema"
```

### Task 2: Add immutable revision storage and compare-and-swap

**Files:**
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Task 1 config parsers and types.
- Produces: `ObjectStore.compareAndSwap()`, `eventConfigRevisionKey()`, `saveConfigRevision()`.
- Produces: `ConfigConflictError`, `ConfigMutationConflictError`, `ConfigMutationResult`.

- [ ] **Step 1: Add failing CAS and save-history tests**

Add tests that perform these exact assertions:

```ts
test("compareAndSwap rejects a stale etag", async () => {
  const state = new InMemoryObjectStore();
  expect(await state.compareAndSwap("head", null, "one")).toBe(true);
  const first = await state.get("head");
  expect(await state.compareAndSwap("head", "stale", "two")).toBe(false);
  expect(await state.compareAndSwap("head", first!.etag, "two")).toBe(true);
  expect(await first!.text()).toBe("one");
  expect(await (await state.get("head"))!.text()).toBe("two");
});

test("first revision save appends baseline and preserves booth key", async () => {
  const state = new InMemoryObjectStore({
    [eventConfigKey("launch")]: JSON.stringify({ version: 1, frames: ["old"], boothKeyHash: "hash" }),
  });
  const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example", () => new Date("2026-07-24T00:00:00Z"));
  const result = await store.saveConfigRevision("launch", {
    config: { frames: ["new"] },
    baseRevisionId: null,
    mutationId: "018f0000-0000-7000-8000-000000000002",
  });
  expect(result.config.boothKeyHash).toBe("hash");
  expect(result.revision.parentRevisionId).not.toBeNull();
  expect(result.idempotent).toBe(false);
  expect((await store.readConfig("launch"))?.currentRevisionId).toBe(result.revision.id);
});

test("stale save conflicts and an identical mutation retry is idempotent", async () => {
  const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
  const input = {
    config: { frames: ["one"] },
    baseRevisionId: null,
    mutationId: "018f0000-0000-7000-8000-000000000003",
  };
  expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(false);
  expect((await store.saveConfigRevision("launch", input)).idempotent).toBe(true);
  await expect(store.saveConfigRevision("launch", {
    ...input,
    mutationId: "018f0000-0000-7000-8000-000000000004",
  })).rejects.toBeInstanceOf(ConfigConflictError);
});
```

Also add tests for one CAS winner from two concurrent saves, an orphan revision
hidden from later history, and a mutation ID reused with different config
throwing `ConfigMutationConflictError`.

- [ ] **Step 2: Run the Event Store tests and confirm missing-interface failures**

Run: `bun test app/event-store.test.ts`

Expected: FAIL because `etag`, `compareAndSwap`, and `saveConfigRevision` do not exist.

- [ ] **Step 3: Implement etags, immutable revision keys, and CAS save**

Add to the storage interface:

```ts
export type StoredObject = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
};

export interface ObjectStore {
  get(key: string): Promise<StoredObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): Promise<ListResult>;
  compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: R2PutOptions
  ): Promise<boolean>;
}
```

Implement R2 CAS with `onlyIf: expectedEtag === null
? { etagDoesNotMatch: "*" } : { etagMatches: expectedEtag }`. Implement the
memory adapter by checking the current entry etag immediately before replacing
it and assigning a new `crypto.randomUUID()` etag.

Add the public revision interfaces:

```ts
export const eventConfigRevisionPrefix = (event: string) =>
  `events/${event}/config-revisions/`;
export const eventConfigRevisionKey = (event: string, id: string) =>
  `${eventConfigRevisionPrefix(event)}${id}.json`;

export type ConfigMutationResult = {
  config: EventConfig;
  revision: ConfigRevision;
  idempotent: boolean;
};

export class ConfigConflictError extends Error {
  constructor(readonly expectedRevisionId: string | null, readonly currentRevisionId: string | null) {
    super("event configuration changed");
  }
}
export class ConfigMutationConflictError extends Error {
  constructor() { super("mutation ID was already used for different configuration"); }
}
```

Implement `saveConfigRevision(event, input)` in this order:

1. Read the current head plus etag.
2. If a revision with `mutationId` exists, compare its canonical JSON payload
   with the requested revision and either finish/return idempotently or throw
   `ConfigMutationConflictError`.
3. Compare `baseRevisionId` with the current head.
4. If the head is legacy, append one `crypto.randomUUID()` baseline revision;
   never include its Booth Key hash. The following save revision records that
   baseline as its parent, so an existing mutation revision is the recovery
   anchor after a partial failure.
5. Append the immutable save revision with `compareAndSwap(key, null, json)`.
6. Advance `config.json` with CAS, merging the new experience with the existing
   hash unless a replacement hash was supplied.
7. Throw `ConfigConflictError` if the head CAS loses.

- [ ] **Step 4: Run Event Store tests and type-check**

Run: `bun test app/event-store.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/event-store.ts app/event-store.test.ts
git commit -m "feat: append immutable event config revisions"
```

### Task 3: Add reachable history and restore

**Files:**
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Task 2 immutable revisions.
- Produces: `readConfigHistory(event)`, `restoreConfigRevision(event, input)`.
- Produces: `ConfigRevisionNotFoundError`, `InvalidStoredConfigRevisionError`.

- [ ] **Step 1: Write failing history and restore tests**

```ts
test("history follows only the reachable head chain and restore appends", async () => {
  const state = new InMemoryObjectStore();
  const store = new EventStore(new InMemoryObjectStore(), state, "https://photos.example");
  const first = await store.saveConfigRevision("launch", {
    config: { frames: ["one"] },
    baseRevisionId: null,
    mutationId: "018f0000-0000-7000-8000-000000000010",
  });
  const second = await store.saveConfigRevision("launch", {
    config: { frames: ["two"] },
    baseRevisionId: first.revision.id,
    mutationId: "018f0000-0000-7000-8000-000000000011",
  });
  state.set(eventConfigRevisionKey("launch", "018f0000-0000-7000-8000-000000000099"), JSON.stringify({
    version: 1,
    id: "018f0000-0000-7000-8000-000000000099",
    createdAt: "2026-07-24T00:00:00Z",
    parentRevisionId: null,
    reason: "save",
    config: { frames: ["orphan"] },
  }));
  expect((await store.readConfigHistory("launch")).revisions.map((r) => r.id)).toEqual([
    second.revision.id,
    first.revision.id,
  ]);
  const restored = await store.restoreConfigRevision("launch", {
    revisionId: first.revision.id,
    baseRevisionId: second.revision.id,
    mutationId: "018f0000-0000-7000-8000-000000000012",
  });
  expect(restored.config.frames).toEqual(["one"]);
  expect(restored.revision).toMatchObject({
    reason: "restore",
    sourceRevisionId: first.revision.id,
    parentRevisionId: second.revision.id,
  });
});
```

Add explicit tests for a missing source, corrupt reachable JSON, a missing
parent, a cycle, stale restore, idempotent retry, and Booth Key preservation.

- [ ] **Step 2: Run the focused tests and verify missing-method failures**

Run: `bun test app/event-store.test.ts`

Expected: FAIL because history and restore methods are missing.

- [ ] **Step 3: Implement reachable traversal and restore-as-append**

```ts
export type ConfigHistory = {
  config: EventConfig | null;
  currentRevisionId: string | null;
  revisions: ConfigRevision[];
};
export class ConfigRevisionNotFoundError extends Error {}
export class InvalidStoredConfigRevisionError extends Error {}
```

`readConfigHistory()` starts at `config.currentRevisionId`, loads each complete
revision key, validates it, tracks visited IDs, and follows `parentRevisionId`
until null. It throws on missing/corrupt/future/cyclic reachable records and
never lists prefix orphans.

`restoreConfigRevision()` loads the selected reachable revision, then calls the
same append/CAS primitive as save with `reason: "restore"` and
`sourceRevisionId`. It uses the selected `EventExperience` and always carries
the current head’s Booth Key hash.

- [ ] **Step 4: Run the Event Store suite**

Run: `bun test app/event-store.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/event-store.ts app/event-store.test.ts
git commit -m "feat: restore event config from revision history"
```

### Task 4: Expose revision-aware HTTP contracts

**Files:**
- Create: `app/api/config/handlers.ts`
- Create: `app/api/config/handlers.test.ts`
- Modify: `app/api/config/route.ts`
- Create: `app/api/config/revisions/route.ts`
- Create: `app/api/config/revisions/restore/route.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: public GET, Admin save/history/restore handlers with deterministic status mapping.
- Consumed by: Task 5 Admin UI.

- [ ] **Step 1: Write failing dependency-injected handler tests**

```ts
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { EventStore, InMemoryObjectStore } from "@/app/event-store";
import { getPublicConfig, getConfigRevisions, postConfigRestore, putConfig } from "./handlers";

const deps = () => ({
  store: new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example"),
  adminKey: "admin-secret",
  hashBoothKey: async (key: string) => `hashed:${key}`,
});
const request = (url: string, init: RequestInit = {}) => new NextRequest(url, init);

describe("config handlers", () => {
  test("public config is explicitly redacted", async () => {
    const d = deps();
    await d.store.writeConfig("launch", { frames: ["square"], boothKeyHash: "secret" });
    const response = await getPublicConfig(request("https://app.test/api/config?event=launch"), d);
    expect(await response.json()).toEqual({ frames: ["square"], hasBoothKey: true });
  });

  test("save requires canonical Event, Admin Key, mutation, and base", async () => {
    const d = deps();
    const response = await putConfig(request("https://app.test/api/config?event=launch", {
      method: "PUT",
      headers: { "x-booth-key": "admin-secret", "content-type": "application/json" },
      body: JSON.stringify({
        frames: ["square"],
        boothKey: "123456789012",
        mutationId: "018f0000-0000-7000-8000-000000000020",
        baseRevisionId: null,
      }),
    }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      frames: ["square"],
      hasBoothKey: true,
      currentRevisionId: "018f0000-0000-7000-8000-000000000020",
      idempotent: false,
    });
  });
});
```

Add cases for `400`, `401`, `503`, `404`, `409`, alias rejection, unknown
Frame, invalid key length, idempotent retry, authenticated history, restore,
and recursive response scans for credential fields.

- [ ] **Step 2: Run handler tests and verify missing-module failure**

Run: `bun test app/api/config/handlers.test.ts`

Expected: FAIL because `handlers.ts` does not exist.

- [ ] **Step 3: Implement handlers and thin route adapters**

Use these exact request bodies:

```ts
type SaveBody = {
  frames: string[];
  boothKey?: string;
  mutationId: string;
  baseRevisionId: string | null;
};
type RestoreBody = {
  revisionId: string;
  mutationId: string;
  baseRevisionId: string | null;
};
```

Export:

```ts
export type ConfigHandlerDeps = {
  store: EventStore;
  adminKey?: string;
  hashBoothKey: (key: string) => Promise<string>;
};
export function getPublicConfig(req: NextRequest, deps: ConfigHandlerDeps): Promise<NextResponse>;
export function putConfig(req: NextRequest, deps: ConfigHandlerDeps): Promise<NextResponse>;
export function getConfigRevisions(req: NextRequest, deps: ConfigHandlerDeps): Promise<NextResponse>;
export function postConfigRestore(req: NextRequest, deps: ConfigHandlerDeps): Promise<NextResponse>;
```

Return `400` for malformed input, `401` for rejected Admin Key, `503` when the
Admin Key is unavailable, `404` for a missing restore source, and `409` for
stale base or mutation reuse. Successful save/restore returns the safe
projection plus `currentRevisionId` and `idempotent`. History returns only
reachable revisions and safe current config.

Each route file obtains `{ env }`, creates `EventStore.fromEnv(env)`, and calls
one handler. No route constructs storage keys.

- [ ] **Step 4: Run handler tests and application type-check**

Run: `bun test app/api/config/handlers.test.ts && bun run typecheck && bun run typecheck:tests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/config
git commit -m "feat: expose config history and restore APIs"
```

### Task 5: Add Admin configuration history and conflict-safe save

**Files:**
- Create: `app/[event]/admin/config-history-panel.tsx`
- Create: `app/[event]/admin/config-history-panel.test.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/admin.module.css`
- Modify: `tsconfig.test.json`

**Interfaces:**
- Consumes: Task 4 API shapes.
- Produces: visible history, restore confirmation, retained mutation retries, and conflict reload.

- [ ] **Step 1: Write failing pure component and diff tests**

```tsx
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigHistoryPanel, diffFrameKeys } from "./config-history-panel";

test("diffFrameKeys reports additions and removals", () => {
  expect(diffFrameKeys(["one", "three"], ["one", "two"])).toEqual({
    added: ["two"],
    removed: ["three"],
  });
});

test("history renders reasons and disables restoring the current revision", () => {
  const html = renderToStaticMarkup(
    <ConfigHistoryPanel
      currentFrames={["one"]}
      currentRevisionId="018f0000-0000-7000-8000-000000000030"
      revisions={[{
        version: 1,
        id: "018f0000-0000-7000-8000-000000000030",
        createdAt: "2026-07-24T00:00:00.000Z",
        parentRevisionId: null,
        reason: "save",
        config: { frames: ["one"] },
      }]}
      loading={false}
      restoringRevisionId={null}
      error=""
      onReload={() => {}}
      onRestore={() => {}}
    />
  );
  expect(html).toContain("Configuration history");
  expect(html).toContain("Current");
  expect(html).toContain("disabled");
  expect(html).not.toContain("boothKey");
});
```

- [ ] **Step 2: Run the component test and verify missing-module failure**

Run: `bun test 'app/[event]/admin/config-history-panel.test.tsx'`

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement the focused panel**

```tsx
"use client";
import type { ConfigRevision } from "../../event-config";

export type ConfigHistoryPanelProps = {
  currentFrames: readonly string[];
  currentRevisionId: string | null;
  revisions: readonly ConfigRevision[];
  loading: boolean;
  restoringRevisionId: string | null;
  error: string;
  onReload: () => void;
  onRestore: (revisionId: string) => void;
};

export function diffFrameKeys(current: readonly string[], historical: readonly string[]) {
  return {
    added: historical.filter((key) => !current.includes(key)),
    removed: current.filter((key) => !historical.includes(key)),
  };
}
```

Render revision time, reason, Frame count, Current marker, added/removed Frame
labels, reload failure state, and a two-step exact revision/time confirmation.
Current revisions cannot be restored. The component accepts no credential prop.

- [ ] **Step 4: Integrate revision state into Admin**

Add one authenticated history load returning `config`,
`currentRevisionId`, and `revisions`. Save sends `baseRevisionId` and a
`crypto.randomUUID()` mutation ID. Retain the same pending mutation ID after a
network/unknown failure; clear it when the editable Frames/Booth Key changes or
after a definitive `400`, `401`, or `409`.

On `409`, reload history and show:

```text
Configuration changed; review the latest version before saving.
```

Restore uses the same retained-ID rule per selected target, reloads history on
success, updates Frames and `hasBoothKey`, and never fills the Booth Key input.
Disable Save until authenticated history supplies the editor base.

Add `"app/**/*.test.tsx"` to `tsconfig.test.json`.

- [ ] **Step 5: Run component, type, and full repository verification**

Run:

```bash
bun test 'app/[event]/admin/config-history-panel.test.tsx'
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
```

Expected: every command exits 0.

- [ ] **Step 6: Commit**

```bash
git add 'app/[event]/admin' tsconfig.test.json
git commit -m "feat: add admin config history and restore"
```
