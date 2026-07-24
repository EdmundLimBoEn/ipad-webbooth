import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoothUnlock } from "./booth-unlock";

const secret = "never-render-this-booth-key";

function render(
  state: "locked" | "checking" | "recovery-only" | "unavailable",
  pendingCount = 0
) {
  return renderToStaticMarkup(
    <BoothUnlock
      event="launch"
      state={state}
      pendingCount={pendingCount}
      durable
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
});

describe("Booth startup integration", () => {
  test("recovers the Outbox before credential access and uses authenticated preflight", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();
    const recoverAt = source.indexOf("await session.recover()");
    const credentialAt = source.indexOf("const stored = loadBoothCredential(");

    expect(recoverAt).toBeGreaterThan(-1);
    expect(credentialAt).toBeGreaterThan(recoverAt);
    expect(source).toContain("/api/booth/preflight?event=");
    expect(source).toContain('"x-booth-key": key');
    expect(source).not.toContain("window.prompt");
    expect(source).not.toContain("/api/config?event=");
  });

  test("gates retry and camera start on successful preflight and relocks on 401", async () => {
    const source = await Bun.file(`${import.meta.dir}/page.tsx`).text();
    const successfulPreflight = source.indexOf("if (response.ok)");
    const readyBranch = source.slice(successfulPreflight, source.indexOf("} catch", successfulPreflight));

    expect(successfulPreflight).toBeGreaterThan(-1);
    expect(readyBranch).toContain("session.start()");
    expect(readyBranch).toContain("startCamera()");
    expect(source).toContain(
      "clearBoothCredential(event, window.sessionStorage, window.localStorage)"
    );
    expect(source).toContain('accessState !== "ready"');
    expect(source).toContain("request !== cameraRequestRef.current");
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
