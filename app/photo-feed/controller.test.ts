import { describe, expect, test } from "bun:test";
import {
  BROWSE_FEED_PROFILE,
  PROJECTOR_FEED_PROFILE,
  initialPhotoFeedState,
  mergePhotoFeed,
  reducePhotoFeed,
} from "./controller";
import type { FeedPhoto } from "./types";

const a: FeedPhoto = { key: "events/show/a.jpg", url: "/a-old", uploadedAt: "2026-07-24T01:00:00Z" };
const b: FeedPhoto = { key: "events/show/b.jpg", url: "/b", uploadedAt: "2026-07-24T00:00:00Z" };
const c: FeedPhoto = { key: "events/show/c.jpg", url: "/c", uploadedAt: "2026-07-24T02:00:00Z" };

describe("mergePhotoFeed", () => {
  test("deduplicates exact keys, replaces stale copies, and keeps server order", () => {
    const freshA = { ...a, url: "/a-fresh", uploadedAt: "2026-07-24T03:00:00Z" };
    const result = mergePhotoFeed([a, b], [c, freshA, c]);

    expect(result.photos).toEqual([c, freshA, b]);
    expect(result.inserted).toEqual([c]);
  });

  test("an empty delta preserves the existing array", () => {
    const current = [a, b];
    expect(mergePhotoFeed(current, [])).toEqual({ photos: current, inserted: [] });
  });
});

