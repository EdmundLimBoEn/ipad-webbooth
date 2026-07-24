# Release 5 Post-Event Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current Event photos into a private, streamed post-event package with an escaped manifest, timezone-aware analytics, and an offline printable contact sheet while preserving the existing photo-only export exactly.

**Architecture:** `EventStore` remains the only module that knows public photo and private receipt keys. The enriched export first builds an allowlisted inventory from current `PHOTOS` joined to each exact optional receipt in `STATE`, validates ZIP32 and generated-entry limits, and then streams one photo body at a time. It appends CSV, JSON, and HTML generated only from photos actually emitted, so a photo deleted during export cannot remain in the package metadata. The legacy route mode never reads `STATE` or Event config and retains its root-level photo archive.

**Tech Stack:** Bun, TypeScript, Next.js 15 App Router, React 19, Cloudflare Workers/R2, STORE ZIP streaming, `Intl.DateTimeFormat`, typed message catalogs, Playwright WebKit.

## Global Constraints

- Start only after Release 0B private version-1 photo receipts, Release 2 localized Frame labels, Release 3 exact derived cleanup, and Release 4 Event presets/rehearsal pass their complete gates.
- Use Bun commands only.
- `EventStore` remains the only owner of `PHOTOS` and `STATE` keys.
- `PHOTOS` remains authoritative for whether a photo exists.
- `GET /api/export?event=<canonical-event>` remains an Admin-only photo-only compatibility mode with root-level photo entries and no `STATE` or Event config dependency.
- `GET /api/export?event=<canonical-event>&format=package&contactSheet=1` is the only enriched mode and contains `photos/`, `manifest.csv`, `summary.json`, and `contact-sheet.html`.
- Reject incomplete or unsupported `format`/`contactSheet` combinations before any store read.
- A Booth Key never authorizes export. The Admin Key remains required.
- Missing private receipts produce `unknown` metadata and do not omit the public photo.
- Corrupt, mismatched, or unsupported future receipt versions fail the enriched export explicitly before response streaming. They never fall back to stale or guessed private metadata.
- The package may derive a capture timestamp from the 13-digit photo filename and then the public upload time, but it reports that source explicitly.
- Raw receipts, config revision IDs, indexes, revision records, Booth records, rehearsals, health state, credentials, and storage key prefixes never appear in package entries.
- The enriched stream reads at most one photo body at a time and never buffers all JPEG bytes.
- A photo missing when its body is fetched is skipped. Final generated entries are rebuilt from only photos that were actually emitted.
- Generated entries and the ZIP central directory remain bounded. No ZIP64 archive is emitted.
- The contact sheet uses relative package photo paths, inline CSS, no JavaScript, and no external request.
- CSV cells and HTML are escaped, including spreadsheet-formula prefixes.
- Every Event HTTP parameter uses `canonicalEvent()` and rejects aliases.
- Existing and future unsupported stored versions fail explicitly.
- Never bulk-delete or empty `PHOTOS`, `STATE`, or backup storage.
- Never deploy the unnamed Wrangler environment to an Event domain.

---

## File Structure

- Create `app/photo-metadata.ts` — strict version-1 private receipt schema and parser.
- Create `app/photo-metadata.test.ts` — receipt version, exact-key, timestamp, optional-field, and privacy tests.
- Modify `app/event-store.ts` — allowlisted export inventory iteration and exact receipt reads.
- Modify `app/event-store.test.ts` — multi-page inventory, missing/corrupt receipt, deletion, and Event-isolation tests.
- Create `app/export-package.ts` — safe archive names, row projection, CSV, summary, timezone buckets, and HTML.
- Create `app/export-package.test.ts` — escaping, collision, metadata-gap, timezone, analytics, and contact-sheet tests.
- Modify `app/zip.ts` — non-copying STORE entry header and exact ZIP-size estimator.
- Modify `app/zip.test.ts` — split header/data structure, offsets, and limit arithmetic.
- Create `app/export-stream.ts` — legacy and enriched ZIP stream builders plus hard limits.
- Create `app/export-stream.test.ts` — ZIP layout, one-photo-at-a-time, deletion race, and generated-entry limits.
- Create `app/api/export/handlers.ts` — dependency-injected Admin-only export HTTP boundary.
- Create `app/api/export/handlers.test.ts` — auth, query, status, compatibility, privacy, and headers.
- Modify `app/api/export/route.ts` — thin Cloudflare binding adapter.
- Create `app/[event]/admin/export-client.ts` — pure endpoint, filename, and download-mode construction.
- Create `app/[event]/admin/export-client.test.ts` — exact query/header/name and secret-placement tests.
- Create `app/[event]/admin/export-panel.tsx` — accessible package and photo-only download controls.
- Create `app/[event]/admin/export-panel.test.tsx` — mode, busy, errors, and semantic markup tests.
- Modify `app/[event]/admin/page.tsx` — replace the single count-dependent export button.
- Modify `app/[event]/admin/admin.module.css` — package panel, busy, warning, and focus styling.
- Modify `app/i18n/catalog.ts` — complete localized export copy.
- Modify `app/i18n/catalog.test.ts` — exact export-key and placeholder parity.
- Create `tests/post-event-package.spec.ts` — Admin download and accessibility journey.
- Modify `docs/runbooks/pre-event-readiness.md` — legacy/package ZIP and offline contact-sheet checks.
- Modify `docs/runbooks/deployment.md` — Release 5 staging export gate and size-failure guidance.

