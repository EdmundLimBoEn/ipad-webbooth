import { expect, test } from "bun:test";
import type { AdminBoothRecord } from "../../booth-control";
import { boothOperationalStateInput, mergeBoothPages } from "./booth-operations";

function booth(deviceId: string, lastSeenAt: string): AdminBoothRecord {
  return {
    version: 1,
    deviceId,
    lastSeenAt,
    sessionStartedAt: 1_753_408_000_000,
    pendingCount: 0,
    durableStorage: true,
    online: true,
    installed: true,
    camera: "ready",
    upload: "idle",
    buildId: "r1",
    stale: false,
  };
}

test("mergeBoothPages retains each exact device ID at its newest last-seen time", () => {
  const merged = mergeBoothPages(
    [booth("a", "2026-07-24T00:00:00.000Z")],
    [
      booth("a", "2026-07-24T00:01:00.000Z"),
      booth("b", "2026-07-24T00:00:30.000Z"),
    ]
  );

  expect(merged.map((record) => record.deviceId)).toEqual(["a", "b"]);
  expect(merged[0]?.lastSeenAt).toBe("2026-07-24T00:01:00.000Z");
});

test("mergeBoothPages ignores an older snapshot for the same exact device ID", () => {
  const merged = mergeBoothPages(
    [booth("a", "2026-07-24T00:01:00.000Z")],
    [booth("a", "2026-07-24T00:00:00.000Z")]
  );

  expect(merged).toHaveLength(1);
  expect(merged[0]?.lastSeenAt).toBe("2026-07-24T00:01:00.000Z");
});

test("boothOperationalStateInput updates English without dropping other locale messages", () => {
  expect(boothOperationalStateInput({ en: "Original", ar: "انتظر" }, "Hold for lighting", true)).toEqual({
    paused: true,
    messages: { en: "Hold for lighting", ar: "انتظر" },
  });
});
