import { describe, expect, test } from "bun:test";
import { decide, probes } from "./health";
import { HEALTH_CANARY_KEY, InMemoryObjectStore } from "./event-store";

describe("decide", () => {
  test("steady up sends nothing", () => {
    expect(decide("up", "up")).toEqual({ report: null, next: "up" });
  });

  test("steady down sends nothing", () => {
    expect(decide("down", "down")).toEqual({ report: null, next: "down" });
  });

  test("up -> down reports", () => {
    expect(decide("up", "down")).toEqual({ report: "down", next: "down" });
  });

  test("down -> up reports", () => {
    expect(decide("down", "up")).toEqual({ report: "up", next: "up" });
  });

  test("up -> degraded reports", () => {
    expect(decide("up", "degraded")).toEqual({ report: "degraded", next: "degraded" });
  });

  test("degraded -> up reports", () => {
    expect(decide("degraded", "up")).toEqual({ report: "up", next: "up" });
  });

  test("steady degraded sends nothing", () => {
    expect(decide("degraded", "degraded")).toEqual({ report: null, next: "degraded" });
  });

  test("no state + up stays silent (first run)", () => {
    expect(decide(null, "up")).toEqual({ report: null, next: "up" });
  });

  test("no state + down reports", () => {
    expect(decide(null, "down")).toEqual({ report: "down", next: "down" });
  });
});

describe("storage probes", () => {
  test("writes, publicly reads, and deletes only the exact canary", async () => {
    const photos = new InMemoryObjectStore({ "event/real-photo.jpg": "real" });
    const state = new InMemoryObjectStore();
    const env = { PHOTOS: photos, STATE: state, R2_PUBLIC_BASE: "https://photos.example" } as unknown as CloudflareEnv;
    const result = await probes(env, async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toStartWith("/_health/canary/");
      const canary = await photos.get(decodeURIComponent(url.pathname.slice(1)));
      return new Response(await canary?.text(), { status: 200 });
    });
    expect(result.upload.status).toBe("up");
    expect(result.live.status).toBe("up");
    expect((await photos.list({ prefix: HEALTH_CANARY_KEY })).objects).toHaveLength(0);
    expect(photos.has("event/real-photo.jpg")).toBe(true);
  });

  test("reports a public response that does not match the canary", async () => {
    const env = {
      PHOTOS: new InMemoryObjectStore(),
      STATE: new InMemoryObjectStore(),
      R2_PUBLIC_BASE: "https://photos.example",
    } as unknown as CloudflareEnv;
    const result = await probes(env, async () => new Response("stale", { status: 200 }));
    expect(result.upload.status).toBe("up");
    expect(result.live.status).toBe("down");
  });

  test("overlapping readiness probes do not overwrite or delete one another", async () => {
    const photos = new InMemoryObjectStore();
    const env = {
      PHOTOS: photos,
      STATE: new InMemoryObjectStore(),
      R2_PUBLIC_BASE: "https://photos.example",
    } as unknown as CloudflareEnv;
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = async (input: RequestInfo | URL) => {
      arrivals++;
      if (arrivals === 2) release();
      await bothArrived;
      const url = new URL(String(input));
      const object = await photos.get(decodeURIComponent(url.pathname.slice(1)));
      return new Response(await object?.text(), { status: object ? 200 : 404 });
    };
    const [first, second] = await Promise.all([probes(env, fetcher), probes(env, fetcher)]);
    expect(first.live.status).toBe("up");
    expect(second.live.status).toBe("up");
    expect((await photos.list({ prefix: HEALTH_CANARY_KEY })).objects).toHaveLength(0);
  });
});