### Task 1: Parse private receipts and expose an allowlisted export inventory

**Files:**
- Create: `app/photo-metadata.ts`
- Create: `app/photo-metadata.test.ts`
- Modify: `app/event-store.ts`
- Modify: `app/event-store.test.ts`

**Interfaces:**
- Consumes: Release 0B `photoReceiptKey()`, stable capture sources, and the current version-1 receipt bytes.
- Produces: one strict parser shared by receipt writes, moderation, deletion cleanup, and export.
- Produces: an Event-isolated export iterator that reveals no raw private record.

- [ ] **Step 1: Write failing strict receipt parser tests**

Define:

```ts
import type { CaptureSource } from "./upload-contract";

export type PhotoReceiptV1 = {
  version: 1;
  key: string;
  uploadedAt: string;
  capturedAt: number;
  source?: CaptureSource;
  frameKey?: string;
  configRevisionId?: string;
};

export class InvalidPhotoReceiptError extends Error {
  constructor(
    readonly expectedKey: string,
    readonly reason:
      | "invalid_shape"
      | "unsupported_version"
      | "key_mismatch"
      | "invalid_timestamp"
      | "invalid_metadata"
  );
}

export function parsePhotoReceipt(
  value: unknown,
  expectedKey: string
): PhotoReceiptV1;
```

Test a valid complete receipt and a valid receipt with only required fields.
Reject:

- `null`, arrays, missing fields, extra fields, and invalid JSON projections.
- Versions other than `1`.
- A key different from `expectedKey`, including another Event.
- Non-RFC3339 `uploadedAt`.
- Non-integer or non-13-digit `capturedAt`.
- A source outside `"framed" | "camera-fallback"`.
- Blank, unsafe, or longer-than-128-character Frame/revision tokens.
- Credentials, hashes, headers, arbitrary errors, URLs, or nested objects.

The returned object must construct each property explicitly rather than spread
the stored value.

- [ ] **Step 2: Write failing Event Store export-inventory tests**

Add:

```ts
export type ExportPhotoSource = {
  key: string;
  size: number;
  uploadedAt: string;
  receipt: Pick<
    PhotoReceiptV1,
    "capturedAt" | "source" | "frameKey"
  > | null;
};

EventStore.iterateExportPhotoSources(
  event: string
): AsyncGenerator<ExportPhotoSource>;
```

Test:

- More than one `PHOTOS` list page is visited.
- Only image objects under the exact canonical Event prefix are yielded.
- Non-image public objects and cross-Event images are excluded.
- Each photo reads only `photoReceiptKey(event, photo.key)`.
- Missing exact receipt returns `receipt: null`.
- A valid receipt exposes only capture time, source, and Frame key.
- `configRevisionId`, receipt upload time, credential-like fields, private
  key names, and unknown stored fields never enter the projection.
- Corrupt, future, or wrong-key receipts throw `InvalidPhotoReceiptError`.
- A receipt without a current public photo is never yielded.
- An exact photo deleted before its inventory page is read is excluded.
- A thrown private-store read fails the enriched iterator instead of
  fabricating metadata.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test app/photo-metadata.test.ts app/event-store.test.ts
