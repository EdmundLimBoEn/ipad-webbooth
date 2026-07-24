import { describe, expect, test } from "bun:test";
import {
  InvalidModerationCursorError,
  decodeModerationCursor,
  encodeModerationCursor,
  parseModerationPhotoRecord,
} from "./moderation";

const cursor = {
  version: 1 as const,
  event: "launch",
  afterIndexKey: "events/launch/photo-index/v1/8246684799999-bGF1bmNoL3Bob3RvLmpwZw.json",
  from: 1753315200000,
  to: 1753401600000,
};

describe("moderation cursor", () => {
  test("round-trips only strict Event-bound filter state", () => {
    const encoded = encodeModerationCursor(cursor);
    expect(encoded).toStartWith("mod1.");
    expect(decodeModerationCursor(encoded, {
      event: "launch",
      from: cursor.from,
      to: cursor.to,
    })).toEqual(cursor);
  });

  test("rejects malformed, expanded, unsupported, cross-Event, and changed-filter cursors", () => {
    const encoded = encodeModerationCursor(cursor);
    const badValues = [
      "",
      "mod1.***",
      `mod1.${btoa(JSON.stringify({ ...cursor, extra: true }))}`,
      `mod1.${btoa(JSON.stringify({ ...cursor, version: 2 }))}`,
      `mod1.${btoa(JSON.stringify({ ...cursor, event: "other" }))}`,
      `mod1.${btoa(JSON.stringify({ ...cursor, afterIndexKey: "launch/photo.jpg" }))}`,
    ];
    for (const value of badValues) {
      expect(() => decodeModerationCursor(value, {
        event: "launch",
        from: cursor.from,
        to: cursor.to,
      })).toThrow(InvalidModerationCursorError);
    }
    expect(() => decodeModerationCursor(encoded, {
      event: "launch",
      from: null,
      to: cursor.to,
    })).toThrow(InvalidModerationCursorError);
  });
});

describe("private moderation photo records", () => {
  test("strictly projects safe photo fields and omits private operational metadata", () => {
    expect(parseModerationPhotoRecord("launch", {
      version: 1,
      key: "launch/1753315200000-a.jpg",
      uploadedAt: "2025-07-24T00:00:00.000Z",
      capturedAt: 1753315200000,
      source: "framed",
      frameKey: "celebration",
      configRevisionId: "private-revision",
    })).toEqual({
      key: "launch/1753315200000-a.jpg",
      uploadedAt: "2025-07-24T00:00:00.000Z",
      capturedAt: 1753315200000,
      source: "framed",
      frameKey: "celebration",
    });
  });

  test("rejects corrupt, future, expanded, and cross-Event records", () => {
    const valid = {
      version: 1,
      key: "launch/1753315200000-a.jpg",
      uploadedAt: "2025-07-24T00:00:00.000Z",
      capturedAt: 1753315200000,
    };
    for (const value of [
      { ...valid, version: 2 },
      { ...valid, key: "other/1753315200000-a.jpg" },
      { ...valid, uploadedAt: "not-an-instant" },
      { ...valid, uploadedAt: "2025-02-30T00:00:00.000Z" },
      { ...valid, capturedAt: 1.5 },
      { ...valid, frameKey: 42 },
      { ...valid, configRevisionId: 42 },
      { ...valid, heartbeat: true },
    ]) {
      expect(parseModerationPhotoRecord("launch", value)).toBeNull();
    }
  });
});
