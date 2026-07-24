import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BoothUnlock,
  createUnlockFormState,
  unlockFormReducer,
} from "./booth-unlock";
import type { BoothAccessFeedback } from "./booth-session/lifecycle";

const secret = "never-render-this-booth-key";

function render(
  state: "locked" | "checking" | "recovery-only" | "unavailable",
  pendingCount = 0,
  feedback?: BoothAccessFeedback,
  durable = true
) {
  return renderToStaticMarkup(
    <BoothUnlock
      event="launch"
      state={state}
      pendingCount={pendingCount}
      durable={durable}
      feedback={feedback}
      onUnlock={(key) => {
        if (key === secret) throw new Error("not called during static render");
      }}
      onRetry={() => {}}
    />
  );
}

describe("Booth unlock", () => {
  test("locked markup has labeled password and remember controls", () => {
    const html = render("locked");

    expect(html).toMatch(/<h1[^>]*>Unlock Booth<\/h1>/);
    expect(html).toMatch(/<label[^>]*for="booth-key"/);
    expect(html).toMatch(/<input[^>]*id="booth-key"[^>]*type="password"/);
    expect(html).toContain("Remember on this iPad");
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toContain('role="status"');
  });

  test("a supplied key remains only in the callback and never enters markup", () => {
    const html = render("locked");

    expect(html).not.toContain(secret);
  });

  test("checking is explicit and prevents duplicate unlock attempts", () => {
    const html = render("checking", 2);

    expect(html).toContain("Checking Booth access");
    expect(html).toContain("2 photos waiting safely");
    expect(html).toContain("disabled");
    expect(html).not.toContain(secret);
  });

  test("recovery-only explains that pending photos remain without enabling capture", () => {
    const html = render("recovery-only", 1);

    expect(html).toContain("Connection needed");
    expect(html).toContain("1 photo waiting safely");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("<input");
  });

  test("unavailable gives the operator a plain retry action", () => {
    const html = render("unavailable");

    expect(html).toContain("Booth unavailable");
    expect(html).toContain("Check the Event setup, then try again.");
    expect(html).toContain(">Try again</button>");
  });

  test("announces rejected credentials with fixed non-secret copy", () => {
    const html = render("locked", 2, "rejected-key");

    expect(html).toContain('role="alert"');
    expect(html).toContain("Booth Key rejected. Enter the current key and try again.");
    expect(html).not.toContain(secret);
  });

  test.each([
    ["checking", "Checking Booth access online."],
    ["network", "Could not reach Booth service. Pending photos are still safe."],
    ["unavailable", "This Event is not ready for Booth capture."],
  ] satisfies Array<[BoothAccessFeedback, string]>)(
    "announces %s feedback in the live region",
    (feedback, message) => {
      expect(render(
        feedback === "network" ? "recovery-only" : feedback === "unavailable" ? "unavailable" : "checking",
        0,
        feedback
      )).toContain(message);
    }
  );

  test("never describes memory-only pending photos as safe", () => {
    const html = render("recovery-only", 2, "network", false);

    expect(html).toContain("2 photos waiting in this open page");
    expect(html).toContain("reload recovery is unavailable");
    expect(html.toLowerCase()).not.toContain("safe");
  });

  test("changing Event identity clears typed key and remember state", () => {
    let form = createUnlockFormState("first");
    form = unlockFormReducer(form, { type: "key-changed", key: secret });
    form = unlockFormReducer(form, { type: "remember-changed", remember: true });
    form = unlockFormReducer(form, { type: "event-changed", event: "second" });

    expect(form).toEqual({ event: "second", key: "", remember: false });
  });
});

describe("Booth page safety wiring", () => {
  test("uses authenticated preflight without prompt or public config startup", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();

    expect(source).toContain("/api/booth/preflight?event=");
    expect(source).not.toContain("window.prompt");
    expect(source).not.toContain("/api/config?event=");
    expect(source).toContain("key={event}");
    expect(source).toContain('const credential: BoothCredentialHolder = { key: "" }');
    expect(source).toContain('"x-booth-key": credential.key');
    expect(source).not.toContain("keyRef");
  });

  test("verified Operator exit tears down the lifecycle-owned credential", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();

    expect(source).toContain("await lifecycle.leaveEvent(session)");
    expect(source).not.toContain("await sessionRef.current?.stop()");
  });

  test("keeps the file-camera input keyboard and switch accessible", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();
    const css = await Bun.file(`${import.meta.dir}/booth.module.css`).text();

    expect(source).toContain("className={styles.fileInput}");
    expect(source).not.toContain("disabled={accessState !== \"ready\" || operational.paused}\n              hidden");
    expect(css).toContain(".fileInput");
    expect(css).toContain(".fileBtn:focus-within");
    expect(css).toContain("min-height: 56px");
  });
});

describe("Booth unlock presentation", () => {
  test("keeps touch controls large and keyboard focus visible in forced colors", async () => {
    const css = await Bun.file(`${import.meta.dir}/booth.module.css`).text();

    expect(css).toContain("min-height: 44px");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("outline:");
  });

  test("removes unlock motion when reduced motion is requested", async () => {
    const css = await Bun.file(`${import.meta.dir}/booth.module.css`).text();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });
});

describe("Booth operational integration", () => {
  test("shows pause and connectivity states with touch-safe focus treatment", async () => {
    const css = await Bun.file(`${import.meta.dir}/booth.module.css`).text();

    expect(css).toContain(".operationalPause");
    expect(css).toContain(".connectivity");
    expect(css).toContain(".choice:focus-visible");
    expect(css).toContain("min-height: 44px");
  });
});