```

Expected: FAIL because the receipt parser and export iterator do not exist.

- [ ] **Step 4: Move the version-1 private shape behind the strict parser**

Use `PhotoReceiptV1` for new receipt/index serialization without changing the
existing stored JSON fields or key layout. The existing upload, moderation,
rebuild, and exact-deletion behavior must remain byte-compatible.

`parsePhotoReceipt()` must:

```ts
const RECEIPT_KEYS = new Set([
  "version",
  "key",
  "uploadedAt",
  "capturedAt",
  "source",
  "frameKey",
  "configRevisionId",
]);
```

Validate `Object.keys(value)` against this set, validate the exact expected
photo key, and return a freshly constructed object. Do not export a function
that accepts an Event prefix, filename fragment, or optional expected key.

- [ ] **Step 5: Implement page-safe exact receipt joining**

`iterateExportPhotoSources()` must use `iteratePhotoObjects(event)` for public
source truth. For each yielded object:

1. Read only its exact receipt key from `STATE`.
2. Treat a missing object as `null`.
3. Parse an existing object strictly.
4. Project only the allowlisted fields.
5. Yield the public object size and ISO upload time.

Do not list `STATE`, read the moderation index, or infer a receipt from an
index record.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test app/photo-metadata.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/photo-metadata.ts app/photo-metadata.test.ts \
  app/event-store.ts app/event-store.test.ts
git commit -m "feat: expose private export photo sources"
```

### Task 2: Build escaped manifest, timezone analytics, and offline contact sheet

**Files:**
- Create: `app/export-package.ts`
- Create: `app/export-package.test.ts`

**Interfaces:**
- Consumes: Task 1 `ExportPhotoSource` and the Frame catalog's safe default label.
- Produces: deterministic package photo rows and three bounded UTF-8 generated entries.
- Does not read storage, environment variables, credentials, or the network.

- [ ] **Step 1: Write failing archive-name and row-projection tests**

Define:

```ts
export type TimestampSource = "receipt" | "filename" | "upload";

export type PackagePhotoRow = {
  key: string;
  filename: string;
  archivePath: string;
  sizeBytes: number;
  uploadedAt: string;
  capturedAt: string;
  capturedAtEpochMs: number;
  timestampSource: TimestampSource;
  frameKey: string | "unknown";
  frameLabel: string | "unknown";
  captureSource: "framed" | "camera-fallback" | "unknown";
  hasReceipt: boolean;
};

export function preparePackageRows(
  sources: readonly ExportPhotoSource[],
  frameLabelFor: (frameKey: string) => string | undefined
): PackagePhotoRow[];
```

Test:

- A normal stable key becomes `photos/{source-filename}.jpg`.
- Unsafe/non-ASCII filename characters become `_`.
- Path separators, `.`/`..`, NUL, controls, and empty basenames never become
  archive traversal.
- Colliding sanitized basenames receive deterministic `-2`, `-3` suffixes
  before the extension.
- The complete original key remains available only as the manifest key.
- Receipt capture time wins with `timestampSource: "receipt"`.
- Missing receipt uses a valid leading 13-digit filename timestamp with
  `timestampSource: "filename"`.
- A key without a valid timestamp falls back to public upload time with
  `timestampSource: "upload"`.
- Missing source/Frame fields become the literal `"unknown"`.
- Unknown or removed Frame keys keep the key but use label `"unknown"`.

- [ ] **Step 2: Write failing CSV and HTML escaping tests**

Define:

```ts
export function escapeCsvCell(value: string | number): string;
export function escapeHtml(value: string): string;
export function buildManifestCsv(
  rows: readonly PackagePhotoRow[]
): string;
```

The exact manifest header is:

```text
key,filename,size_bytes,uploaded_at,captured_at,timestamp_source,frame_key,frame_label,capture_source
```

Test commas, quotes, CR/LF, tabs, Unicode, HTML metacharacters, and cells whose
first non-space character is `=`, `+`, `-`, or `@`. Formula-like cells must be
prefixed with a single apostrophe before RFC4180 quoting. Embedded quotes are
doubled. Output uses UTF-8 text and `\r\n` rows.

Define:

```ts
export function buildContactSheetHtml(input: {
  event: string;
  summary: ExportSummaryV1;
  rows: readonly PackagePhotoRow[];
}): string;
```

Test that the result:

- Starts with `<!doctype html>` and declares UTF-8.
- Contains inline screen/print CSS and no `<script>`, `<link>`, `<base>`,
  `@import`, inline event handler, `http:`, `https:`, or protocol-relative URL.
- References only each row's escaped relative `photos/...` path.
- Uses escaped Event, Frame label, filename, and caption text.
- Uses `<time datetime="<UTC ISO>">`.
- Is valid and useful for an empty Event.

