import { describe, expect, test } from "bun:test";
import { transitionBoothAccess, type BoothAccessState } from "./access";

describe("Booth access state", () => {
  test("a valid online preflight moves locked through checking to ready", () => {
    const checking = transitionBoothAccess("locked", { type: "check" });
    const ready = transitionBoothAccess(checking, { type: "preflight-ready" });

    expect(checking).toBe("checking");
    expect(ready).toBe("ready");
  });

  test("a preflight network failure enters recovery-only", () => {
    expect(
      transitionBoothAccess("checking", { type: "preflight-network-failed" })
    ).toBe("recovery-only");
  });

  test.each([409, 503] as const)(
    "preflight status %s enters unavailable",
    (status) => {
      expect(
        transitionBoothAccess("checking", {
          type: "preflight-unavailable",
          status,
        })
      ).toBe("unavailable");
    }
  );

  test.each([
    "checking",
    "ready",
    "recovery-only",
    "unavailable",
  ] satisfies BoothAccessState[])(
    "a 401 relocks from %s",
    (state) => {
      expect(transitionBoothAccess(state, { type: "unauthorized" })).toBe("locked");
    }
  );

  test.each([
    "locked",
    "checking",
    "ready",
    "recovery-only",
    "unavailable",
  ] satisfies BoothAccessState[])(
    "operator exit moves %s to exited",
    (state) => {
      expect(transitionBoothAccess(state, { type: "exit" })).toBe("exited");
    }
  );

  test("retry checks again only from a recoverable access state", () => {
    expect(transitionBoothAccess("recovery-only", { type: "retry" })).toBe("checking");
    expect(transitionBoothAccess("unavailable", { type: "retry" })).toBe("checking");
    expect(transitionBoothAccess("ready", { type: "retry" })).toBe("ready");
  });
});
