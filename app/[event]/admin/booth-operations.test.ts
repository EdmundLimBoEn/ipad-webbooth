import { expect, test } from "bun:test";
import type { AdminBoothRecord, BoothOperationalState } from "../../booth-control";
import {
  BoothOperationsCoordinator,
  boothOperationalStateInput,
  mergeBoothPages,
  parseAdminBoothPage,
  parseBoothOperationalStateResponse,
} from "./booth-operations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function safeBooth(overrides: Partial<AdminBoothRecord> = {}): AdminBoothRecord {
  return {
    ...booth(
      "018f0000-0000-4000-8000-000000000001",
      "2026-07-24T00:01:00.000Z"
    ),
    ...overrides,
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

test("mergeBoothPages replaces an invalid timestamp with a valid record for the same device", () => {
  const merged = mergeBoothPages(
    [booth("a", "not-a-timestamp")],
    [booth("a", "2026-07-24T00:01:00.000Z")]
  );

  expect(merged).toHaveLength(1);
  expect(merged[0]?.lastSeenAt).toBe("2026-07-24T00:01:00.000Z");
});

test("mergeBoothPages sorts invalid timestamps after valid records in stable input order", () => {
  const merged = mergeBoothPages(
    [
      booth("invalid-a", "not-a-timestamp"),
      booth("valid", "2026-07-24T00:01:00.000Z"),
      booth("invalid-b", "also-not-a-timestamp"),
    ]
  );

  expect(merged.map((record) => record.deviceId)).toEqual([
    "valid",
    "invalid-a",
    "invalid-b",
  ]);
});

test("boothOperationalStateInput updates English without dropping other locale messages", () => {
  expect(boothOperationalStateInput({ en: "Original", ar: "انتظر" }, "Hold for lighting", true)).toEqual({
    paused: true,
    messages: { en: "Hold for lighting", ar: "انتظر" },
  });
});

test("parseBoothOperationalStateResponse rejects malformed or expanded state", () => {
  const valid: BoothOperationalState = {
    version: 1,
    paused: false,
    messages: { en: "Ready" },
    updatedAt: "2026-07-24T00:01:00.000Z",
  };

  expect(parseBoothOperationalStateResponse(valid)).toEqual(valid);
  expect(parseBoothOperationalStateResponse({ ...valid, updatedAt: "not-a-date" })).toBeNull();
  expect(parseBoothOperationalStateResponse({ ...valid, rawError: "private failure" })).toBeNull();
});

test("parseAdminBoothPage strictly rejects malformed records and cursors", () => {
  const validRecord = safeBooth();
  const valid = { booths: [validRecord], cursor: " \t\n " };

  expect(parseAdminBoothPage(valid)).toEqual(valid);
  expect(parseAdminBoothPage({
    booths: [{ ...validRecord, camera: "raw camera exception" }],
    cursor: null,
  })).toBeNull();
  expect(parseAdminBoothPage({
    booths: [{ ...validRecord, buildId: "not a bounded token" }],
    cursor: null,
  })).toBeNull();
  expect(parseAdminBoothPage({
    booths: [{ ...validRecord, errorClass: "private storage exception" }],
    cursor: null,
  })).toBeNull();
  expect(parseAdminBoothPage({
    booths: [{ ...validRecord, lastSeenAt: "not-a-date" }],
    cursor: null,
  })).toBeNull();
  expect(parseAdminBoothPage({ booths: [validRecord], cursor: 7 })).toBeNull();
  expect(parseAdminBoothPage({ ...valid, boothKey: "must-not-pass" })).toBeNull();
});

test("an old Event response cannot write or block the new Event initial request", async () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("old-event", "admin-one");
  const oldRead = coordinator.beginRead("old-event", "admin-one");
  expect(oldRead).not.toBeNull();
  const oldResponse = deferred<string>();
  const writes: string[] = [];
  const completion = oldResponse.promise.then((value) => {
    if (oldRead && coordinator.isReadCurrent(oldRead)) writes.push(value);
  });

  coordinator.activateScope("new-event", "admin-one");
  expect(oldRead?.signal.aborted).toBe(true);
  const newRead = coordinator.beginRead("new-event", "admin-one");
  expect(newRead).not.toBeNull();

  oldResponse.resolve("stale old Event state");
  await completion;
  expect(writes).toEqual([]);
  expect(oldRead && coordinator.finishRead(oldRead)).toBe(false);
  expect(newRead && coordinator.isReadCurrent(newRead)).toBe(true);
});

