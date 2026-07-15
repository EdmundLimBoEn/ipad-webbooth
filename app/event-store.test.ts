import { describe, expect, test } from "bun:test";
import {
  canonicalEvent,
  EventStore,
  InMemoryObjectStore,
  eventConfigKey,
  legacyEventConfigKey,
} from "./event-store";

describe("canonical event identity", () => {
  test("accepts canonical slugs and keeps the default event", () => {
    expect(canonicalEvent("launch-2026")).toBe("launch-2026");
    expect(canonicalEvent(null)).toBe("event");
  });

  test("rejects aliases instead of silently targeting another event", () => {
    expect(() => canonicalEvent("Launch 2026")).toThrow("canonical lowercase slug");
    expect(() => canonicalEvent("launch--2026")).toThrow();
    expect(() => canonicalEvent("_config")).toThrow();
  });
});

describe("EventStore", () => {
  test("migrates legacy public config into versioned private state", async () => {
    const photos = new InMemoryObjectStore({
      [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["one"], boothKeyHash: "hash" }),
    });
    const state = new InMemoryObjectStore();
    const store = new EventStore(photos, state, "https://photos.example");

    expect(await store.readConfig("launch")).toEqual({ frames: ["one"], boothKeyHash: "hash" });
    expect(state.has(eventConfigKey("launch"))).toBe(true);
    // The public legacy record remains during the rollback window. Cleanup is
    // an explicit, exact-key operator action after the new release is proven.
    expect(photos.has(legacyEventConfigKey("launch"))).toBe(true);
    const migrated = await state.get(eventConfigKey("launch"));
    expect(await migrated?.json<{ version: number; frames: string[]; boothKeyHash: string }>()).toEqual({
      version: 1,
      frames: ["one"],
      boothKeyHash: "hash",
    });
  });

  test("prefers private config over a stale legacy copy", async () => {
    const photos = new InMemoryObjectStore({ [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["old"] }) });
    const state = new InMemoryObjectStore({ [eventConfigKey("launch")]: JSON.stringify({ version: 1, frames: ["new"] }) });
    const store = new EventStore(photos, state, "https://photos.example/");
    expect(await store.readConfig("launch")).toEqual({ frames: ["new"] });
  });

  test("does not overwrite an unsupported future config with stale legacy state", async () => {
    const photos = new InMemoryObjectStore({ [legacyEventConfigKey("launch")]: JSON.stringify({ frames: ["old"] }) });
    const state = new InMemoryObjectStore({ [eventConfigKey("launch")]: JSON.stringify({ version: 2, frames: ["future"] }) });
    const store = new EventStore(photos, state, "https://photos.example");
    await expect(store.readConfig("launch")).rejects.toThrow("unsupported version");
    expect(await (await state.get(eventConfigKey("launch")))?.json<{ version: number; frames: string[] }>()).toEqual({
      version: 2,
      frames: ["future"],
    });
  });

  test("returns an initial snapshot and efficient start-after delta", async () => {
    const photos = new InMemoryObjectStore();
    photos.set("launch/0000000001000-aaaa.jpg", "a", new Date("2026-01-01T00:00:01Z"));
    photos.set("launch/0000000002000-bbbb.jpg", "b", new Date("2026-01-01T00:00:02Z"));
    photos.set("launch/readme.txt", "not a photo");
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");

    const initial = await store.listPhotos("launch");
    expect(initial.photos.map((photo) => photo.url)).toEqual([
      "https://photos.example/launch/0000000002000-bbbb.jpg",
      "https://photos.example/launch/0000000001000-aaaa.jpg",
    ]);
    expect(initial.cursor).toBe("launch/0000000002000-bbbb.jpg");

    const unchanged = await store.listPhotos("launch", initial.cursor);
    expect(unchanged).toMatchObject({ photos: [], cursor: initial.cursor, unchanged: true });
    photos.set("launch/0000000003000-cccc.jpg", "c");
    const delta = await store.listPhotos("launch", initial.cursor);
    expect(delta.photos).toHaveLength(1);
    expect(delta.cursor).toBe("launch/0000000003000-cccc.jpg");
  });

  test("iterates every export page", async () => {
    const photos = new InMemoryObjectStore();
    for (let i = 0; i < 1002; i += 1) photos.set(`launch/${String(i).padStart(13, "0")}-x.jpg`, "x");
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    const keys: string[] = [];
    for await (const object of store.iteratePhotoObjects("launch")) keys.push(object.key);
    expect(keys).toHaveLength(1002);
  });

  test("deletes only an exact photo key belonging to the event", async () => {
    const photos = new InMemoryObjectStore({
      "launch/0000000001000-a.jpg": "a",
      "other/0000000001000-b.jpg": "b",
      "launch/notes.txt": "keep",
    });
    const store = new EventStore(photos, new InMemoryObjectStore(), "https://photos.example");
    expect(await store.deletePhoto("launch", "other/0000000001000-b.jpg")).toBe(false);
    expect(await store.deletePhoto("launch", "launch/notes.txt")).toBe(false);
    expect(await store.deletePhoto("launch", "launch/0000000001000-a.jpg")).toBe(true);
    expect(photos.has("launch/0000000001000-a.jpg")).toBe(false);
    expect(photos.has("other/0000000001000-b.jpg")).toBe(true);
  });
});
