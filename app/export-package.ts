import type { ExportPhotoSource } from "./event-store";

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

const MAX_ARCHIVE_FILENAME_LENGTH = 160;

function validEpoch13(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1_000_000_000_000
    && value <= 9_999_999_999_999;
}

function originalBasename(key: string): string {
  return key.split("/").at(-1) ?? "";
}

function sanitizeFilename(value: string): string {
  let safe = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (safe === "" || safe === "." || safe === "..") safe = "photo";
  if (safe.length > MAX_ARCHIVE_FILENAME_LENGTH) {
    const dot = safe.lastIndexOf(".");
    const extension = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : "";
    safe = `${safe.slice(0, MAX_ARCHIVE_FILENAME_LENGTH - extension.length)}${extension}`;
  }
  return safe;
}

function uniqueFilename(candidate: string, emitted: Set<string>): string {
  const collisionKey = candidate.toLowerCase();
  if (!emitted.has(collisionKey)) {
    emitted.add(collisionKey);
    return candidate;
  }
  const dot = candidate.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? candidate.slice(0, dot) : candidate;
  const extension = hasExtension ? candidate.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`;
    const stemLength = MAX_ARCHIVE_FILENAME_LENGTH
      - suffixText.length
      - extension.length;
    const next = `${stem.slice(0, Math.max(1, stemLength))}${suffixText}${extension}`;
    const nextKey = next.toLowerCase();
    if (!emitted.has(nextKey)) {
      emitted.add(nextKey);
      return next;
    }
  }
}

function filenameTimestamp(filename: string): number | null {
  const match = /^(\d{13})(?=[^0-9]|$)/.exec(filename);
  if (!match) return null;
  const value = Number(match[1]);
  return validEpoch13(value) && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

export function preparePackageRows(
  sources: readonly ExportPhotoSource[],
  frameLabelFor: (frameKey: string) => string | undefined,
): PackagePhotoRow[] {
  const emitted = new Set<string>();
  return sources.map((source) => {
    const original = originalBasename(source.key);
    const filename = uniqueFilename(sanitizeFilename(original), emitted);
    const receiptTimestamp = source.receipt?.capturedAt;
    const fromFilename = filenameTimestamp(original);
    let capturedAtEpochMs: number;
    let timestampSource: TimestampSource;
    if (validEpoch13(receiptTimestamp)) {
      capturedAtEpochMs = receiptTimestamp;
      timestampSource = "receipt";
    } else if (fromFilename !== null) {
      capturedAtEpochMs = fromFilename;
      timestampSource = "filename";
    } else {
      capturedAtEpochMs = Date.parse(source.uploadedAt);
      if (!Number.isFinite(capturedAtEpochMs)) {
        throw new TypeError(`invalid public upload timestamp for ${source.key}`);
      }
      timestampSource = "upload";
    }
    const receiptFrame = source.receipt?.frameKey;
    const frameKey = receiptFrame ?? "unknown";
    const frameLabel =
      receiptFrame === undefined ? "unknown" : frameLabelFor(receiptFrame) ?? "unknown";
    return {
      key: source.key,
      filename,
      archivePath: `photos/${filename}`,
      sizeBytes: source.size,
      uploadedAt: new Date(source.uploadedAt).toISOString(),
      capturedAt: new Date(capturedAtEpochMs).toISOString(),
      capturedAtEpochMs,
      timestampSource,
      frameKey,
      frameLabel,
      captureSource: source.receipt?.source ?? "unknown",
      hasReceipt: source.receipt !== null,
    };
  });
}

export function escapeCsvCell(value: string | number): string {
  const original = String(value);
  const formulaLike = /^\s*[=+\-@]/u.test(original);
  const safe = formulaLike ? `'${original}` : original;
  const quote = /[",\r\n\t]/u.test(safe)
    || /^\s|\s$/u.test(original)
    || formulaLike && /^\s/u.test(original);
  return quote ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MANIFEST_COLUMNS = [
  "key",
  "filename",
  "size_bytes",
  "uploaded_at",
  "captured_at",
  "timestamp_source",
  "frame_key",
  "frame_label",
  "capture_source",
] as const;

export function buildManifestCsv(rows: readonly PackagePhotoRow[]): string {
  const lines = [MANIFEST_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      row.key,
      row.filename,
      row.sizeBytes,
      row.uploadedAt,
      row.capturedAt,
      row.timestampSource,
      row.frameKey,
      row.frameLabel,
      row.captureSource,
    ].map(escapeCsvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function validTimeZone(configured?: string): {
  timeZone: string;
  timeZoneSource: ExportSummaryV1["timeZoneSource"];
} {
  if (configured) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: configured }).format(0);
      return { timeZone: configured, timeZoneSource: "configured" };
    } catch {
      // Fall through to the deterministic safe default.
    }
  }
  return { timeZone: "UTC", timeZoneSource: "utc-fallback" };
}

function normalizeOffset(value: string): string {
  if (value === "GMT" || value === "UTC") return "GMT+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (!match) return value;
  return `GMT${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`;
}

