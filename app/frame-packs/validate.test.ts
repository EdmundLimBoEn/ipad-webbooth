import { expect, test } from "bun:test";
import { FRAME_PACKS, frameLabel } from "./catalog";
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

test("localized Frame labels fall back to the required default label", () => {
  const frame = {
    label: "Square",
    labels: { "zh-SG": "方形" },
  };

  expect(frameLabel(frame, "zh-SG")).toBe("方形");
  expect(frameLabel(frame, "ar")).toBe("Square");
});

test("rejects unsupported, blank, and overlong localized Frame labels", () => {
  const broken: FramePackManifest = {
    version: 1,
    pack: { key: "party", label: "Party" },
    templates: {
      bad: {
        label: "Bad",
        labels: {
          ar: " ",
          "zh-SG": "好".repeat(81),
          fr: "Mauvais",
        },
        shots: 1,
        intervalMs: 3000,
        canvas: { w: 100, h: 100 },
        background: "#fff",
        slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      },
    },
  } as FramePackManifest;

  const issues = validateFramePacks([broken]);
  expect(issues).toContainEqual({
    path: "party.templates.bad.labels.ar",
    message: "localized label is required",
  });
  expect(issues).toContainEqual({
    path: "party.templates.bad.labels.zh-SG",
    message: "localized label must be at most 80 characters",
  });
  expect(issues).toContainEqual({
    path: "party.templates.bad.labels.fr",
    message: "localized label locale is unsupported",
  });
});

test("rejects a default Frame label longer than 80 characters", () => {
  const broken: FramePackManifest = {
    version: 1,
    pack: { key: "party", label: "Party" },
    templates: {
      bad: {
        label: "B".repeat(81),
        shots: 1,
        intervalMs: 3000,
        canvas: { w: 100, h: 100 },
        background: "#fff",
        slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      },
    },
  };

  expect(validateFramePacks([broken])).toContainEqual({
    path: "party.templates.bad.label",
    message: "label must be at most 80 characters",
  });
});

test("counts non-BMP Frame label limits by Unicode code point", () => {
  const manifest = (defaultLabel: string, localizedLabel: string): FramePackManifest => ({
    version: 1,
    pack: { key: "party", label: "Party" },
    templates: {
      frame: {
        label: defaultLabel,
        labels: { ar: localizedLabel },
        shots: 1,
        intervalMs: 3000,
        canvas: { w: 100, h: 100 },
        background: "#fff",
        slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      },
    },
  });

  expect(validateFramePacks([manifest("😀".repeat(80), "🎉".repeat(80))])).toEqual([]);
  expect(validateFramePacks([manifest("😀".repeat(81), "🎉".repeat(81))])).toEqual(
    expect.arrayContaining([
      {
        path: "party.templates.frame.label",
        message: "label must be at most 80 characters",
      },
      {
        path: "party.templates.frame.labels.ar",
        message: "localized label must be at most 80 characters",
      },
    ])
  );
});