- [ ] **Step 3: Write failing timezone summary tests**

Define:

```ts
export type ExportSummaryV1 = {
  version: 1;
  event: string;
  generatedAt: string;
  timeZone: string;
  timeZoneSource: "configured" | "utc-fallback";
  photoCount: number;
  totalBytes: number;
  metadataCoverage: {
    receipts: { known: number; unknown: number };
    frames: { known: number; unknown: number };
    sources: { known: number; unknown: number };
  };
  timestampSources: {
    receipt: number;
    filename: number;
    upload: number;
  };
  firstCaptureAt: string | null;
  lastCaptureAt: string | null;
  frameUsage: Array<{
    frameKey: string;
    frameLabel: string;
    count: number;
  }>;
  hourly: Array<{ period: string; count: number }>;
  busiestPeriods: Array<{ period: string; count: number }>;
};

export function buildExportSummary(input: {
  event: string;
  generatedAt: Date;
  configuredTimeZone?: string;
  rows: readonly PackagePhotoRow[];
}): ExportSummaryV1;

export function encodePackageArtifacts(input: {
  event: string;
  generatedAt: Date;
  configuredTimeZone?: string;
  rows: readonly PackagePhotoRow[];
}): {
  manifest: Uint8Array;
  summary: Uint8Array;
  contactSheet: Uint8Array;
};
```

Test:

- Empty summary uses zero counts, empty arrays, and `null` first/last times.
- `totalBytes` sums emitted bytes.
- Metadata coverage and timestamp-source counts add exactly to `photoCount`.
- Frame usage sorts by count descending, then Frame key ascending.
- First/last capture use capture timestamps rather than upload order.
- A valid configured IANA zone is retained.
- Missing and invalid configured zones use `UTC` and
  `timeZoneSource: "utc-fallback"`.
- Hour buckets include date, hour, and UTC offset so daylight-saving repeated
  wall-clock hours remain distinct.
- Hourly rows sort chronologically.
- Busiest periods are the top three non-empty hours sorted by count descending
  and then period ascending.
- `summary.json` is pretty-printed with a final newline and contains no
  undefined/raw receipt fields.

- [ ] **Step 4: Run focused tests and verify failures**

```bash
bun test app/export-package.test.ts
```

Expected: FAIL because the package projection and encoders do not exist.

- [ ] **Step 5: Implement deterministic safe row projection**

Use one `Set<string>` of emitted filenames to resolve collisions. Keep archive
paths ASCII so the existing ZIP flags remain valid. Capture timestamp
precedence is:

```text
valid exact receipt → valid 13-digit filename prefix → public upload time
```

Convert timestamps to UTC ISO strings. Do not infer source or Frame metadata
from the filename, config revision, index, or current Event configuration.

- [ ] **Step 6: Implement summary grouping and generated entries**

Use `Intl.DateTimeFormat("en-CA-u-nu-latn", ...)` with the validated Event
timezone, numeric year/month/day/hour, `hourCycle: "h23"`, and
`timeZoneName: "longOffset"`. Normalize UTC to `GMT+00:00`.

Render:

```text
manifest.csv
summary.json
contact-sheet.html
```

The HTML uses a responsive screen grid and a deterministic print grid with
page-break avoidance. Captions show filename, Frame label, and localized
hour-period label without including the complete storage key.

- [ ] **Step 7: Run focused and full checks**

```bash
bun test app/export-package.test.ts
bun run typecheck
bun run typecheck:tests
bun test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/export-package.ts app/export-package.test.ts
git commit -m "feat: build bounded event package artifacts"
```

### Task 3: Stream legacy and enriched ZIPs through a strict Admin boundary

**Files:**
- Modify: `app/zip.ts`
- Modify: `app/zip.test.ts`
- Create: `app/export-stream.ts`
- Create: `app/export-stream.test.ts`
- Create: `app/api/export/handlers.ts`
- Create: `app/api/export/handlers.test.ts`
- Modify: `app/api/export/route.ts`

**Interfaces:**
- Consumes: Task 1 inventory, Task 2 encoders, current ZIP central-directory primitives, `adminOk()`, and `canonicalEvent()`.
- Produces: a thin dependency-injected export handler and one-photo-at-a-time ZIP streams.
- Preserves: the existing legacy URL, authorization, content type, filename, and root photo layout.

- [ ] **Step 1: Write failing non-copying ZIP primitive tests**

Add:

