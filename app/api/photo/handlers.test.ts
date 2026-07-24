import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  type StoredObjectBody,
} from "@/app/event-store";
import { getPublicPhoto } from "./handlers";

class ExactPhotoReadStore extends InMemoryObjectStore {
  readonly reads: string[] = [];

  override async get(key: string): Promise<StoredObjectBody | null> {
    this.reads.push(key);
    return super.get(key);
  }
}

function request(query: string): NextRequest {
  return new NextRequest(`https://app.test/api/photo?${query}`);
}

describe("exact public photo handler", () => {
  test("returns only the direct public photo contract without caching", async () => {
    const uploaded = new Date("2026-07-24T12:00:00.000Z");
    const key = "launch/0000000001000-photo.jpg";
    const photos = new ExactPhotoReadStore();
    photos.set(key, "photo", uploaded);
    const response = await getPublicPhoto(
      request(`event=launch&key=${encodeURIComponent(key)}`),
      { store: new EventStore(photos, new InMemoryObjectStore(), "https://photos.example") }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      key,
      url: "https://photos.example/launch/0000000001000-photo.jpg",
      uploadedAt: uploaded.toISOString(),
    });
    expect(photos.reads).toEqual([key]);
  });

  test("rejects aliases and malformed, cross-Event keys before reading PHOTOS", async () => {
    const key = "launch/0000000001000-photo.jpg";
    const photos = new ExactPhotoReadStore();
    photos.set(key, "photo");
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");

    for (const query of [
      `event=Launch&key=${encodeURIComponent(key)}`,
      "event=launch&key=launch%2F",
      "event=launch&key=0000000001000-photo.jpg",
      "event=launch&key=launch%2F..%2Fother%2F0000000001000-photo.jpg",
      "event=launch&key=other%2F0000000001000-photo.jpg",
    ]) {
      const response = await getPublicPhoto(request(query), { store });
      expect(response.status).toBe(400);
    }
    expect(photos.reads).toEqual([]);
  });

  test("returns a precise not-found response for one valid exact missing key", async () => {
    const key = "launch/0000000001000-missing.jpg";
    const photos = new ExactPhotoReadStore();
    const response = await getPublicPhoto(
      request(`event=launch&key=${encodeURIComponent(key)}`),
      { store: new EventStore(photos, new InMemoryObjectStore(), "https://photos.example") }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "photo not found" });
    expect(photos.reads).toEqual([key]);
  });
});
