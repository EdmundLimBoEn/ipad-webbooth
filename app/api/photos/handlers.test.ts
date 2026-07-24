import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  photoIndexKey,
  photoReceiptKey,
  type DeletePhotoResult,
} from "@/app/event-store";
import { deletePhoto, getPhotos } from "./handlers";

function request(query = "event=launch") {
  return new NextRequest(`https://app.test/api/photos?${query}`);
}

class DeleteHandlerStore extends EventStore {
  calls: Array<{ event: string; key: string }> = [];
  result: DeletePhotoResult = { deleted: false };

  constructor() {
    super(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
  }

  override async deletePhoto(event: string, key: string): Promise<DeletePhotoResult> {
    this.calls.push({ event, key });
    return this.result;
  }
}

function deleteRequest(query: string, key = "admin") {
  return new NextRequest(`https://app.test/api/photos?${query}`, {
    method: "DELETE",
    headers: { "x-booth-key": key },
  });
}

describe("photos handler", () => {
  test("keeps the after/cursor response contract while reading the private incremental feed", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const initial = await getPhotos(request(), { store });
    const initialBody = await initial.json() as { cursor: string };
    const uploaded = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000201", capturedAt: 1753315200000 },
    });

    const response = await getPhotos(request(`event=launch&cursor=${encodeURIComponent(initialBody.cursor)}`), { store });
    const body = await response.json() as { photos: Array<{ key: string }>; cursor: string };

    expect(response.status).toBe(200);
    expect(body.photos.map((photo) => photo.key)).toEqual([uploaded.key]);
    expect(typeof body.cursor).toBe("string");
  });

  test("rejects malformed and cross-Event private cursors", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const initial = await getPhotos(request(), { store });
    const cursor = (await initial.json() as { cursor: string }).cursor;

    const malformed = await getPhotos(request("event=launch&after=bad-cursor"), { store });
    const crossEvent = await getPhotos(request(`event=other&after=${encodeURIComponent(cursor)}`), { store });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "photo feed cursor is invalid for this Event" });
    expect(crossEvent.status).toBe(400);
    expect(await crossEvent.json()).toEqual({ error: "photo feed cursor is invalid for this Event" });
  });

  test("rebases an already-open Gallery's legacy raw photo-key cursor", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const uploaded = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000202", capturedAt: 1753315200001 },
    });

    const response = await getPhotos(
      request(`event=launch&after=${encodeURIComponent(uploaded.key)}`),
      { store }
    );
    const body = await response.json() as { photos: Array<{ key: string }>; cursor: string };

    expect(response.status).toBe(200);
    expect(body.photos.map((photo) => photo.key)).toEqual([uploaded.key]);
    expect(body.cursor).toStartWith("pf1.");

    const crossEvent = await getPhotos(
      request(`event=other&after=${encodeURIComponent(uploaded.key)}`),
      { store }
    );
    const traversal = await getPhotos(
      request(`event=launch&after=${encodeURIComponent("launch/../other/photo.jpg")}`),
      { store }
    );
    const fragment = await getPhotos(
      request(`event=launch&after=${encodeURIComponent(uploaded.key.split("/")[1]!)}`),
      { store }
    );
    expect(crossEvent.status).toBe(400);
    expect(traversal.status).toBe(400);
    expect(fragment.status).toBe(400);
  });

  test("rebases a legacy raw cursor after its exact photo was moderated", async () => {
    const store = new EventStore(new InMemoryObjectStore(), new InMemoryObjectStore(), "https://photos.example");
    const uploaded = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000203", capturedAt: 1753315200002 },
    });
    await store.deletePhoto("launch", uploaded.key);

    const response = await getPhotos(
      request(`event=launch&after=${encodeURIComponent(uploaded.key)}`),
      { store }
    );
    const body = await response.json() as { photos: Array<{ key: string }>; cursor: string };

    expect(response.status).toBe(200);
    expect(body.photos).toEqual([]);
    expect(body.cursor).toStartWith("pf1.");
  });

  test("DELETE fails closed before validation or store access", async () => {
    for (const [adminKey, status] of [[undefined, 503], ["different", 401]] as const) {
      const store = new DeleteHandlerStore();
      const response = await deletePhoto(
        deleteRequest("event=Launch&key=fragment.jpg"),
        { store, adminKey }
      );
      expect(response.status).toBe(status);
      expect(store.calls).toEqual([]);
    }
  });

  test("DELETE rejects aliases, missing keys, duplicates, and unknown query fields", async () => {
    for (const query of [
      "event=Launch&key=launch%2F1753315200000-a.jpg",
      "event=launch",
      "event=launch&key=a&key=b",
      "event=launch&key=a&prefix=true",
    ]) {
      const store = new DeleteHandlerStore();
      const response = await deletePhoto(deleteRequest(query), { store, adminKey: "admin" });
      expect(response.status).toBe(400);
      expect(store.calls).toEqual([]);
    }
  });

  test("DELETE preserves 404 and reports only additive cleanupPending", async () => {
    const store = new DeleteHandlerStore();
    const missing = await deletePhoto(
      deleteRequest("event=launch&key=launch%2F1753315200000-a.jpg"),
      { store, adminKey: "admin" }
    );
    expect(missing.status).toBe(404);

    store.result = {
      deleted: true,
      cleanup: { index: "failed", receipt: "deleted" },
    };
    const response = await deletePhoto(
      deleteRequest("event=launch&key=launch%2F1753315200000-a.jpg"),
      { store, adminKey: "admin" }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      deleted: true,
      key: "launch/1753315200000-a.jpg",
      cleanupPending: true,
    });
  });

  test("DELETE exact cleanup success never exposes private derived key names", async () => {
    const photos = new InMemoryObjectStore();
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");
    const uploaded = await store.putPhoto("launch", new Uint8Array([1]).buffer, {
      upload: { captureId: "018f0000-0000-4000-8000-000000000204", capturedAt: 1753315200000 },
    });
    expect(state.has(photoReceiptKey("launch", uploaded.key))).toBe(true);
    expect(state.has(photoIndexKey("launch", uploaded.key, 1753315200000))).toBe(true);

    const response = await deletePhoto(
      deleteRequest(`event=launch&key=${encodeURIComponent(uploaded.key)}`),
      { store, adminKey: "admin" }
    );
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ deleted: true, key: uploaded.key, cleanupPending: false });
    expect(JSON.stringify(body)).not.toContain("photo-index");
    expect(JSON.stringify(body)).not.toContain("photo-metadata");
  });
});