```ts
export function storedEntryHeader(
  name: Uint8Array,
  data: Uint8Array
): {
  header: Uint8Array;
  crc: number;
  size: number;
};

export function estimateStoreZipBytes(
  entries: readonly { nameBytes: number; dataBytes: number }[]
): number;
```

Test:

- `storedEntryHeader()` returns only the 30-byte local header plus name, not a
  second copy of data.
- Header CRC and size describe the separately enqueued data.
- Existing `localPart()` remains byte-compatible by concatenating the new
  header and data.
- `estimateStoreZipBytes()` exactly includes every local header, filename,
  data body, central record, central filename, and the 22-byte EOCD.
- Unicode byte lengths use encoded bytes, not JavaScript string length.
- The existing two-entry structural ZIP test still passes.

- [ ] **Step 2: Write failing stream and deletion-race tests**

Define:

```ts
export const MAX_ZIP_ENTRIES = 0xffff;
export const MAX_ZIP_BYTES = 3_900_000_000;
export const MAX_GENERATED_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_GENERATED_TOTAL_BYTES = 16 * 1024 * 1024;

export class ExportTooLargeError extends Error {
  constructor(
    readonly reason:
      | "entry_count"
      | "zip_bytes"
      | "generated_entry"
      | "generated_total"
  );
}

export type ExportStreamDeps = {
  store: EventStore;
  frameLabelFor: (frameKey: string) => string | undefined;
  now: () => Date;
};

export async function preparePhotoOnlyExport(
  event: string,
  deps: ExportStreamDeps
): Promise<ReadableStream<Uint8Array>>;

export async function preparePackageExport(
  event: string,
  configuredTimeZone: string | undefined,
  deps: ExportStreamDeps
): Promise<ReadableStream<Uint8Array>>;
```

Use a small test-only STORE ZIP reader and test:

- Photo-only entries remain root `{basename}` entries with no generated files.
- Photo-only export never calls `STATE` or `readConfig()`.
- Package entries are `photos/...`, `manifest.csv`, `summary.json`, and
  `contact-sheet.html`.
- Each public body finishes reading before the next body begins.
- Header and data are enqueued separately.
- A photo returning `null` from `getPhoto()` after preflight is absent from
  photos, manifest, summary counts, analytics, and contact sheet.
- A photo deleted after its body is returned remains consistently present.
- New photos arriving after the preflight inventory are left for the next
  export rather than partially joining the snapshot.
- Generated entries are last, followed by one correct central directory.
- A missing receipt exports `unknown` metadata.
- No private key prefix or raw receipt-only field occurs anywhere in the ZIP.
- Empty legacy and enriched archives are structurally valid.

- [ ] **Step 3: Write failing size-limit tests**

Preflight must reject before returning a stream when:

- Photo-only entries exceed `65_535`.
- Package photos plus three generated entries exceed `65_535`.
- Estimated ZIP bytes exceed `3_900_000_000`.
- Any generated entry exceeds `8 MiB`.
- Generated entries together exceed `16 MiB`.

Boundary-equal values pass. Use metadata-sized fakes; do not allocate multi-GB
buffers.

The enriched builder encodes a full-inventory candidate before returning the
stream to prove generated limits. During streaming it tracks only successfully
emitted rows and regenerates final artifacts from that subset. Removing rows
cannot increase the preflight candidate beyond the established limit.

- [ ] **Step 4: Write failing HTTP compatibility and privacy tests**

Define:

```ts
export type ExportHandlerDeps = ExportStreamDeps & {
  adminKey?: string;
};

export async function handleExport(
  req: NextRequest,
  deps: ExportHandlerDeps
): Promise<NextResponse>;
```

Accepted query shapes:

```text
GET /api/export?event=launch
GET /api/export?event=launch&format=package&contactSheet=1
```

Test:

- Missing Admin secret returns `503` before any store read.
- Wrong key and a valid Event Booth Key return `401` before any store read.
- Canonical aliases and invalid Event values return `400`.
- `format=package` without `contactSheet=1`, `contactSheet=1` without package,
  duplicate values, and unknown format values return `400`.
- Legacy success returns `application/zip` and
  `attachment; filename="launch-photos.zip"`.
- Enriched success returns `application/zip` and
  `attachment; filename="launch-package.zip"`.
- Both responses set `Cache-Control: private, no-store` and
  `X-Content-Type-Options: nosniff`.
