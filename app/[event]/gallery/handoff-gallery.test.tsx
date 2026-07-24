import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HandoffGalleryView,
  parseDirectPhotoQuery,
  transferPublicPhoto,
  type HandoffGalleryState,
} from "./handoff-gallery";

const photo = {
  key: "launch/0000000001000-photo.jpg",
  url: "https://photos.example/launch/0000000001000-photo.jpg",
  uploadedAt: "2026-07-24T12:00:00.000Z",
};

function render(state: HandoffGalleryState, locale: "en" | "zh-SG" | "ar" = "en") {
  return renderToStaticMarkup(
    <HandoffGalleryView state={state} locale={locale} onRetry={() => {}} onSave={() => {}} />
  );
}

describe("direct photo query", () => {
  test("accepts exactly one already-decoded complete photo query value", () => {
    expect(parseDirectPhotoQuery(new URLSearchParams(`photo=${encodeURIComponent(photo.key)}`))).toBe(photo.key);
    expect(parseDirectPhotoQuery(new URLSearchParams("photo=launch%252Fdouble-decoded.jpg"))).toBe("launch%2Fdouble-decoded.jpg");
  });

  test("rejects missing and repeated photo query values", () => {
    expect(parseDirectPhotoQuery(new URLSearchParams())).toBeNull();
    expect(parseDirectPhotoQuery(new URLSearchParams("photo=one&photo=two"))).toBeNull();
  });
});

describe("direct photo Gallery shell", () => {
  test("renders loading and all recoverable status states in focusable live UI", () => {
    expect(render({ kind: "loading" })).toContain('role="status"');
    for (const state of ["invalid", "not-found", "offline", "error"] as const) {
      const html = render({ kind: state });
      expect(html).toContain('role="alert"');
      expect(html).toContain('tabindex="-1"');
      expect(html).toContain(">Try again</button>");
    }
  });

  test("shows only a semantic exact photo with a visible save or share action", () => {
    const html = render({ kind: "ready", photo });

    expect(html).toContain(`<img src="${photo.url}"`);
    expect(html).toContain("Save or share");
    expect(html).not.toContain("/api/photos");
    expect(html).not.toMatch(/receipt|frame|revision|credential|photo-index/i);
  });

  test("uses the existing Arabic catalog and RTL direction", () => {
    const html = render({ kind: "not-found" }, "ar");

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("هذه الصورة لم تعد متاحة.");
  });

  test("falls back to a browser download when file sharing is unavailable", async () => {
    const downloads: Array<{ filename: string; blob: Blob }> = [];
    const outcome = await transferPublicPhoto(photo, {
      fetchPhoto: async () => new Response(new Blob(["photo"], { type: "image/jpeg" })),
      canShare: () => false,
      share: async () => {},
      download: (blob, filename) => downloads.push({ blob, filename }),
    });

    expect(outcome).toBe("downloaded");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe("0000000001000-photo.jpg");
  });
});
