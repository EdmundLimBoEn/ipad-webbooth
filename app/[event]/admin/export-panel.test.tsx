import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportPanel } from "./export-panel";

const render = (locale: "en" | "zh-SG" | "ar" = "en") =>
  renderToStaticMarkup(
    <ExportPanel
      event="launch"
      adminKey="never-render-this-secret"
      locale={locale}
      onUnauthorized={() => {}}
      onNotice={() => {}}
      onError={() => {}}
    />,
  );

test("renders an accessible primary package action and secondary compatibility action", () => {
  const html = render();
  expect(html).toContain("<h2");
  expect(html).toContain("Post-event package");
  expect(html).toContain("manifest");
  expect(html).toContain("analytics");
  expect(html).toContain("printable contact sheet");
  expect(html).toContain(">Download event package</button>");
  expect(html).toContain(">Download photos only</button>");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toMatch(/Export \d+ photos/);
  expect(html).not.toContain("never-render-this-secret");
  expect(html).not.toContain("href=");
  expect(html).not.toContain("localStorage");
});

test("renders complete localized copy and Arabic direction", () => {
  expect(render("zh-SG")).toContain("下载活动资料包");
  const arabic = render("ar");
  expect(arabic).toContain('dir="rtl"');
  expect(arabic).toContain("تنزيل حزمة الحدث");
});
