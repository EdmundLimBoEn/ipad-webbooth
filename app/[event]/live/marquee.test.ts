import { describe, expect, test } from "bun:test";
import {
  DRAG_ACTIVATION_THRESHOLD_PX,
  MANUAL_PAUSE_MS,
  marqueeTileKey,
  shouldAnimateMarquee,
  suppressActivationAfterDrag,
} from "./marquee";

describe("projector marquee invariants", () => {
  test("keeps newest-first tile identity stable across prepends", () => {
    const before = ["event/200-b.jpg", "event/100-a.jpg"].map((key) =>
      marqueeTileKey(key, 0)
    );
    const after = ["event/300-c.jpg", "event/200-b.jpg", "event/100-a.jpg"].map(
      (key) => marqueeTileKey(key, 0)
    );

    expect(after.slice(1)).toEqual(before);
  });

  test("suppresses activation only after more than ten pixels of travel", () => {
    expect(DRAG_ACTIVATION_THRESHOLD_PX).toBe(10);
    expect(suppressActivationAfterDrag(10)).toBe(false);
    expect(suppressActivationAfterDrag(10.01)).toBe(true);
  });

  test("resumes automatic movement four seconds after manual interaction", () => {
    expect(MANUAL_PAUSE_MS).toBe(4_000);
  });

  test("reduced motion keeps photos rendered without automatic marquee motion", () => {
    expect(shouldAnimateMarquee({
      reducedMotion: true,
      viewportHeight: 700,
      tallestColumnHeight: 1_400,
    })).toBe(false);
    expect(shouldAnimateMarquee({
      reducedMotion: false,
      viewportHeight: 700,
      tallestColumnHeight: 1_400,
    })).toBe(true);
  });
});
