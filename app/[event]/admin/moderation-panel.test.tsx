import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModerationPanel } from "./moderation-panel";

test("renders scalable localized moderation controls without claiming an Event total", () => {
  const html = renderToStaticMarkup(
    <ModerationPanel
      locale="zh-SG"
      photos={[{
        key: "launch/1753315200000-photo.jpg",
        url: "https://photos.example/photo.jpg",
        uploadedAt: "2026-07-24T00:00:00.000Z",
        capturedAt: 1_753_315_200_000,
      }]}
      filters={{ from: "", to: "" }}
      nextCursor="cursor"
      loading={false}
      loadingMore={false}
      error=""
      notice=""
      rebuild={{ complete: false, scanned: 100, indexed: 98 }}
      rebuilding={false}
      onFiltersChange={() => {}}
      onApplyFilters={() => {}}
      onClearFilters={() => {}}
      onLoadMore={() => {}}
      onOpen={() => {}}
      onRebuild={() => {}}
    />
  );

  expect(html).toContain('aria-labelledby="moderation-heading"');
  expect(html).toContain('for="moderation-from"');
  expect(html).toContain('for="moderation-to"');
  expect(html).toContain("已载入 1 张");
  expect(html).not.toContain("活动共有");
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('type="button"');
  expect(html).toContain("继续重建");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('role="alert"');
  expect(html).not.toMatch(/receipt|revision|device/i);
});

test("marks Load More busy and disabled while preserving a labelled photo button", () => {
  const html = renderToStaticMarkup(
    <ModerationPanel
      locale="ar"
      photos={[{
        key: "launch/photo.jpg",
        url: "https://photos.example/photo.jpg",
        uploadedAt: "2026-07-24T00:00:00.000Z",
        capturedAt: 1_753_315_200_000,
      }]}
      filters={{ from: "", to: "" }}
      nextCursor="cursor"
      loading={false}
      loadingMore
      error=""
      notice=""
      rebuild={null}
      rebuilding={false}
      onFiltersChange={() => {}}
      onApplyFilters={() => {}}
      onClearFilters={() => {}}
      onLoadMore={() => {}}
      onOpen={() => {}}
      onRebuild={() => {}}
    />
  );

  expect(html).toContain('dir="rtl"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('disabled=""');
  expect(html).toContain("افتح الصورة");
});
