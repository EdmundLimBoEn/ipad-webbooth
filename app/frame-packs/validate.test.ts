import { expect, test } from "bun:test";
import { FRAME_PACKS } from "./catalog";
import type { FramePackManifest } from "./types";
import { validateFramePacks } from "./validate";

const assets = {
  "talent-beacon-9-anniversary/lighthouse.png": { path: "lighthouse.png", width: 1080, height: 1080 },
  "talent-beacon-9-anniversary/lighthouse-overlay.png": { path: "lighthouse-overlay.png", width: 1080, height: 1080 },
  "talent-beacon-9-anniversary/beacon-square.png": { path: "beacon-square.png", width: 1080, height: 1080 },
  ...Object.fromEntries(
    ["beacon.png", "birthday.png", "sheep.png", "starry.png"].map((name) => [
      `talent-beacon-9-anniversary/${name}`,
      { path: name, width: 720, height: 2160 },
    ]),
  ),
};

test("the checked-in frame catalog is valid", () => {
  expect(validateFramePacks(FRAME_PACKS, assets)).toEqual([]);
});

test("reports authoring mistakes together", () => {
  const broken: FramePackManifest = {
    version: 1,
    pack: { key: "party", label: "Party" },
    templates: {
      bad: {
        label: "Bad",
        shots: 2,
        intervalMs: 3000,
        canvas: { w: 100, h: 100 },
        bgImage: "art.png",
        overlay: "art.png",
        slots: [{ x: 80, y: 80, w: 40, h: 40 }],
      },
    },
  };
  const messages = validateFramePacks([broken], {
    "party/art.png": { path: "art.png", width: 200, height: 100 },
  }).map((issue) => issue.message);

  expect(messages).toContain("shots must equal slots.length");
  expect(messages).toContain("slot must stay within the canvas");
  expect(messages).toContain("bgImage and overlay must not reference the same asset");
  expect(messages.filter((message) => message.includes("expected 100x100"))).toHaveLength(2);
});

test("requires a usable visual source and known local assets", () => {
  const broken: FramePackManifest = {
    version: 1,
    pack: { key: "plain", label: "Plain" },
    templates: {
      empty: {
        label: "Empty",
        shots: 1,
        intervalMs: 1000,
        canvas: { w: 100, h: 100 },
        slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      },
      missing: {
        label: "Missing",
        shots: 1,
        intervalMs: 1000,
        canvas: { w: 100, h: 100 },
        preview: "preview.png",
        slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      },
    },
  };
  const messages = validateFramePacks([broken]).map((issue) => issue.message);
  expect(messages).toContain("provide a background, bgImage, or overlay");
  expect(messages).toContain("frame has no usable preview source");
  expect(messages).toContain("asset does not exist: preview.png");
});
