import { expect, test } from "bun:test";

function declarationBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
}

test("configuration history is a horizontal square contact strip", async () => {
  const css = await Bun.file(`${import.meta.dir}/admin.module.css`).text();
  const rail = declarationBlock(css, ".revisionRail");
  const record = declarationBlock(css, ".revisionRecord");

  expect(rail).toContain("flex-direction: row");
  expect(rail).toContain("overflow-x: auto");
  expect(rail).toContain("background: var(--ink)");
  expect(record).toContain("aspect-ratio: 1");
  expect(record).toContain("flex:");
});

test("preset actions remain touch sized and reflow as a call sheet", async () => {
  const css = await Bun.file(`${import.meta.dir}/admin.module.css`).text();
  const actions = declarationBlock(
    css,
    ".presetSave, .presetLibraryRow button, .presetList button, .presetConfirm button",
  );
  const workspace = declarationBlock(css, ".presetWorkspace");
  const rtl = declarationBlock(css, ".presetPanel[dir=\"rtl\"]");

  expect(actions).toContain("min-height: 44px");
  expect(workspace).toContain("grid-template-columns");
  expect(rtl).toContain("text-align: start");
  expect(css).toContain("@media (max-width: 700px)");
  expect(css).toContain("@media (forced-colors: active)");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});
