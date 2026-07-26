import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrowseGalleryView,
  browseGalleryUrl,
  correlateSelectedPhoto,
  mergeBrowsePhotos,
  openBrowsePhoto,
  restoreBrowseUrl,
} from "./handoff-gallery";

const newest = {
  key: "show/0000000003000-new.jpg",
  url: "https://photos.example/show/new.jpg",
  uploadedAt: "2026-07-24T12:03:00.000Z",
};
const direct = {
  key: "show/0000000001000-direct.jpg",
  url: "https://photos.example/show/direct.jpg",
  uploadedAt: "2026-07-24T12:01:00.000Z",
};

function render(input: Partial<Parameters<typeof BrowseGalleryView>[0]> = {}) {
  return renderToStaticMarkup(
    <BrowseGalleryView
      locale="en"
      photos={[]}
      feedStatus="loading"
      feedError={null}
      directState={null}
      newPhotoCount={0}
      onOpen={() => {}}
      onRetryFeed={() => {}}
      onRetryDirect={() => {}}
      onJumpLatest={() => {}}
      {...input}
    />
  );
}

describe("phone browse Gallery presentation", () => {
  test("a missing photo query opens the browse feed instead of an invalid-link page", () => {
    const html = render();
    expect(html).toContain("Event photos");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("This photo link is invalid.");
  });

  test("renders semantic newest-first exact-key tiles and ready/empty states", () => {
    const html = render({ photos: [newest, direct], feedStatus: "ready" });
    expect(html.indexOf(newest.url)).toBeLessThan(html.indexOf(direct.url));
    expect(html).toContain(`data-photo-key="${newest.key}"`);
    expect(html.match(/<button/g)?.length).toBeGreaterThanOrEqual(2);
    expect(render({ feedStatus: "ready" })).toContain("Ready for the first photo.");
  });

  test("retains browse tiles and manual retry when the feed fails", () => {
    const html = render({
      photos: [newest],
      feedStatus: "error",
      feedError: "venue network unavailable",
    });
    expect(html).toContain(newest.url);
    expect(html).toContain("venue network unavailable");
    expect(html).toContain(">Try again</button>");
  });

  test("shows a retryable direct-link failure without replacing browse", () => {
    const html = render({
      photos: [newest],
      feedStatus: "ready",
      directState: { kind: "not-found" },
    });
    expect(html).toContain(newest.url);
    expect(html).toContain("This photo is no longer available.");
    expect(html).toContain(">Try again</button>");
  });

  test("announces incoming photos and exposes Jump to latest", () => {
    const html = render({
      photos: [newest],
      feedStatus: "ready",
      newPhotoCount: 3,
    });
    expect(html).toContain("3 new photos");
    expect(html).toContain("Jump to latest");
  });

  test("uses RTL catalog and semantic photo labels", () => {
    const html = render({
      locale: "ar",
      photos: [newest],
      feedStatus: "ready",
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('aria-label="افتح صورة الفعالية"');
  });
});

describe("browse exact-photo correlation and history", () => {
  test("deduplicates one direct photo when it arrives in the feed", () => {
    expect(mergeBrowsePhotos([newest, direct], direct)).toEqual([newest, direct]);
    expect(correlateSelectedPhoto(direct, [
      newest,
      { ...direct, url: "https://photos.example/show/fresh.jpg" },
    ])?.url).toBe("https://photos.example/show/fresh.jpg");
  });

  test("writes one exact-photo query without navigation and restores browse URL", () => {
    const calls: Array<{ kind: string; url: string }> = [];
    const history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        calls.push({ kind: "push", url: String(url) });
      },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        calls.push({ kind: "replace", url: String(url) });
      },
    };
    const exact = openBrowsePhoto(
      history,
      "https://booth.example/current",
      "show",
      direct.key
    );
    restoreBrowseUrl(history, "https://booth.example/current", "show");

    expect(exact).toBe(
      "https://booth.example/show/gallery?photo=show%2F0000000001000-direct.jpg"
    );
    expect(calls).toEqual([
      { kind: "push", url: exact },
      { kind: "replace", url: "https://booth.example/show/gallery" },
    ]);
    expect(browseGalleryUrl("https://booth.example/current", "show"))
      .toBe("https://booth.example/show/gallery");
  });
});
