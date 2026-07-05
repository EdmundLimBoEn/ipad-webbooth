import { test, expect } from "bun:test";
import { coverRect, containRect, availableTemplates, TEMPLATES, GROUPS } from "./templates";

test("no config -> only ungrouped default frames", () => {
  expect(availableTemplates(null)).toEqual(["square"]);
});

test("a saved config is the complete list — defaults can be off", () => {
  expect(availableTemplates(["lighthouse", "beacon"])).toEqual(["lighthouse", "beacon"]);
  expect(availableTemplates(["square", "starry"])).toEqual(["square", "starry"]);
  expect(availableTemplates([])).toEqual([]);
});

test("unknown keys are ignored", () => {
  expect(availableTemplates(["nope", "starry"])).toEqual(["starry"]);
});

test("every grouped template's group exists in GROUPS", () => {
  for (const t of Object.values(TEMPLATES)) {
    if (t.group) expect(GROUPS[t.group]).toBeString();
  }
});

test("square into square = full image", () => {
  const r = coverRect(1000, 1000, 500, 500);
  expect(r).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 1000 });
});

test("wide image into square slot crops the sides", () => {
  const r = coverRect(1600, 900, 500, 500); // 16:9 into 1:1
  expect(r.sh).toBe(900); // full height kept
  expect(r.sw).toBe(900); // cropped to square
  expect(r.sx).toBe(350); // centered
  expect(r.sy).toBe(0);
});

test("tall image into wide slot crops top/bottom", () => {
  const r = coverRect(900, 1600, 540, 500); // portrait into ~square-ish
  expect(r.sw).toBe(900); // full width kept
  expect(Math.round(r.sh)).toBe(833);
  expect(r.sx).toBe(0);
});

test("contain: 16:9 photo into 16:9 slot fills exactly, no bands", () => {
  const r = containRect(1920, 1080, 640, 360); // both 16:9
  expect(r).toEqual({ dx: 0, dy: 0, dw: 640, dh: 360 });
});

test("contain: 4:3 photo into 16:9 slot shows full photo with side bands", () => {
  const r = containRect(1440, 1080, 640, 360); // 4:3 into 16:9
  expect(r.dh).toBe(360); // full height used
  expect(r.dw).toBe(480); // narrower than slot → pillarboxed
  expect(r.dx).toBe(80); // centered: (640-480)/2
  expect(r.dy).toBe(0);
});

test("contain: never crops — drawn box fits inside the slot", () => {
  const r = containRect(1920, 1080, 640, 640); // 16:9 into square
  expect(r.dw).toBeLessThanOrEqual(640);
  expect(r.dh).toBeLessThanOrEqual(640);
  expect(r.dx).toBe(0);
  expect(Math.round(r.dh)).toBe(360); // letterboxed top/bottom
});
