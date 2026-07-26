import { describe, expect, test } from "bun:test";
import {
  InvalidPhotoReceiptError,
  parsePhotoReceipt,
  type PhotoReceiptV1,
} from "./photo-metadata";

const key = "launch/1721793600000-018f0000-0000-4000-8000-000000000001.jpg";
const complete: PhotoReceiptV1 = {
  version: 1,
  key,
  uploadedAt: "2026-07-24T00:00:00.000Z",
  capturedAt: 1721793600000,
  source: "framed",
  frameKey: "square",
  configRevisionId: "018f0000-0000-7000-8000-000000000001",
};

function expectReason(value: unknown, expectedKey: string, reason: InvalidPhotoReceiptError["reason"]) {
  try {
    parsePhotoReceipt(value, expectedKey);
    throw new Error("expected receipt parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidPhotoReceiptError);
    expect((error as InvalidPhotoReceiptError).reason).toBe(reason);
    expect((error as InvalidPhotoReceiptError).expectedKey).toBe(expectedKey);
  }
}

describe("photo receipt parsing", () => {
  test("constructs a fresh complete allowlisted receipt", () => {
    const parsed = parsePhotoReceipt(complete, key);
    expect(parsed).toEqual(complete);
    expect(parsed).not.toBe(complete);
  });

  test("accepts only the required fields", () => {
    expect(parsePhotoReceipt({
      version: 1,
      key,
      uploadedAt: "2026-07-24T08:00:00+08:00",
      capturedAt: 1721793600000,
    }, key)).toEqual({
      version: 1,
      key,
      uploadedAt: "2026-07-24T08:00:00+08:00",
      capturedAt: 1721793600000,
    });
  });

  test("rejects invalid shapes, missing fields, extra data, and nested leaks", () => {
    for (const value of [
      null,
      [],
      {},
      {
        version: 1,
        key,
        capturedAt: complete.capturedAt,
      },
      { ...complete, credential: "secret" },
      { ...complete, headers: { authorization: "secret" } },
      { ...complete, url: "https://private.example" },
      { ...complete, error: "raw storage error" },
    ]) {
      expectReason(value, key, "invalid_shape");
    }
  });

  test("classifies unsupported versions and exact-key mismatches", () => {
    expectReason({ ...complete, version: 2 }, key, "unsupported_version");
    expectReason({ ...complete, key: "other/photo.jpg" }, key, "key_mismatch");
  });

  test("rejects non-RFC3339 upload timestamps", () => {
    for (const uploadedAt of [
      "2026-07-24",
      "July 24, 2026",
      "2026-07-24 00:00:00Z",
      "2026-13-24T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-07-24T00:00:00+14:30",
    ]) {
      expectReason({ ...complete, uploadedAt }, key, "invalid_timestamp");
    }
  });

  test("rejects invalid capture metadata", () => {
    for (const patch of [
      { capturedAt: 123 },
      { capturedAt: 1721793600000.5 },
      { source: "file" },
      { frameKey: "" },
      { frameKey: "../square" },
      { frameKey: "x".repeat(129) },
      { configRevisionId: "" },
      { configRevisionId: "revision/slash" },
      { configRevisionId: "x".repeat(129) },
    ]) {
      expectReason({ ...complete, ...patch }, key, "invalid_metadata");
    }
  });
});
