import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OperatorControls,
  performVerifiedOperatorExit,
} from "./operator-controls";

function exitHarness(verified: boolean) {
  const actions: string[] = [];
  const result = performVerifiedOperatorExit("fresh-key", {
    verify: async (key) => {
      actions.push(`verify:${key}`);
      return verified;
    },
    stopCamera: () => actions.push("stop-camera"),
    releaseWake: async () => {
      actions.push("release-wake");
    },
    stopHeartbeat: () => actions.push("stop-heartbeat"),
    stopPoller: () => actions.push("stop-poller"),
    stopSession: async () => {
      actions.push("stop-session");
    },
    clearCredentials: () => actions.push("clear-credentials"),
    clearActiveCredential: () => actions.push("clear-active-credential"),
    markExited: () => actions.push("mark-exited"),
  });
  return { actions, result };
}

describe("authenticated operator exit", () => {
  test("failed fresh verification changes no resources or credentials", async () => {
    const { actions, result } = exitHarness(false);

    expect(await result).toBe("rejected");
    expect(actions).toEqual(["verify:fresh-key"]);
  });

  test("verified exit stops runtime resources before clearing exact credentials", async () => {
    const { actions, result } = exitHarness(true);

    expect(await result).toBe("exited");
    expect(actions).toEqual([
      "verify:fresh-key",
      "stop-camera",
      "release-wake",
      "stop-heartbeat",
      "stop-poller",
      "stop-session",
      "clear-credentials",
      "clear-active-credential",
      "mark-exited",
    ]);
  });

  test("renders a discoverable fresh-key control without exposing a key", () => {
    const secret = "never-render-this-key";
    const html = renderToStaticMarkup(
      <OperatorControls
        event="launch-night"
        pendingCount={2}
        onOperatorGesture={() => {}}
        onExit={async (key) => key === secret ? "exited" : "rejected"}
      />
    );

    expect(html).toContain("Operator");
    expect(html).toContain("Exit Booth");
    expect(html).toContain('type="password"');
    expect(html).toContain("2 pending photos will stay in the Photo Outbox.");
    expect(html).not.toContain(secret);
  });
});
