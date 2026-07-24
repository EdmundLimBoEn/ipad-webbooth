import { describe, expect, test } from "bun:test";
import {
  exactGalleryUrl,
  savePhoto,
  sharePhoto,
  type PhotoActionDeps,
} from "./photo-actions";

const photo = {
  key: "events/show/1700000000000 guest/photo.jpg",
  url: "https://photos.example/events/show/photo.jpg",
  uploadedAt: "2026-07-24T12:00:00.000Z",
};

function deps(overrides: Partial<PhotoActionDeps> = {}): PhotoActionDeps & {
  actions: string[];
} {
  const actions: string[] = [];
  return {
    actions,
    fetchBlob: async (url) => {
      actions.push(`fetch:${url}`);
      return new Blob(["photo"], { type: "image/jpeg" });
    },
    canShare: (data) => {
      actions.push(data.files ? "can-share:file" : "can-share:link");
      return Boolean(data.files);
    },
    share: async (data) => {
      actions.push(data.files ? "share:file" : `share:${data.url}`);
    },
    createObjectURL: () => {
      actions.push("object:create");
      return "blob:photo";
    },
    revokeObjectURL: (url) => actions.push(`object:revoke:${url}`),
    download: (url, filename) => actions.push(`download:${url}:${filename}`),
    ...overrides,
  };
}

describe("exact Gallery actions", () => {
  test("encodes the complete key as one photo query value", () => {
    const url = exactGalleryUrl("https://booth.example/current", "show", photo.key);
    expect(url).toBe(
      "https://booth.example/show/gallery?photo=events%2Fshow%2F1700000000000+guest%2Fphoto.jpg"
    );
    expect(new URL(url).searchParams.getAll("photo")).toEqual([photo.key]);
  });

  test("prefers exact prefetched bytes for native file share", async () => {
    const runtime = deps();
    const blob = new Blob(["exact"], { type: "image/jpeg" });
    const result = await savePhoto({
      photo,
      prefetched: { key: photo.key, url: photo.url, blob },
      exactUrl: exactGalleryUrl("https://booth.example", "show", photo.key),
      deps: runtime,
    });

    expect(result).toEqual({ kind: "shared" });
    expect(runtime.actions).toEqual(["can-share:file", "share:file"]);
  });

  test("never reuses stale prefetched bytes for a newer exact photo", async () => {
    const runtime = deps();
    await savePhoto({
      photo,
      prefetched: {
        key: "events/show/old.jpg",
        url: photo.url,
        blob: new Blob(["old"], { type: "image/jpeg" }),
      },
      exactUrl: exactGalleryUrl("https://booth.example", "show", photo.key),
      deps: runtime,
    });

    expect(runtime.actions[0]).toBe(`fetch:${photo.url}`);
  });

  test("shares the same visible exact URL when file sharing is unavailable", async () => {
    const runtime = deps({
      canShare: () => false,
    });
    const exactUrl = exactGalleryUrl("https://booth.example", "show", photo.key);
    const result = await sharePhoto({
      photo,
      prefetched: null,
      exactUrl,
      deps: runtime,
    });

    expect(result).toEqual({ kind: "shared" });
    expect(runtime.actions).toContain(`share:${exactUrl}`);
  });

  test("always revokes object URL download fallbacks", async () => {
    const runtime = deps({
      canShare: () => false,
      share: async () => {
        throw new Error("link share unavailable");
      },
    });
    const result = await savePhoto({
      photo,
      prefetched: null,
      exactUrl: exactGalleryUrl("https://booth.example", "show", photo.key),
      deps: runtime,
    });

    expect(result).toEqual({ kind: "downloaded" });
    expect(runtime.actions).toContain("object:create");
    expect(runtime.actions).toContain("object:revoke:blob:photo");
  });

  test("treats native share cancellation as a non-error outcome", async () => {
    const runtime = deps({
      share: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    });
    const result = await savePhoto({
      photo,
      prefetched: { key: photo.key, url: photo.url, blob: new Blob(["photo"]) },
      exactUrl: exactGalleryUrl("https://booth.example", "show", photo.key),
      deps: runtime,
    });

    expect(result).toEqual({ kind: "cancelled" });
  });
});