describe("reducePhotoFeed", () => {
  test("starts one request and retains cursor for an empty or invalid-cursor delta", () => {
    const started = reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" });
    expect(started.effects).toEqual([
      { type: "request", requestId: 1, generation: 0, after: null },
    ]);

    const succeeded = reducePhotoFeed(started.state, {
      type: "request-success",
      requestId: 1,
      generation: 0,
      photos: [],
      cursor: "",
      profile: PROJECTOR_FEED_PROFILE,
      random: 0,
    });
    expect(succeeded.state.cursor).toBeNull();
    expect(succeeded.state.photos).toEqual([]);
    expect(succeeded.state.status).toBe("ready");
  });

  test("changes Event by aborting, clearing state, and incrementing generation", () => {
    let state = initialPhotoFeedState("show");
    state = reducePhotoFeed(state, { type: "start" }).state;
    state = { ...state, photos: [a], cursor: "cursor", error: "old" };

    const changed = reducePhotoFeed(state, { type: "event-change", event: "other" });
    expect(changed.state).toMatchObject({
      event: "other",
      photos: [],
      cursor: null,
      error: null,
      generation: 1,
    });
    expect(changed.effects).toEqual([
      { type: "abort", requestId: 1 },
      { type: "cancel-schedule" },
      { type: "request", requestId: 2, generation: 1, after: null },
    ]);
  });

  test("ignores stale success, errors, and abort completions", () => {
    const active = reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" }).state;
    for (const event of [
      {
        type: "request-success" as const,
        requestId: 99,
        generation: 0,
        photos: [a],
        cursor: "new",
        profile: PROJECTOR_FEED_PROFILE,
        random: 0,
      },
      { type: "request-error" as const, requestId: 99, generation: 0, error: "bad", profile: PROJECTOR_FEED_PROFILE, random: 0 },
      { type: "request-aborted" as const, requestId: 99, generation: 0 },
    ]) {
      expect(reducePhotoFeed(active, event)).toEqual({ state: active, effects: [] });
    }
  });

  test("serializes refresh by aborting the active request and requesting after settlement", () => {
    const active = reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" }).state;
    const refreshed = reducePhotoFeed(active, { type: "refresh" });
    expect(refreshed.state.refreshPending).toBeTrue();
    expect(refreshed.effects).toEqual([{ type: "abort", requestId: 1 }]);

    const settled = reducePhotoFeed(refreshed.state, {
      type: "request-aborted",
      requestId: 1,
      generation: 0,
    });
    expect(settled.effects).toEqual([
      { type: "request", requestId: 2, generation: 0, after: null },
    ]);
  });

  test("refreshes immediately while idle", () => {
    const result = reducePhotoFeed(initialPhotoFeedState("show"), { type: "refresh" });
    expect(result.effects[0]).toEqual({
      type: "request",
      requestId: 1,
      generation: 0,
      after: null,
    });
  });

  test("hidden aborts and retains photos; visible refreshes immediately", () => {
    const active = {
      ...reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" }).state,
      photos: [a],
    };
    const hidden = reducePhotoFeed(active, { type: "visibility", visible: false });
    expect(hidden.state.photos).toEqual([a]);
    expect(hidden.effects).toEqual([
      { type: "abort", requestId: 1 },
      { type: "cancel-schedule" },
    ]);

    const settled = reducePhotoFeed(hidden.state, {
      type: "request-aborted",
      requestId: 1,
      generation: 0,
    });
    const visible = reducePhotoFeed(settled.state, { type: "visibility", visible: true });
    expect(visible.effects).toEqual([
      { type: "request", requestId: 2, generation: 0, after: null },
    ]);
  });

  test("retains photos on failure, backs off with a cap, and success resets failures", () => {
    const active = {
      ...reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" }).state,
      photos: [a],
    };
    const failed = reducePhotoFeed(active, {
      type: "request-error",
      requestId: 1,
      generation: 0,
      error: "offline",
      profile: PROJECTOR_FEED_PROFILE,
      random: 1,
    });
    expect(failed.state.photos).toEqual([a]);
    expect(failed.state.failureCount).toBe(1);
    expect(failed.effects).toEqual([{ type: "schedule", delayMs: 4_000 }]);

    const retry = reducePhotoFeed(failed.state, { type: "timer" }).state;
    const success = reducePhotoFeed(retry, {
      type: "request-success",
      requestId: 2,
      generation: 0,
      photos: [c],
      cursor: "next",
      profile: PROJECTOR_FEED_PROFILE,
      random: 0,
    });
    expect(success.state.failureCount).toBe(0);
    expect(success.state.error).toBeNull();
  });

  test("uses exact active, quiet, and capped error cadence from injected random", () => {
    expect(PROJECTOR_FEED_PROFILE.activeMs).toBe(2_000);
    expect(BROWSE_FEED_PROFILE.activeMs).toBe(3_500);

    let state = reducePhotoFeed(initialPhotoFeedState("show"), { type: "start" }).state;
    let result = reducePhotoFeed(state, {
      type: "request-success",
      requestId: 1,
      generation: 0,
      photos: [a],
      cursor: "one",
      profile: PROJECTOR_FEED_PROFILE,
      random: 0.5,
    });
    expect(result.effects).toEqual([{ type: "schedule", delayMs: 2_000 }]);

    const quietDelays: number[] = [];
    for (let requestId = 2; requestId <= 5; requestId += 1) {
      state = reducePhotoFeed(result.state, { type: "timer" }).state;
      result = reducePhotoFeed(state, {
        type: "request-success",
        requestId,
        generation: 0,
        photos: [],
        cursor: null,
        profile: PROJECTOR_FEED_PROFILE,
        random: 0,
      });
      quietDelays.push(
        (result.effects[0] as { type: "schedule"; delayMs: number }).delayMs,
      );
    }
    expect(quietDelays).toEqual([10_000, 13_333, 16_667, 20_000]);

    state = {
      ...reducePhotoFeed(result.state, { type: "timer" }).state,
      failureCount: 20,
    };
    result = reducePhotoFeed(state, {
      type: "request-error",
      requestId: 6,
      generation: 0,
      error: "still offline",
      profile: PROJECTOR_FEED_PROFILE,
      random: 1,
    });
    expect(result.effects).toEqual([{ type: "schedule", delayMs: 60_000 }]);
  });
});
