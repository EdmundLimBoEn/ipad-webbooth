import { expect, test } from "bun:test";
import { wrap } from "./wrap";

test("in-range position is unchanged", () => {
  expect(wrap(150, 400)).toBe(150);
});

test("forward wrap past the period", () => {
  expect(wrap(450, 400)).toBe(50);
});

test("negative position wraps to the end", () => {
  expect(wrap(-50, 400)).toBe(350);
});

test("delta larger than several periods", () => {
  expect(wrap(1250, 400)).toBe(50);
  expect(wrap(-1250, 400)).toBe(350);
});

test("exact period lands on zero", () => {
  expect(wrap(400, 400)).toBe(0);
});

test("zero or negative period returns 0", () => {
  expect(wrap(123, 0)).toBe(0);
  expect(wrap(123, -5)).toBe(0);
});

test("each projector column wraps against its own independent period", () => {
  expect(wrap(450, 400)).toBe(50);
  expect(wrap(450, 275)).toBe(175);
});