function hourlyPeriod(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA-u-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(epochMs);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:00 ${normalizeOffset(part("timeZoneName"))}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildExportSummary(input: {
  event: string;
  generatedAt: Date;
  configuredTimeZone?: string;
  rows: readonly PackagePhotoRow[];
}): ExportSummaryV1 {
  const { timeZone, timeZoneSource } = validTimeZone(input.configuredTimeZone);
  const timestampSources = { receipt: 0, filename: 0, upload: 0 };
  const frameCounts = new Map<string, { frameLabel: string; count: number }>();
  const hourCounts = new Map<string, { count: number; firstEpoch: number }>();
  let receiptKnown = 0;
  let frameKnown = 0;
  let sourceKnown = 0;
  let totalBytes = 0;
  let firstEpoch = Number.POSITIVE_INFINITY;
  let lastEpoch = Number.NEGATIVE_INFINITY;

  for (const row of input.rows) {
    totalBytes += row.sizeBytes;
    timestampSources[row.timestampSource] += 1;
    if (row.hasReceipt) receiptKnown += 1;
    if (row.frameKey !== "unknown") {
      frameKnown += 1;
      const current = frameCounts.get(row.frameKey);
      frameCounts.set(row.frameKey, {
        frameLabel: row.frameLabel,
        count: (current?.count ?? 0) + 1,
      });
    }
    if (row.captureSource !== "unknown") sourceKnown += 1;
    firstEpoch = Math.min(firstEpoch, row.capturedAtEpochMs);
    lastEpoch = Math.max(lastEpoch, row.capturedAtEpochMs);
    const period = hourlyPeriod(row.capturedAtEpochMs, timeZone);
    const currentHour = hourCounts.get(period);
    hourCounts.set(period, {
      count: (currentHour?.count ?? 0) + 1,
      firstEpoch: Math.min(currentHour?.firstEpoch ?? row.capturedAtEpochMs, row.capturedAtEpochMs),
    });
  }

  const hourly = [...hourCounts.entries()]
    .sort((left, right) => left[1].firstEpoch - right[1].firstEpoch)
    .map(([period, value]) => ({ period, count: value.count }));
  const busiestPeriods = [...hourly]
    .sort((left, right) => right.count - left.count || compareText(left.period, right.period))
    .slice(0, 3);
  const frameUsage = [...frameCounts.entries()]
    .map(([frameKey, value]) => ({ frameKey, frameLabel: value.frameLabel, count: value.count }))
    .sort((left, right) => right.count - left.count || compareText(left.frameKey, right.frameKey));
  const photoCount = input.rows.length;
  return {
    version: 1,
    event: input.event,
    generatedAt: input.generatedAt.toISOString(),
    timeZone,
    timeZoneSource,
    photoCount,
    totalBytes,
    metadataCoverage: {
      receipts: { known: receiptKnown, unknown: photoCount - receiptKnown },
      frames: { known: frameKnown, unknown: photoCount - frameKnown },
      sources: { known: sourceKnown, unknown: photoCount - sourceKnown },
    },
    timestampSources,
    firstCaptureAt: photoCount === 0 ? null : new Date(firstEpoch).toISOString(),
    lastCaptureAt: photoCount === 0 ? null : new Date(lastEpoch).toISOString(),
    frameUsage,
    hourly,
    busiestPeriods,
  };
}

export function buildContactSheetHtml(input: {
  event: string;
  summary: ExportSummaryV1;
  rows: readonly PackagePhotoRow[];
}): string {
  const cards = input.rows.map((row) => {
    const period = hourlyPeriod(row.capturedAtEpochMs, input.summary.timeZone);
    return `<figure>
<img src="${escapeHtml(row.archivePath)}" alt="${escapeHtml(row.filename)}" loading="lazy">
<figcaption><strong>${escapeHtml(row.filename)}</strong><span>${escapeHtml(row.frameLabel)}</span><time datetime="${escapeHtml(row.capturedAt)}">${escapeHtml(period)}</time></figcaption>
</figure>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.event)} photo contact sheet</title>
<style>
:root{font-family:system-ui,sans-serif;color:#171717;background:#fff}body{margin:0;padding:24px}h1{margin:0 0 4px}.summary{margin:0 0 24px;color:#555}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}figure{margin:0;border:1px solid #bbb;border-radius:8px;overflow:hidden;break-inside:avoid}img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#eee}figcaption{display:grid;gap:3px;padding:10px;overflow-wrap:anywhere}figcaption span,time{font-size:.85rem;color:#555}@media print{body{padding:0}.grid{grid-template-columns:repeat(3,1fr);gap:8mm}figure{border-color:#777;border-radius:0}img{max-height:65mm}}
</style>
</head>
<body>
<h1>${escapeHtml(input.event)}</h1>
<p class="summary">${input.summary.photoCount} photos · ${input.summary.totalBytes} bytes · ${escapeHtml(input.summary.timeZone)}</p>
<main class="grid">${cards}</main>
</body>
</html>
`;
}

export function encodePackageArtifacts(input: {
  event: string;
  generatedAt: Date;
  configuredTimeZone?: string;
  rows: readonly PackagePhotoRow[];
}): {
  manifest: Uint8Array;
  summary: Uint8Array;
  contactSheet: Uint8Array;
} {
  const summary = buildExportSummary(input);
  const encoder = new TextEncoder();
  return {
    manifest: encoder.encode(buildManifestCsv(input.rows)),
    summary: encoder.encode(`${JSON.stringify(summary, null, 2)}\n`),
    contactSheet: encoder.encode(
      buildContactSheetHtml({ event: input.event, summary, rows: input.rows }),
    ),
  };
}
