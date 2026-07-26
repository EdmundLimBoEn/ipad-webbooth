import { describe, expect, test } from "bun:test";
import { anchoredScrollTop, chooseScrollAnchor } from "./scroll-anchor";

describe("browse Gallery scroll anchoring", () => {
  test("chooses the first still-visible exact key across mixed-height rows", () => {
    expect(chooseScrollAnchor([
      { key: "gone", top: -320, bottom: -1 },
      { key: "partial", top: -18, bottom: 220 },
      { key: "next", top: 220, bottom: 640 },
    ])).toEqual({ key: "partial", top: -18 });
  });

  test("returns no anchor when no exact-key tile remains visible", () => {
    expect(chooseScrollAnchor([])).toBeNull();
    expect(chooseScrollAnchor([
      { key: "above", top: -200, bottom: 0 },
      { key: "", top: 0, bottom: 200 },
    ])).toBeNull();
  });

  test("preserves the visible position across one or several prepends", () => {
    expect(anchoredScrollTop({
      previousScrollTop: 500,
      beforeTop: 80,
      afterTop: 260,
    })).toBe(680);
    expect(anchoredScrollTop({
      previousScrollTop: 680,
      beforeTop: 260,
      afterTop: 920,
    })).toBe(1_340);
  });

  test("does not adjust at the top and clamps negative movement", () => {
    expect(anchoredScrollTop({
      previousScrollTop: 0,
      beforeTop: 0,
      afterTop: 200,
    })).toBe(0);
    expect(anchoredScrollTop({
      previousScrollTop: -10,
      beforeTop: 0,
      afterTop: 200,
    })).toBe(0);
    expect(anchoredScrollTop({
      previousScrollTop: 20,
      beforeTop: 200,
      afterTop: 0,
    })).toBe(0);
  });
});
