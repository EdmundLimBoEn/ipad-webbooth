import { describe, expect, test } from "bun:test";
import type { ExportPhotoSource } from "./event-store";
import {
  buildContactSheetHtml,
  buildExportSummary,
  buildManifestCsv,
  encodePackageArtifacts,
  escapeCsvCell,
  escapeHtml,
  preparePackageRows,
} from "./export-package";

function source(
  key: string,
  patch: Partial<ExportPhotoSource> = {},
): ExportPhotoSource {
  return {
    key,
    size: 10,
    uploadedAt: "2026-07-24T00:00:00.000Z",
    receipt: null,
    ...patch,
  };
}

describe("event package rows", () => {
  test("uses safe deterministic archive names and suffixes collisions", () => {
    const rows = preparePackageRows([
      source("launch/1753315200000-normal.jpg"),
      source("launch/1753315200001-a b🔥.jpg"),
      source("launch/other/a?b.jpg"),
      source("launch/more/a*b.jpg"),
      source("launch/.."),
      source("launch/\0.jpg"),
    ], () => undefined);

    expect(rows.map(({ archivePath }) => archivePath)).toEqual([
      "photos/1753315200000-normal.jpg",
      "photos/1753315200001-a_b_.jpg",
      "photos/a_b.jpg",
      "photos/a_b-2.jpg",
      "photos/photo",
      "photos/_.jpg",
    ]);
    expect(rows[0]?.key).toBe("launch/1753315200000-normal.jpg");
  });

  test("keeps collision suffixes inside the archive filename limit", () => {
    const filename = `${"a".repeat(156)}.jpg`;
    const rows = preparePackageRows([
      source(`launch/${filename}`),
      source(`launch/duplicate/${filename}`),
    ], () => undefined);

    expect(rows[0]!.filename).toHaveLength(160);
    expect(rows[1]!.filename).toHaveLength(160);
    expect(rows[1]!.filename).toBe(`${"a".repeat(154)}-2.jpg`);
  });

  test("does not treat a long dotted suffix as an unbounded extension", () => {
    const filename = `a.${"b".repeat(158)}`;
    const rows = preparePackageRows([
      source(`launch/${filename}`),
      source(`launch/duplicate/${filename}`),
    ], () => undefined);

    expect(rows.map(({ filename: value }) => value.length)).toEqual([160, 160]);
    expect(rows[1]!.filename).toEndWith("-2");
  });

  test("resolves a large normalized collision group with bounded membership probes", () => {
    const originalHas = Set.prototype.has;
    let membershipProbes = 0;
    Set.prototype.has = function (value) {
      membershipProbes += 1;
      return originalHas.call(this, value);
    };

    try {
      const rows = preparePackageRows(
        Array.from({ length: 1_024 }, (_, index) =>
          source(`launch/${index}/${index % 2 === 0 ? "a?b.jpg" : "A*b.JPG"}`)),
        () => undefined,
      );

      expect(rows[0]!.filename).toBe("a_b.jpg");
      expect(rows[1]!.filename).toBe("A_b-2.JPG");
      expect(rows.at(-1)!.filename).toBe("A_b-1024.JPG");
      expect(new Set(rows.map(({ filename }) => filename.toLowerCase())).size).toBe(
        rows.length,
      );
      expect(membershipProbes).toBeLessThan(5_000);
    } finally {
      Set.prototype.has = originalHas;
    }
  });

  test("uses receipt, filename, then upload timestamps and allowlisted metadata", () => {
    const rows = preparePackageRows([
      source("launch/1753315200000-first.jpg", {
        receipt: { capturedAt: 1753315100000, source: "framed", frameKey: "square" },
      }),
      source("launch/1753315200001-second.jpg"),
      source("launch/no-time.jpg", {
        uploadedAt: "2026-07-24T02:00:00.000Z",
        receipt: { capturedAt: 1753315100002 },
      }),
      source("launch/no-receipt-time.jpg", {
        uploadedAt: "2026-07-24T03:00:00.000Z",
      }),
    ], (frameKey) => frameKey === "square" ? "Square Frame" : undefined);

    expect(rows[0]).toMatchObject({
      capturedAtEpochMs: 1753315100000,
      timestampSource: "receipt",
      frameKey: "square",
      frameLabel: "Square Frame",
      captureSource: "framed",
      hasReceipt: true,
    });
    expect(rows[1]).toMatchObject({
      capturedAtEpochMs: 1753315200001,
      timestampSource: "filename",
      frameKey: "unknown",
      captureSource: "unknown",
      hasReceipt: false,
    });
    expect(rows[2]).toMatchObject({
      timestampSource: "receipt",
      frameKey: "unknown",
      frameLabel: "unknown",
      captureSource: "unknown",
    });
    expect(rows[3]).toMatchObject({
      capturedAt: "2026-07-24T03:00:00.000Z",
      timestampSource: "upload",
    });
  });
});

