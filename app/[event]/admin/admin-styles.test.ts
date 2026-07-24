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
