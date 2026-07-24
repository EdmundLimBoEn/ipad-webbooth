import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptureReview } from "./capture-review";

const labels = {
  usePhoto: "保留照片",
  retake: "重新拍摄",
  moreTime: "延长时间",
  accepting: "正在安全保存…",
  preview: "准确的照片预览",
};

function render(accepting: boolean, error: string | null = null) {
  return renderToStaticMarkup(
    <CaptureReview
      canvas={{ width: 1200, height: 1800 } as HTMLCanvasElement}
      autoAcceptSeconds={5}
      accepting={accepting}
      error={error}
      labels={labels}
      onAccept={() => {}}
      onRetake={() => {}}
      onMoreTime={() => {}}
    />,
  );
}

test("labels the exact-canvas preview and defaults focus to localized Use Photo", () => {
  const html = render(false);

  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="准确的照片预览"');
  expect(html).toContain("保留照片");
  expect(html).toContain("重新拍摄");
  expect(html).toContain("延长时间");
  expect(html).toContain('autofocus=""');
  expect(html).toContain('aria-live="polite"');
});

test("accepting disables every decision and announces localized progress", () => {
  const html = render(true);

  expect(html.match(/disabled=""/g)?.length).toBe(3);
  expect(html).toContain('role="status"');
  expect(html).toContain("正在安全保存…");
});

test("an acceptance error is exposed as an accessible alert without replacing the preview", () => {
  const html = render(false, "无法保存这张照片");

  expect(html).toContain('role="alert"');
  expect(html).toContain("无法保存这张照片");
  expect(html).toContain('aria-label="准确的照片预览"');
});