describe("event package escaping", () => {
  test("escapes CSV injection, quotes, commas, controls, and Unicode", () => {
    expect(escapeCsvCell(" =SUM(A1:A2)")).toBe("\"' =SUM(A1:A2)\"");
    expect(escapeCsvCell("+cmd")).toBe("'+cmd");
    expect(escapeCsvCell("-1")).toBe("'-1");
    expect(escapeCsvCell("@name")).toBe("'@name");
    expect(escapeCsvCell("a,\"b\"\r\n雪")).toBe("\"a,\"\"b\"\"\r\n雪\"");
    expect(escapeCsvCell(42)).toBe("42");
  });

  test("builds the exact RFC4180 manifest shape", () => {
    const row = preparePackageRows([
      source("launch/1753315200000-photo.jpg"),
    ], () => undefined)[0]!;
    const csv = buildManifestCsv([row]);
    expect(csv.startsWith(
      "key,filename,size_bytes,uploaded_at,captured_at,timestamp_source,frame_key,frame_label,capture_source\r\n",
    )).toBeTrue();
    expect(csv.endsWith("\r\n")).toBeTrue();
  });

  test("escapes HTML and emits a self-contained relative-only contact sheet", () => {
    expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#39;");
    const rows = preparePackageRows([
      source("launch/1753315200000-<photo>.jpg", {
        receipt: { capturedAt: 1753315200000, frameKey: "square" },
      }),
    ], () => "<Square & Frame>");
    const summary = buildExportSummary({
      event: "<Launch>",
      generatedAt: new Date("2026-07-24T04:00:00.000Z"),
      configuredTimeZone: "Asia/Singapore",
      rows,
    });
    const html = buildContactSheetHtml({ event: "<Launch>", summary, rows });
    expect(html.startsWith("<!doctype html>")).toBeTrue();
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("@media print");
    expect(html).toContain(rows[0]!.archivePath);
    expect(html).toContain("&lt;Launch&gt;");
    expect(html).toContain("&lt;Square &amp; Frame&gt;");
    expect(html).toContain(`<time datetime="${rows[0]!.capturedAt}">`);
    for (const forbidden of [
      "<script",
      "<link",
      "<base",
      "@import",
      "onclick=",
      "http:",
      "https:",
      'src="//',
      rows[0]!.key,
    ]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    const empty = buildContactSheetHtml({
      event: "empty",
      summary: buildExportSummary({
        event: "empty",
        generatedAt: new Date("2026-07-24T04:00:00.000Z"),
        rows: [],
      }),
      rows: [],
    });
    expect(empty).toContain("0 photos");
  });
});

describe("event package summary", () => {
  test("builds exact empty summary and falls back from an invalid timezone", () => {
    expect(buildExportSummary({
      event: "launch",
      generatedAt: new Date("2026-07-24T04:00:00.000Z"),
      configuredTimeZone: "Not/AZone",
      rows: [],
    })).toEqual({
      version: 1,
      event: "launch",
      generatedAt: "2026-07-24T04:00:00.000Z",
      timeZone: "UTC",
      timeZoneSource: "utc-fallback",
      photoCount: 0,
      totalBytes: 0,
      metadataCoverage: {
        receipts: { known: 0, unknown: 0 },
        frames: { known: 0, unknown: 0 },
        sources: { known: 0, unknown: 0 },
      },
      timestampSources: { receipt: 0, filename: 0, upload: 0 },
      firstCaptureAt: null,
      lastCaptureAt: null,
      frameUsage: [],
      hourly: [],
      busiestPeriods: [],
    });
  });

  test("groups timezone hours, coverage, frame use, and chronological bounds", () => {
    const rows = preparePackageRows([
      source("launch/1730611800000-one.jpg", {
        size: 4,
        receipt: { capturedAt: 1730611800000, source: "framed", frameKey: "square" },
      }),
      source("launch/1730615400000-two.jpg", {
        size: 6,
        receipt: { capturedAt: 1730615400000, source: "framed", frameKey: "square" },
      }),
      source("launch/no-time.jpg", {
        size: 2,
        uploadedAt: "2024-11-03T07:30:00.000Z",
      }),
    ], (key) => key === "square" ? "Square" : undefined);
    const summary = buildExportSummary({
      event: "launch",
      generatedAt: new Date("2026-07-24T04:00:00.000Z"),
      configuredTimeZone: "America/New_York",
      rows,
    });

    expect(summary).toMatchObject({
      timeZone: "America/New_York",
      timeZoneSource: "configured",
      photoCount: 3,
      totalBytes: 12,
      metadataCoverage: {
        receipts: { known: 2, unknown: 1 },
        frames: { known: 2, unknown: 1 },
        sources: { known: 2, unknown: 1 },
      },
      timestampSources: { receipt: 2, filename: 0, upload: 1 },
      firstCaptureAt: "2024-11-03T05:30:00.000Z",
      lastCaptureAt: "2024-11-03T07:30:00.000Z",
      frameUsage: [{ frameKey: "square", frameLabel: "Square", count: 2 }],
    });
    expect(summary.hourly.map(({ period }) => period)).toEqual([
      "2024-11-03 01:00 GMT-04:00",
      "2024-11-03 01:00 GMT-05:00",
      "2024-11-03 02:00 GMT-05:00",
    ]);
    expect(summary.busiestPeriods).toHaveLength(3);
  });

  test("encodes deterministic UTF-8 artifacts with pretty JSON newline", () => {
    const rows = preparePackageRows([
      source("launch/1753315200000-photo.jpg"),
    ], () => undefined);
    const artifacts = encodePackageArtifacts({
      event: "launch",
      generatedAt: new Date("2026-07-24T04:00:00.000Z"),
      configuredTimeZone: "UTC",
      rows,
    });
    const decoder = new TextDecoder();
    expect(decoder.decode(artifacts.manifest)).toBe(buildManifestCsv(rows));
    expect(decoder.decode(artifacts.summary)).toEndWith("\n");
    expect(decoder.decode(artifacts.summary)).toContain("\n  \"version\": 1,");
    expect(decoder.decode(artifacts.contactSheet)).toStartWith("<!doctype html>");
  });

  test("breaks equal frame counts by deterministic code-unit key order", () => {
    const rows = preparePackageRows([
      source("launch/1753315200000-z.jpg", {
        receipt: { capturedAt: 1753315200000, frameKey: "a" },
      }),
      source("launch/1753315200001-a.jpg", {
        receipt: { capturedAt: 1753315200001, frameKey: "Z" },
      }),
    ], (key) => key);
    const summary = buildExportSummary({
      event: "launch",
      generatedAt: new Date("2026-07-24T04:00:00.000Z"),
      rows,
    });

    expect(summary.frameUsage.map(({ frameKey }) => frameKey)).toEqual(["Z", "a"]);
  });
});