test("disposing a scope aborts in-flight work and prevents another request", () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("event", "admin");
  const read = coordinator.beginRead("event", "admin");
  expect(read).not.toBeNull();

  coordinator.disposeScope();

  expect(read?.signal.aborted).toBe(true);
  expect(coordinator.beginRead("event", "admin")).toBeNull();
});

test("requests cannot borrow a different Event or Admin scope before activation", () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("old-event", "admin-one");

  expect(coordinator.beginRead("new-event", "admin-one")).toBeNull();
  expect(coordinator.beginMutation("old-event", "admin-two")).toBeNull();
});

test("a first-page refresh never rewinds the loaded tail cursor", () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("event", "admin");
  const initial = coordinator.beginRead("event", "admin");
  expect(initial).not.toBeNull();
  expect(initial && coordinator.acceptFirstPage(initial, "cursor-1")).toBe("cursor-1");
  expect(initial && coordinator.finishRead(initial)).toBe(true);

  const laterPage = coordinator.beginRead("event", "admin");
  expect(laterPage).not.toBeNull();
  expect(coordinator.tailCursor()).toBe("cursor-1");
  expect(laterPage && coordinator.advanceTail(laterPage, "cursor-2")).toBe("cursor-2");
  expect(laterPage && coordinator.finishRead(laterPage)).toBe(true);

  const refresh = coordinator.beginRead("event", "admin");
  expect(refresh).not.toBeNull();
  expect(refresh && coordinator.acceptFirstPage(refresh, "cursor-1")).toBe("cursor-2");
  expect(refresh && coordinator.finishRead(refresh)).toBe(true);
  expect(coordinator.tailCursor()).toBe("cursor-2");
});

test("a first-page refresh does not reopen pagination after the loaded tail ends", () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("event", "admin");
  const initial = coordinator.beginRead("event", "admin");
  expect(initial && coordinator.acceptFirstPage(initial, "cursor-1")).toBe("cursor-1");
  expect(initial && coordinator.advanceTail(initial, null)).toBeNull();
  expect(initial && coordinator.finishRead(initial)).toBe(true);

  const refresh = coordinator.beginRead("event", "admin");
  expect(refresh && coordinator.acceptFirstPage(refresh, "cursor-1")).toBeNull();
  expect(coordinator.tailCursor()).toBeNull();
});

test("a stale GET completion after a successful mutation cannot overwrite state", async () => {
  const coordinator = new BoothOperationsCoordinator();
  coordinator.activateScope("event", "admin");
  const staleRead = coordinator.beginRead("event", "admin");
  expect(staleRead).not.toBeNull();
  const staleResponse = deferred<string>();
  let displayedState = "running";
  const completion = staleResponse.promise.then((value) => {
    if (staleRead && coordinator.isReadCurrent(staleRead)) displayedState = value;
  });

  const mutation = coordinator.beginMutation("event", "admin");
  expect(mutation).not.toBeNull();
  expect(mutation?.abortedRead).toBe(true);
  expect(staleRead?.signal.aborted).toBe(true);
  expect(coordinator.beginRead("event", "admin")).toBeNull();
  displayedState = "paused";
  expect(mutation && coordinator.finishMutation(mutation.ticket)).toBe(true);

  staleResponse.resolve("running");
  await completion;
  expect(displayedState).toBe("paused");
});
