import { describe, expect, test } from "bun:test";
import { HttpUploadError, classifyUploadFailure } from "./retry-policy";

describe("upload retry policy", () => {
  test("retries network, timeout, throttling, and server failures", () => {
    for (const status of [408, 425, 429, 500, 503]) {
      expect(
        classifyUploadFailure(
          new HttpUploadError(status, null, status >= 500 ? "server" : "timeout"),
          1,
          1_000,
          () => 0.5
        ).kind
      ).toBe("retryable");
    }

    expect(
      classifyUploadFailure(new TypeError("fetch failed"), 1, 1_000, () => 0.5)
    ).toEqual({ kind: "retryable", delayMs: 1_000, errorClass: "network" });
  });

  test("requires new auth for 401 and permanently blocks invalid requests", () => {
    expect(
      classifyUploadFailure(new HttpUploadError(401, null, "auth"), 1, 0, () => 0.5)
    ).toEqual({ kind: "auth-required", errorClass: "auth" });

    for (const status of [400, 403, 413, 415]) {
      expect(
        classifyUploadFailure(
          new HttpUploadError(status, null, "payload"),
          1,
          0,
          () => 0.5
        )
      ).toEqual({ kind: "permanent", errorClass: "payload" });
    }
  });

  test("uses deterministic jittered exponential backoff", () => {
    expect(
      classifyUploadFailure(new TypeError("offline"), 1, 0, () => 0)
    ).toMatchObject({ kind: "retryable", delayMs: 500 });
    expect(
      classifyUploadFailure(new TypeError("offline"), 3, 0, () => 0.5)
    ).toMatchObject({ kind: "retryable", delayMs: 4_000 });
    expect(
      classifyUploadFailure(new TypeError("offline"), 10, 0, () => 1)
    ).toMatchObject({ kind: "retryable", delayMs: 30_000 });
  });

  test("honors later Retry-After delta seconds and caps it", () => {
    expect(
      classifyUploadFailure(new HttpUploadError(429, "12", "timeout"), 1, 1_000, () => 0)
    ).toMatchObject({ kind: "retryable", delayMs: 12_000 });
    expect(
      classifyUploadFailure(new HttpUploadError(503, "120", "server"), 1, 1_000, () => 0)
    ).toMatchObject({ kind: "retryable", delayMs: 30_000 });
  });

  test("honors later Retry-After HTTP dates and ignores invalid or past dates", () => {
    const now = Date.parse("2026-07-24T00:00:00.000Z");
    expect(
      classifyUploadFailure(
        new HttpUploadError(503, "Fri, 24 Jul 2026 00:00:07 GMT", "server"),
        1,
        now,
        () => 0
      )
    ).toMatchObject({ kind: "retryable", delayMs: 7_000 });
    expect(
      classifyUploadFailure(
        new HttpUploadError(503, "not a date", "server"),
        1,
        now,
        () => 0
      )
    ).toMatchObject({ kind: "retryable", delayMs: 500 });
    expect(
      classifyUploadFailure(
        new HttpUploadError(503, "Thu, 23 Jul 2026 23:59:00 GMT", "server"),
        1,
        now,
        () => 0
      )
    ).toMatchObject({ kind: "retryable", delayMs: 500 });
  });

  test("classifies unrecognized failures as permanently unknown", () => {
    expect(classifyUploadFailure("broken", 1, 0, () => 0.5)).toEqual({
      kind: "permanent",
      errorClass: "unknown",
    });
    expect(
      classifyUploadFailure(new HttpUploadError(409, null, "unknown"), 1, 0, () => 0.5)
    ).toEqual({ kind: "permanent", errorClass: "unknown" });
  });
});
