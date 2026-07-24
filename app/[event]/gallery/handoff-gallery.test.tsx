import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  focusHandoffStatus,
  HandoffGalleryController,
  HandoffGalleryView,
  parseDirectPhotoQuery,
  prefetchPublicPhoto,
  transferPublicPhoto,
  type HandoffGalleryState,
} from "./handoff-gallery";

const photo = {
  key: "launch/0000000001000-photo.jpg",
  url: "https://photos.example/launch/0000000001000-photo.jpg",
  uploadedAt: "2026-07-24T12:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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

  test("prefetches before the click path and invokes native share synchronously", async () => {
    const order: string[] = [];
    const prefetched = await prefetchPublicPhoto(photo, async (url) => {
      expect(url).toBe(photo.url);
      return new Response(new Blob(["photo"], { type: "image/jpeg" }));
    });
    const transfer = transferPublicPhoto(photo, prefetched, {
      fetchPhoto: async () => {
        order.push("late fetch");
        return new Response();
      },
      canShare: () => {
        order.push("can share");
        return true;
      },
      share: async () => {
        order.push("share");
      },
      download: () => {
        order.push("download");
      },
    });

    expect(order).toEqual(["can share", "share"]);
    expect(await transfer).toBe("shared");
  });

  test("falls back to download when native sharing rejects", async () => {
    const downloads: Array<{ filename: string; blob: Blob }> = [];
    const prefetched = new Blob(["photo"], { type: "image/jpeg" });
    const outcome = await transferPublicPhoto(photo, prefetched, {
      fetchPhoto: async () => new Response(new Blob(["photo"], { type: "image/jpeg" })),
      canShare: () => true,
      share: async () => {
        throw new Error("native share rejected");
      },
      download: (blob, filename) => downloads.push({ blob, filename }),
    });

    expect(outcome).toBe("downloaded");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toBe("0000000001000-photo.jpg");
  });

  test("uses download without attempting late native share when prefetch is unavailable", async () => {
    const actions: string[] = [];
    const outcome = await transferPublicPhoto(photo, null, {
      fetchPhoto: async () => {
        actions.push("fetch");
        return new Response(new Blob(["photo"], { type: "image/jpeg" }));
      },
      canShare: () => {
        actions.push("can share");
        return true;
      },
      share: async () => {
        actions.push("share");
      },
      download: () => {
        actions.push("download");
      },
    });

    expect(outcome).toBe("downloaded");
    expect(actions).toEqual(["fetch", "download"]);
  });
});

describe("interactive direct photo Gallery", () => {
  test("loads the exact photo through loading and ready states", async () => {
    const states: HandoffGalleryState[] = [];
    const requests: string[] = [];
    const controller = new HandoffGalleryController({
      isOnline: () => true,
      fetchPhoto: async (url) => {
        requests.push(url);
        return Response.json(photo);
      },
      onState: (state) => states.push(state),
    });

    await controller.load("launch", photo.key);

    expect(requests).toEqual([
      `/api/photo?event=launch&key=${encodeURIComponent(photo.key)}`,
    ]);
    expect(states).toEqual([{ kind: "loading" }, { kind: "ready", photo }]);
  });

  test("maps invalid, not-found, offline, and network failures to explicit states", async () => {
    const states: HandoffGalleryState[] = [];
    const responses = [
      new Response(null, { status: 400 }),
      new Response(null, { status: 404 }),
    ];
    const controller = new HandoffGalleryController({
      isOnline: () => true,
      fetchPhoto: async () => responses.shift() ?? Promise.reject(new Error("offline")),
      onState: (state) => states.push(state),
    });

    await controller.load("launch", photo.key);
    await controller.load("launch", photo.key);
    await controller.load("launch", photo.key);

    expect(states.filter((state) => state.kind !== "loading").map((state) => state.kind))
      .toEqual(["invalid", "not-found", "error"]);

    const offlineStates: HandoffGalleryState[] = [];
    const offline = new HandoffGalleryController({
      isOnline: () => false,
      fetchPhoto: async () => {
        throw new Error("must not fetch");
      },
      onState: (state) => offlineStates.push(state),
    });
    await offline.load("launch", photo.key);
    expect(offlineStates).toEqual([{ kind: "offline" }]);
  });

  test("manual retry replaces an error with the exact photo", async () => {
    const states: HandoffGalleryState[] = [];
    let attempt = 0;
    const controller = new HandoffGalleryController({
      isOnline: () => true,
      fetchPhoto: async () => {
        attempt += 1;
        return attempt === 1 ? new Response(null, { status: 503 }) : Response.json(photo);
      },
      onState: (state) => states.push(state),
    });

    await controller.load("launch", photo.key);
    await controller.load("launch", photo.key);

    expect(states.at(-1)).toEqual({ kind: "ready", photo });
    expect(attempt).toBe(2);
  });

  test("aborts and fences a stale request after the Event and exact key change", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const firstPhoto = photo;
    const secondPhoto = {
      ...photo,
      key: "other/0000000002000-photo.jpg",
      url: "https://photos.example/other/0000000002000-photo.jpg",
    };
    const signals: AbortSignal[] = [];
    const states: HandoffGalleryState[] = [];
    let call = 0;
    const controller = new HandoffGalleryController({
      isOnline: () => true,
      fetchPhoto: (_url, init) => {
        signals.push(init.signal);
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
      onState: (state) => states.push(state),
    });

    const staleLoad = controller.load("launch", firstPhoto.key);
    const currentLoad = controller.load("other", secondPhoto.key);
    second.resolve(Response.json(secondPhoto));
    await currentLoad;
    first.resolve(Response.json(firstPhoto));
    await staleLoad;

    expect(signals[0]!.aborted).toBe(true);
    expect(states.at(-1)).toEqual({ kind: "ready", photo: secondPhoto });
    expect(states.filter((state) => state.kind === "ready")).toEqual([
      { kind: "ready", photo: secondPhoto },
    ]);
  });

  test("moves focus to status and save errors but not a ready photo", () => {
    let focuses = 0;
    const target = { focus: () => { focuses += 1; } };

    focusHandoffStatus(target, { kind: "loading" }, false);
    focusHandoffStatus(target, { kind: "ready", photo }, false);
    focusHandoffStatus(target, { kind: "ready", photo }, true);

    expect(focuses).toBe(2);
  });
});
