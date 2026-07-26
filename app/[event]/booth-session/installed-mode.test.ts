import { describe, expect, test } from "bun:test";
import {
  ScreenWakeController,
  isStandalone,
  shouldWarnBeforeUnload,
  type WakeLockSentinelLike,
} from "./installed-mode";

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCalls = 0;

  async release() {
    this.releaseCalls++;
    this.released = true;
  }
}

describe("installed Booth mode", () => {
  test("detects standards-based and iOS standalone modes", () => {
    expect(isStandalone(() => ({ matches: true }), false)).toBe(true);
    expect(isStandalone(() => ({ matches: false }), true)).toBe(true);
    expect(isStandalone(() => ({ matches: false }), false)).toBe(false);
  });

  test("warns only while capture, durable handoff, or pending work exists", () => {
    expect(shouldWarnBeforeUnload({
      captureActive: false,
      durableHandoffActive: false,
      pendingCount: 0,
    })).toBe(false);
    expect(shouldWarnBeforeUnload({
      captureActive: false,
      durableHandoffActive: false,
      pendingCount: 1,
    })).toBe(true);
    expect(shouldWarnBeforeUnload({
      captureActive: true,
      durableHandoffActive: false,
      pendingCount: 0,
    })).toBe(true);
    expect(shouldWarnBeforeUnload({
      captureActive: false,
      durableHandoffActive: true,
      pendingCount: 0,
    })).toBe(true);
  });
});

describe("ScreenWakeController", () => {
  test("acquires one wake lock and releases that exact sentinel", async () => {
    const sentinel = new FakeSentinel();
    let requests = 0;
    const controller = new ScreenWakeController({
      request: async () => {
        requests++;
        return sentinel;
      },
    });

    expect(await controller.request()).toBe("active");
    expect(await controller.request()).toBe("active");
    expect(requests).toBe(1);

    await controller.release();
    expect(sentinel.releaseCalls).toBe(1);
  });

  test("reports unsupported and denied providers without throwing", async () => {
    expect(await new ScreenWakeController().request()).toBe("unsupported");
    expect(await new ScreenWakeController({
      request: async () => {
        throw new DOMException("not allowed", "NotAllowedError");
      },
    }).request()).toBe("denied");
  });

  test("reacquires after a visible-page return when the old lock was released", async () => {
    const sentinels = [new FakeSentinel(), new FakeSentinel()];
    let requests = 0;
    const controller = new ScreenWakeController({
      request: async () => sentinels[requests++],
    });

    await controller.request();
    sentinels[0].released = true;
    expect(await controller.handleVisibilityChange("hidden")).toBeUndefined();
    expect(requests).toBe(1);

    expect(await controller.handleVisibilityChange("visible")).toBe("active");
    expect(requests).toBe(2);
  });
});
