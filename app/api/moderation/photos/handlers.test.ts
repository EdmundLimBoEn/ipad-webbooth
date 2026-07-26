import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  type DeletePhotoResult,
  type ModerationPhotoPage,
  type PhotoIndexRebuildResult,
} from "@/app/event-store";
import { getModerationPhotos, postModerationRebuild } from "./handlers";

class ModerationHandlerStore extends EventStore {
  calls: string[] = [];
  page: ModerationPhotoPage = { photos: [], nextCursor: null };
  rebuild: PhotoIndexRebuildResult = {
    complete: false,
    scanned: 10,
    indexed: 8,
    checkpoint: "launch/last.jpg",
  };

  constructor() {
    super(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
  }

  override async listModerationPhotos(
    event: string,
    options: { cursor?: string; limit?: number; from?: number; to?: number }
  ): Promise<ModerationPhotoPage> {
    this.calls.push(`list:${event}:${JSON.stringify(options)}`);
    return this.page;
  }

  override async rebuildPhotoIndex(
    event: string,
    options: { batchSize: number }
  ): Promise<PhotoIndexRebuildResult> {
    this.calls.push(`rebuild:${event}:${options.batchSize}`);
    return this.rebuild;
  }

  override async deletePhoto(): Promise<DeletePhotoResult> {
    throw new Error("unused");
  }
}

function request(
  path: string,
  { key = "admin", method = "GET" }: { key?: string; method?: string } = {}
) {
  return new NextRequest(`https://app.test${path}`, {
    method,
    headers: { "x-booth-key": key },
  });
}

describe("Admin moderation handlers", () => {
  test("fails closed before store access when the Admin secret is missing or wrong", async () => {
    for (const [adminKey, status] of [[undefined, 503], ["different", 401]] as const) {
      const store = new ModerationHandlerStore();
      const response = await getModerationPhotos(
        request("/api/moderation/photos?event=launch"),
        { store, adminKey }
      );
      expect(response.status).toBe(status);
      expect(store.calls).toEqual([]);
    }
  });

  test("strictly validates canonical Event, limit, time-zone instants, order, and cursor", async () => {
    const invalidQueries = [
      "event=Launch",
      "event=launch&limit=0",
      "event=launch&limit=101",
      "event=launch&limit=1.5",
      "event=launch&from=2026-07-24",
      "event=launch&from=2026-07-24T00%3A00%3A00",
      "event=launch&from=2026-02-30T00%3A00%3A00Z",
      "event=launch&from=2026-07-25T00%3A00%3A00Z&to=2026-07-24T00%3A00%3A00Z",
      "event=launch&cursor=bad",
      "event=launch&limit=48&limit=49",
      "event=launch&private=true",
    ];
    for (const query of invalidQueries) {
      const store = new ModerationHandlerStore();
      const response = await getModerationPhotos(
        request(`/api/moderation/photos?${query}`),
        { store, adminKey: "admin" }
      );
      expect(response.status).toBe(400);
      expect(store.calls).toEqual([]);
    }
  });

  test("defaults to 48, accepts bounded filters, and allowlists the no-store page response", async () => {
    const store = new ModerationHandlerStore();
    store.page = {
      photos: [{
        key: "launch/1753315200000-a.jpg",
        url: "https://photos.example/launch/1753315200000-a.jpg",
        uploadedAt: "2025-07-24T00:00:00.000Z",
        capturedAt: 1753315200000,
        source: "framed",
        frameKey: "celebration",
        receipt: "must-not-leak",
      } as never],
      nextCursor: "opaque",
      revision: "must-not-leak",
    } as never;

    const response = await getModerationPhotos(request(
      "/api/moderation/photos?event=launch&from=2025-07-24T00%3A00%3A00%2B08%3A00&to=2025-07-25T00%3A00%3A00Z"
    ), { store, adminKey: "admin" });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.calls).toEqual([
      `list:launch:${JSON.stringify({
        limit: 48,
        from: Date.parse("2025-07-24T00:00:00+08:00"),
        to: Date.parse("2025-07-25T00:00:00Z"),
      })}`,
    ]);
    expect(await response.json()).toEqual({
      photos: [{
        key: "launch/1753315200000-a.jpg",
        url: "https://photos.example/launch/1753315200000-a.jpg",
        uploadedAt: "2025-07-24T00:00:00.000Z",
        capturedAt: 1753315200000,
        source: "framed",
        frameKey: "celebration",
      }],
      nextCursor: "opaque",
    });
  });

  test("runs one bounded rebuild batch and distinguishes incomplete from complete", async () => {
    const store = new ModerationHandlerStore();
    const incomplete = await postModerationRebuild(
      request("/api/moderation/photos/rebuild?event=launch", { method: "POST" }),
      { store, adminKey: "admin", rebuildBatchSize: 75 }
    );
    expect(incomplete.status).toBe(202);
    expect(incomplete.headers.get("cache-control")).toBe("no-store");
    expect(store.calls).toEqual(["rebuild:launch:75"]);

    store.rebuild = { complete: true, scanned: 0, indexed: 0, checkpoint: "launch/last.jpg" };
    const complete = await postModerationRebuild(
      request("/api/moderation/photos/rebuild?event=launch", { method: "POST" }),
      { store, adminKey: "admin", rebuildBatchSize: 75 }
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual(store.rebuild);
  });
});
