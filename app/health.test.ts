import { describe, expect, test } from "bun:test";
import { decide } from "./health";

describe("decide", () => {
  test("steady up sends nothing", () => {
    expect(decide("up", "up")).toEqual({ report: null, next: "up" });
  });

  test("steady down sends nothing", () => {
    expect(decide("down", "down")).toEqual({ report: null, next: "down" });
  });

  test("up -> down reports", () => {
    expect(decide("up", "down")).toEqual({ report: "down", next: "down" });
  });

  test("down -> up reports", () => {
    expect(decide("down", "up")).toEqual({ report: "up", next: "up" });
  });

  test("up -> degraded reports", () => {
    expect(decide("up", "degraded")).toEqual({ report: "degraded", next: "degraded" });
  });

  test("degraded -> up reports", () => {
    expect(decide("degraded", "up")).toEqual({ report: "up", next: "up" });
  });

  test("steady degraded sends nothing", () => {
    expect(decide("degraded", "degraded")).toEqual({ report: null, next: "degraded" });
  });

  test("no state + up stays silent (first run)", () => {
    expect(decide(null, "up")).toEqual({ report: null, next: "up" });
  });

  test("no state + down reports", () => {
    expect(decide(null, "down")).toEqual({ report: "down", next: "down" });
  });
});