- `ExportTooLargeError` maps to a generic `413`.
- `InvalidPhotoReceiptError` maps to a generic `422` without key/receipt data.
- Private metadata-store unavailability maps to a generic retryable `503`.
- No error response includes a credential, receipt key, index key, or raw
  private exception string.

- [ ] **Step 5: Run focused tests and verify failures**

```bash
bun test app/zip.test.ts app/export-stream.test.ts \
  app/api/export/handlers.test.ts
```

Expected: FAIL because the split ZIP primitive, streams, and handler do not exist.

- [ ] **Step 6: Implement exact preflight and one-photo streaming**

Preflight inventory keeps only small descriptors and package rows, never photo
bytes. Include exact local-header and central-directory overhead in the
projected ZIP size.

The stream pull sequence is:

```text
get exact photo → skip if missing → enqueue header → enqueue photo bytes
→ record emitted row → next photo
→ encode generated files from emitted rows → enqueue generated entries
→ enqueue central directory → enqueue EOCD → close
```

Keep `centralPart()` records bounded in memory. Never `Promise.all()` photo
bodies and never concatenate all output.

- [ ] **Step 7: Implement the dependency-injected handler and thin route**

`handleExport()` authenticates first, validates query/Event input, calls only
the selected stream builder, and constructs the response. `route.ts` only
obtains Cloudflare bindings, creates `EventStore`, provides the Frame-label
lookup and clock, then delegates.

Package mode reads the current Event config only for `timeZone`. It constructs
no other config fields into the package. Missing/invalid timezone uses the
Task 2 UTC fallback.

- [ ] **Step 8: Run focused and full checks**

```bash
bun test app/zip.test.ts app/export-stream.test.ts \
  app/api/export/handlers.test.ts app/event-store.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/zip.ts app/zip.test.ts \
  app/export-stream.ts app/export-stream.test.ts \
  app/api/export/handlers.ts app/api/export/handlers.test.ts \
  app/api/export/route.ts
git commit -m "feat: stream enriched event exports"
```

### Task 4: Add the localized Admin post-event export panel

**Files:**
- Create: `app/[event]/admin/export-client.ts`
- Create: `app/[event]/admin/export-client.test.ts`
- Create: `app/[event]/admin/export-panel.tsx`
- Create: `app/[event]/admin/export-panel.test.tsx`
- Modify: `app/[event]/admin/page.tsx`
- Modify: `app/[event]/admin/admin.module.css`
- Modify: `app/i18n/catalog.ts`
- Modify: `app/i18n/catalog.test.ts`

**Interfaces:**
- Consumes: Task 3 exact legacy/enriched HTTP contracts and the existing Admin authentication invalidation callback.
- Produces: one accessible export panel with a streamed desktop path and bounded browser fallback.
- Preserves: the existing File System Access API optimization.

- [ ] **Step 1: Write failing pure export-request tests**

Define:

```ts
export type AdminExportMode = "package" | "photos";

export type AdminExportRequest = {
  url: string;
  suggestedName: string;
  headers: { "x-booth-key": string };
};

export function adminExportRequest(input: {
  event: string;
  adminKey: string;
  mode: AdminExportMode;
}): AdminExportRequest;
```

Test:

```ts
expect(adminExportRequest({
  event: "launch",
  adminKey: "secret",
  mode: "package",
})).toEqual({
  url: "/api/export?event=launch&format=package&contactSheet=1",
  suggestedName: "launch-package.zip",
  headers: { "x-booth-key": "secret" },
});
```

Photo mode uses `/api/export?event=launch` and `launch-photos.zip`. The secret
must appear only in the header object, never URL or filename.

- [ ] **Step 2: Write failing panel markup and state tests**

Define:

```ts
export type ExportPanelProps = {
  event: string;
  adminKey: string;
  locale: SupportedLocale;
  onUnauthorized: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

export function ExportPanel(props: ExportPanelProps): JSX.Element;
```

Test:

- A heading and description explain manifest, analytics, and printable sheet.
- The primary action is “Download event package”.
- The secondary action is “Download photos only”.
- No loaded moderation/page count is described as the Event total.
- One active mode disables both actions and exposes a polite busy status.
- `401` invokes `onUnauthorized`.
- `413` reports the single-ZIP size limit and recommends photos-only or
  operator-assisted splitting rather than destructive deletion.
- `422` reports invalid stored metadata and recommends photos-only plus
  operator investigation.
- `503` reports temporary export unavailability and preserves retry.
- Generic failures do not render raw server exception text.
- The Admin Key never occurs in markup, error copy, an anchor URL, or local
  storage.
