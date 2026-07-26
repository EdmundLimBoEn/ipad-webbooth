import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RehearsalPanel } from "./rehearsal-panel";

test("renders an accessible localized start surface without exposing the Admin Key", () => {
  const html = renderToStaticMarkup(
    <RehearsalPanel
      event="launch"
      adminKey="never-render-this-secret"
      locale="zh-SG"
      origin="https://booth.example"
      onUnauthorized={() => {}}
    />,
  );
  expect(html).toContain('aria-labelledby="rehearsal-panel-title"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("真实设备演练");
  expect(html).toContain("开始演练");
  expect(html).not.toContain("never-render-this-secret");
  expect(html).not.toMatch(/cleanup all|bulk delete/i);
});
