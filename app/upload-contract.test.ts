import { describe, expect, test } from "bun:test";
import {
  InvalidUploadHeadersError,
  parseUploadHeaders,
  stableUploadHeaders,
} from "./upload-contract";

const headers = (values: Record<string, string>) => new Headers(values);

const identity = {
  "x-capture-id": "018f0000-0000-4000-8000-000000000001",
  "x-captured-at": "1753315200000",
};

describe("stable upload headers", () => {
  test("all stable fields round-trip exactly", () => {
    const stable = {
      captureId: "018f0000-0000-4000-8000-000000000001",
      capturedAt: 1753315200000,
      source: "framed" as const,
      frameKey: "square",
      configRevisionId: "018f0000-0000-7000-8000-000000000002",
      rehearsalId: "018f0000-0000-4000-8000-000000000501",
    };

    expect(stableUploadHeaders(stable)).toEqual({
      "x-capture-id": "018f0000-0000-4000-8000-000000000001",
      "x-captured-at": "1753315200000",
      "x-capture-source": "framed",
      "x-frame-key": "square",
      "x-config-revision-id": "018f0000-0000-7000-8000-000000000002",
      "x-rehearsal-id": "018f0000-0000-4000-8000-000000000501",
    });
    expect(parseUploadHeaders(headers(stableUploadHeaders(stable)))).toEqual({ kind: "stable", ...stable });
  });

  test("no new headers is the legacy contract", () => {
    expect(parseUploadHeaders(headers({ "content-type": "image/jpeg" }))).toEqual({ kind: "legacy" });
  });

  test("preserves the existing untracked stable timestamp contract", () => {
    expect(parseUploadHeaders(headers({
      ...identity,
      "x-captured-at": "0000000000000",
    }))).toEqual({
      kind: "stable",
      captureId: identity["x-capture-id"],
      capturedAt: 0,
    });
  });

  test("rejects partial capture identity", () => {
    expect(() => parseUploadHeaders(headers({ "x-capture-id": identity["x-capture-id"] })))
      .toThrow(InvalidUploadHeadersError);
    expect(() => parseUploadHeaders(headers({ "x-captured-at": identity["x-captured-at"] })))
      .toThrow(InvalidUploadHeadersError);
  });

  test("rejects metadata without capture identity", () => {
    expect(() => parseUploadHeaders(headers({ "x-capture-source": "framed" })))
      .toThrow(InvalidUploadHeadersError);
    expect(() => parseUploadHeaders(headers({
      "x-rehearsal-id": "018f0000-0000-4000-8000-000000000501",
    }))).toThrow(InvalidUploadHeadersError);
  });

  test("rejects non-lowercase UUID-v4 capture IDs", () => {
    for (const captureId of [
      "018F0000-0000-4000-8000-000000000001",
      "018f0000-0000-1000-8000-000000000001",
      "018f0000-0000-4000-c000-000000000001",
      "../photo",
    ]) {
      expect(() => parseUploadHeaders(headers({ ...identity, "x-capture-id": captureId }))).toThrow(InvalidUploadHeadersError);
    }
  });

  test("rejects malformed timestamp, source, and bounded tokens", () => {
    for (const invalid of [
      { ...identity, "x-captured-at": "1e12" },
      { ...identity, "x-captured-at": "175331520000" },
      { ...identity, "x-capture-source": "video" },
      { ...identity, "x-frame-key": "../frame" },
      { ...identity, "x-config-revision-id": "-revision" },
      { ...identity, "x-frame-key": "a".repeat(129) },
      { ...identity, "x-rehearsal-id": "018F0000-0000-4000-8000-000000000501" },
      { ...identity, "x-rehearsal-id": "../rehearsal" },
    ]) {
      expect(() => parseUploadHeaders(headers(invalid))).toThrow(InvalidUploadHeadersError);
    }
  });

  test("accepts optional metadata and ignores unknown headers", () => {
    expect(parseUploadHeaders(headers({
      ...identity,
      "x-capture-source": "camera-fallback",
      "x-unknown": "ignored",
    }))).toEqual({
      kind: "stable",
      captureId: identity["x-capture-id"],
      capturedAt: 1753315200000,
      source: "camera-fallback",
    });
  });
});
