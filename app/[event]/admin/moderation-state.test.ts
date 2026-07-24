import { describe, expect, test } from "bun:test";
import type { ModerationPhoto } from "../../moderation";
import {
  filtersChanged,
  mergeModerationPage,
  ModerationPageCoordinator,
  moderationFilterInstant,
  parseModerationPageResponse,
  removeModeratedPhoto,
} from "./moderation-state";

const photo = (key: string, capturedAt: number): ModerationPhoto => ({
  key: `launch/${key}.jpg`,
  url: `https://photos.example/${key}.jpg`,
  uploadedAt: new Date(capturedAt).toISOString(),
  capturedAt,
});

describe("Admin moderation state", () => {
  test("deduplicates exact keys and retains reverse-time order", () => {
    expect(mergeModerationPage(
      [photo("middle", 20), photo("old", 10)],
      [photo("new", 30), photo("middle", 20)]
    ).map(({ key }) => key)).toEqual([
      "launch/new.jpg",
      "launch/middle.jpg",
      "launch/old.jpg",
    ]);
  });

  test("detects an actual filter change but not an equivalent copy", () => {
    expect(filtersChanged({ from: "", to: "" }, { from: "", to: "" })).toBe(false);
    expect(filtersChanged(
      { from: "2026-07-24T00:00", to: "" },
      { from: "2026-07-25T00:00", to: "" }
    )).toBe(true);
  });

  test("removes only the exact key and selects the next then previous focus target", () => {
    const photos = [photo("new", 30), photo("middle", 20), photo("old", 10)];
    expect(removeModeratedPhoto(photos, "launch/middle.jpg")).toEqual({
      photos: [photos[0], photos[2]],
      nextFocusKey: "launch/old.jpg",
    });
    expect(removeModeratedPhoto(photos, "launch/old.jpg").nextFocusKey)
      .toBe("launch/middle.jpg");
    expect(removeModeratedPhoto([photos[0]], photos[0].key)).toEqual({
      photos: [],
      nextFocusKey: null,
    });
  });

  test("rejects stale pages after a filter, Event, or auth-scope reset", () => {
    const coordinator = new ModerationPageCoordinator();
    const old = coordinator.begin("launch", "admin-a", { from: "", to: "" });
    const current = coordinator.begin("launch", "admin-a", {
      from: "2026-07-24T00:00",
      to: "",
    });
    expect(coordinator.accepts(old)).toBe(false);
    expect(coordinator.accepts(current)).toBe(true);
    coordinator.reset();
    expect(coordinator.accepts(current)).toBe(false);
  });

  test("an empty final page keeps prior rows and clears the cursor", () => {
    const coordinator = new ModerationPageCoordinator();
    const ticket = coordinator.begin("launch", "admin-a", { from: "", to: "" });
    expect(coordinator.merge(ticket, [photo("only", 10)], null, [], null)).toEqual({
      photos: [photo("only", 10)],
      nextCursor: null,
    });
  });

  test("strictly parses the public moderation page shape", () => {
    expect(parseModerationPageResponse({
      photos: [photo("one", 10)],
      nextCursor: "opaque",
    })).toEqual({
      photos: [photo("one", 10)],
      nextCursor: "opaque",
    });
    expect(parseModerationPageResponse({
      photos: [photo("one", 10)],
      nextCursor: null,
      receiptKey: "private",
    })).toBeNull();
    expect(parseModerationPageResponse({
      photos: [{ ...photo("one", 10), deviceId: "private" }],
      nextCursor: null,
    })).toBeNull();
  });

  test("converts local datetime filters to RFC3339 instants and rejects invalid input", () => {
    expect(moderationFilterInstant("")).toBeNull();
    expect(moderationFilterInstant("not-a-date")).toBeUndefined();
    expect(moderationFilterInstant("2026-07-24T08:30")).toMatch(
      /^2026-07-24T\d{2}:30:00\.000Z$/
    );
  });
});
