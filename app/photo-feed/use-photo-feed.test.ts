import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  PhotoFeedRuntime,
  usePhotoFeed,
  type PhotoFeedRuntimeProviders,
} from "./use-photo-feed";
import { PROJECTOR_FEED_PROFILE } from "./controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  const requests: Array<{
    url: string;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<unknown>>;
  }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const providers: PhotoFeedRuntimeProviders = {
    fetch: (url, init) => {
      const response = deferred<unknown>();
      requests.push({ url, signal: init.signal, response });
      return response.promise;
    },
    random: () => 0,
    timer: {
      setTimeout(callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    visibility: {
      isVisible: () => visible,
      subscribe(listener) {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
  };
  return {
    providers,
    requests,
    timers,
    setVisible(value: boolean) {
      visible = value;
      visibilityListeners.forEach((listener) => listener());
    },
  };
}

describe("PhotoFeedRuntime", () => {
  test("the production hook is safe during Next server rendering", () => {
    function Probe() {
      const feed = usePhotoFeed("show", PROJECTOR_FEED_PROFILE);
      return createElement("span", null, feed.status);
    }

    expect(() => renderToString(createElement(Probe))).not.toThrow();
  });

  test("validates a response and exposes latest inserted photos", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    expect(h.requests[0]?.url).toBe("/api/photos?event=show");

    h.requests[0]!.response.resolve({
      photos: [{ key: "events/show/a.jpg", url: "/a", uploadedAt: "2026-07-24T00:00:00Z" }],
      cursor: "opaque",
      ignored: true,
    });
    await flushPromises();

    expect(runtime.snapshot().photos).toHaveLength(1);
    expect(runtime.snapshot().inserted.map((photo) => photo.key)).toEqual(["events/show/a.jpg"]);
    expect(h.timers.size).toBe(1);
  });

  test("malformed responses retain photos and enter retryable error state", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    h.requests[0]!.response.resolve({ photos: [{ key: 1 }], cursor: "bad" });
    await flushPromises();

    expect(runtime.snapshot()).toMatchObject({ photos: [], status: "error" });
    expect(h.timers.size).toBe(1);
  });

  test("awaits abort settlement before starting a queued refresh", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    runtime.refresh();

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.signal.aborted).toBeTrue();
    h.requests[0]!.response.reject(new DOMException("Aborted", "AbortError"));
    await flushPromises();
    expect(h.requests).toHaveLength(2);
  });

  test("an aborted request that resolves cannot apply stale photos or consume the refresh", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    runtime.refresh();
    h.requests[0]!.response.resolve({
      photos: [{ key: "events/show/stale.jpg", url: "/stale", uploadedAt: "2026-07-24T00:00:00Z" }],
      cursor: "stale",
    });
    await flushPromises();

    expect(runtime.snapshot().photos).toEqual([]);
    expect(h.requests).toHaveLength(2);
  });

  test("cancels timers while hidden and refreshes on foreground", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    h.requests[0]!.response.resolve({ photos: [], cursor: null });
    await flushPromises();
    expect(h.timers.size).toBe(1);

    h.setVisible(false);
    expect(h.timers.size).toBe(0);
    h.setVisible(true);
    expect(h.requests).toHaveLength(2);
  });

  test("event change and disposal abort active work and reset state", () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    runtime.setEvent("other");
    expect(h.requests[0]!.signal.aborted).toBeTrue();
    expect(runtime.snapshot()).toMatchObject({ event: "other", photos: [], cursor: null });

    runtime.dispose();
    expect(h.requests.at(-1)!.signal.aborted).toBeTrue();
  });

  test("event change queues the new Event until the aborted request settles", async () => {
    const h = harness();
    const runtime = new PhotoFeedRuntime("show", PROJECTOR_FEED_PROFILE, h.providers);
    runtime.start();
    runtime.setEvent("other");

    expect(h.requests).toHaveLength(1);
    h.requests[0]!.response.resolve({ photos: [], cursor: null });
    await flushPromises();

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.url).toBe("/api/photos?event=other");
  });
});
