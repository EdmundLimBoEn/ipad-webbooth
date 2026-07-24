import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { EventStore, InMemoryObjectStore } from "@/app/event-store";
import { getPhotos } from "./handlers";

function request(query = "event=launch") {
  return new NextRequest(`https://app.test/api/photos?${query}`);
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
});
