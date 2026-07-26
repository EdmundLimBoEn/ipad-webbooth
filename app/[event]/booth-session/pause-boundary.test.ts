import { describe, expect, test } from "bun:test";
import { BoothPauseBoundary } from "./pause-boundary";

function harness() {
  const actions: string[] = [];
  const boundary = new BoothPauseBoundary({
    clearFrame: () => actions.push("clear-frame"),
    stopCamera: () => actions.push("stop-old-tracks"),
    startCamera: () => actions.push("get-user-media"),
  });
  return { actions, boundary };
}

function pauseThenResumeDuringOperation(boundary: BoothPauseBoundary) {
  expect(boundary.beginOperation()).toBe(true);
  boundary.observe(false);
  boundary.observe(true);
  boundary.observe(false);
}

describe("Booth pause boundary", () => {
  test("framed success enforces the observed stop boundary before a fresh camera", () => {
    const { actions, boundary } = harness();
    pauseThenResumeDuringOperation(boundary);

    boundary.completeOperation();

    expect(actions).toEqual(["clear-frame", "stop-old-tracks", "get-user-media"]);
  });

  test("framed failure/catch enforces the observed stop boundary before a fresh camera", () => {
    const { actions, boundary } = harness();
    pauseThenResumeDuringOperation(boundary);

    boundary.completeOperation();

    expect(actions.indexOf("stop-old-tracks")).toBeLessThan(actions.indexOf("get-user-media"));
    expect(actions).toEqual(["clear-frame", "stop-old-tracks", "get-user-media"]);
  });

  test("file fallback enforces the observed stop boundary before a fresh camera", () => {
    const { actions, boundary } = harness();
    pauseThenResumeDuringOperation(boundary);

    boundary.completeOperation();

    expect(actions).toEqual(["clear-frame", "stop-old-tracks", "get-user-media"]);
  });

  test("pause at an idle picker clears and stops immediately, then resumes fresh", () => {
    const { actions, boundary } = harness();

    boundary.observe(true);
    boundary.observe(false);

    expect(actions).toEqual(["clear-frame", "stop-old-tracks", "get-user-media"]);
  });

  test("remaining paused after completion clears and stops without restarting", () => {
    const { actions, boundary } = harness();
    expect(boundary.beginOperation()).toBe(true);
    boundary.observe(true);

    boundary.completeOperation();

    expect(actions).toEqual(["clear-frame", "stop-old-tracks"]);
  });

  test("reset discards an old Event operation without mutating the new Event", () => {
    const { actions, boundary } = harness();
    expect(boundary.beginOperation()).toBe(true);
    boundary.observe(true);

    boundary.reset();
    boundary.completeOperation();

    expect(actions).toEqual([]);
  });
});