- Keyboard semantics, visible focus, high contrast, and large text remain usable.

- [ ] **Step 3: Run focused tests and verify failures**

```bash
bun test 'app/[event]/admin/export-client.test.ts' \
  'app/[event]/admin/export-panel.test.tsx' \
  app/i18n/catalog.test.ts
```

Expected: FAIL because the client helper, panel, and messages do not exist.

- [ ] **Step 4: Implement direct-to-disk download with a fallback**

For each click:

1. Build the pure request.
2. Call `showSaveFilePicker()` during the click's user activation when
   available.
3. Fetch with the Admin header.
4. Pipe `response.body` to the chosen writable without building a giant Blob.
5. Otherwise use the existing Blob/object-URL download fallback.
6. Revoke fallback object URLs.
7. Treat picker `AbortError` as cancellation, not failure.

Show localized copy that large archives are best downloaded from a desktop
browser with direct-to-disk support. Do not add a service worker or third-party
stream-saver dependency.

- [ ] **Step 5: Integrate the panel and complete catalogs**

Replace the old `Export ${photos.length} photos (.zip)` action. Keep config,
Booth operations, moderation, presets, rehearsals, health, and navigation
usable when export fails.

Add every new export key to `en`, `zh-SG`, and `ar`, with exact key and
placeholder parity. Follow current Admin direction handling.

- [ ] **Step 6: Run focused and full checks**

```bash
bun test 'app/[event]/admin/export-client.test.ts' \
  'app/[event]/admin/export-panel.test.tsx' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add 'app/[event]/admin/export-client.ts' \
  'app/[event]/admin/export-client.test.ts' \
  'app/[event]/admin/export-panel.tsx' \
  'app/[event]/admin/export-panel.test.tsx' \
  'app/[event]/admin/page.tsx' \
  'app/[event]/admin/admin.module.css' \
  app/i18n/catalog.ts app/i18n/catalog.test.ts
git commit -m "feat: add admin post-event package export"
```

### Task 5: Verify the complete Release 5 story and document operations

**Files:**
- Create: `tests/post-event-package.spec.ts`
- Modify: `docs/runbooks/pre-event-readiness.md`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Consumes: Tasks 1–4 and the existing WebKit/browser accessibility harness.
- Produces: release-level compatibility, privacy, download, offline, print, and staging gates.

- [ ] **Step 1: Add a failing WebKit Admin download journey**

Use a canonical throwaway Event and route interception. Verify:

- Admin unlock remains keyboard-operable.
- Package click sends the exact enriched query and Admin header.
- Photos-only click sends the legacy query.
- Neither URL nor suggested filename contains the Admin Key.
- The correct package/photo filename is offered.
- Busy status is announced and both actions are disabled during one download.
- `401`, `413`, `422`, and `503` render their localized actionable states.
- Retrying after a retryable failure works.
- Automated accessibility checks report no serious/critical violations.

- [ ] **Step 2: Add deterministic archive contract fixtures**

Exercise a fixture containing:

- A stable framed photo with complete receipt.
- A camera-fallback photo.
- A legacy photo with no receipt.
- An unknown historical Frame.
- A malicious formula/HTML-like key or Frame label at the pure serialization
  boundary.
- A photo that disappears between inventory and body fetch.
- Capture times spanning local midnight and a daylight-saving offset change.

Assert the ZIP entry list, manifest cells, summary counts, timezone buckets,
contact-sheet relative sources, and absence of every private operational field.

- [ ] **Step 3: Run the browser test and verify the initial failure**

```bash
bun run test:browser -- tests/post-event-package.spec.ts
```

Expected: FAIL until the complete Admin/export integration is wired into the
browser harness.

- [ ] **Step 4: Update the pre-event readiness runbook**

Add exact checks:

1. Export legacy photo-only ZIP and verify root photo entries.
2. Export the enriched package and verify its four sections.
3. Run `unzip -t <event>-package.zip`.
4. Open extracted `contact-sheet.html` with networking disabled.
5. Confirm all package images load through relative paths.
6. Open print preview and inspect grid/page breaks.
7. Import `manifest.csv` into a spreadsheet and confirm formula-looking cells
   remain text.
8. Compare configured timezone, first/last capture, hourly, busiest-period,
   Frame, byte, and metadata-coverage totals against the fixture.
9. Confirm a deleted exact photo appears nowhere.
10. Search the extracted package for receipt/index prefixes, revision IDs,
    Booth records, rehearsal evidence, health state, and credential material.

- [ ] **Step 5: Update the deployment runbook**

Add a Release 5 staging gate using a throwaway Event distinct from production.
Upload stable and legacy canaries, export both modes, delete only the
designated canary by complete key, and confirm staging/production isolation.

Document:

- `413` means the single STORE ZIP/Worker safety limit, not permission to
  delete stored photos.
- `422` means private metadata needs investigation; photo-only export remains
  available.
- `503` is retryable private/export infrastructure unavailability.
- Do not test large-event limits by filling production storage.
- Rollback changes Worker code only and never deletes `PHOTOS` or `STATE`.

- [ ] **Step 6: Run the complete automated gate**

```bash
bun test app/photo-metadata.test.ts app/export-package.test.ts \
  app/zip.test.ts app/export-stream.test.ts \
  app/api/export/handlers.test.ts app/event-store.test.ts \
  'app/[event]/admin/export-client.test.ts' \
  'app/[event]/admin/export-panel.test.tsx' \
  app/i18n/catalog.test.ts
bun run typecheck
bun run typecheck:tests
bun test
bun run validate:frames
bun run build
bun run test:browser -- tests/post-event-package.spec.ts
```

Expected: every command exits 0.

- [ ] **Step 7: Perform required staging/manual validation**

Automated tests cannot certify:

- Real Cloudflare R2 paging/read behavior during a long streaming response.
- The browser's native file picker and direct-to-disk writable implementation.
- Spreadsheet import behavior across Excel, Numbers, and Google Sheets.
- Offline extracted-file behavior under desktop browser security policies.
- Print layout across the operator's actual paper size/printer.

On staging:

1. Create a throwaway canonical Event with a configured timezone.
2. Add stable framed, stable fallback, and legacy/missing-receipt photos.
3. Export the legacy ZIP and confirm its existing root layout.
4. Export the enriched package and run `unzip -t`.
5. Delete one designated canary by its complete Event-owned key, export again,
   and confirm it is absent from all four package sections.
6. Open the contact sheet offline and in print preview.
7. Import the manifest and inspect formula-like fixture cells as text.
8. Check summary totals and timezone buckets manually.
9. Confirm `STATE` remains private and no operational record is packaged.
10. Confirm staging export never returns production photos.

No real camera or iPad is required for Release 5 correctness. Desktop native
download, offline HTML, spreadsheet import, printing, and production-like R2
streaming require manual checks.

- [ ] **Step 8: Commit**

```bash
git add tests/post-event-package.spec.ts \
  docs/runbooks/pre-event-readiness.md docs/runbooks/deployment.md
git commit -m "test: verify post-event package release"
```

## Release 5 Completion Gate

Release 5 is complete only when:

- Every task review is clean.
- The full automated gate passes.
- Legacy `/api/export?event=` remains Admin-only, root-photo-only, and
  independent of `STATE` and Event config.
- Enriched mode accepts only
  `format=package&contactSheet=1` and contains the exact expected four sections.
- Booth credentials cannot authorize either export.
- Current `PHOTOS` is the source of truth; missing receipts become `unknown`
  and deleted photos are excluded.
- Corrupt/future/wrong-key receipts fail before streaming without exposing
  private data.
- Every manifest cell and HTML interpolation is safely escaped, including
  spreadsheet-formula prefixes.
- Summary counts, bytes, metadata coverage, Frame usage, first/last capture,
  hourly buckets, and busiest periods are deterministic in the configured
  timezone with explicit UTC fallback.
- Contact HTML is printable, offline, relative-path-only, inline-CSS-only,
  JavaScript-free, and external-request-free.
- Streaming holds at most one photo body and never concatenates all JPEGs.
- The 65,535-entry, 3.9 GB ZIP, 8 MiB per-generated-entry, and 16 MiB
  generated-total limits reject before response streaming.
- A mid-export deletion cannot leave a photo in manifest, summary, or contact
  sheet after its image entry is skipped.
- No receipt, index, revision, Booth, rehearsal, health, credential, or
  private storage key appears in any response or archive entry.
- Admin offers localized package and photo-only downloads, preserves
  direct-to-disk streaming when supported, and provides actionable bounded
  fallback/error states.
- Staging verifies legacy compatibility, enriched structure, one exact
  deletion, offline/print/spreadsheet output, timezone analytics, private-state
  isolation, and staging/production isolation.
