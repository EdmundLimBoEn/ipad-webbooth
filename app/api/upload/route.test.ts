import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  EventStore,
  InMemoryObjectStore,
  type ObjectStore,
  type StoredObjectBody,
  type StoredObject,
  type ListOptions,
  type ListResult,
} from "@/app/event-store";
import { hashBoothKey, MAX_UPLOAD_BYTES } from "@/app/upload-auth";
import { handleUpload, type UploadHandlerDeps } from "./handlers";

const ADMIN_KEY = "admin";
const CAPTURE_ID = "018f0000-0000-4000-8000-000000000001";
const CAPTURED_AT = "1753315200000";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function request(
  event = "launch",
  init: ConstructorParameters<typeof NextRequest>[1] = {}
): NextRequest {
  const { headers, body, ...rest } = init;
  return new NextRequest(`https://app.test/api/upload?event=${event}`, {
    method: "POST",
    ...rest,
    headers: { "x-booth-key": ADMIN_KEY, "content-type": "image/jpeg", ...headers },
    body: body ?? JPEG,
  });
}

function memoryDeps(options: { state?: ObjectStore; adminKey?: string } = {}) {
  const photos = new InMemoryObjectStore();
  const state = options.state ?? new InMemoryObjectStore();
  return {
    photos,
    state,
    deps: {
      store: new EventStore(photos, state, "https://photos.example"),
      adminKey: "adminKey" in options ? options.adminKey : ADMIN_KEY,
    } satisfies UploadHandlerDeps,
  };
}

class FailPrivateWrites implements ObjectStore {
  private readonly inner = new InMemoryObjectStore();
  private failing = true;

  constructor(private readonly prefix: string) {}

  allowWrites(): void {
    this.failing = false;
  }

  has(key: string): boolean {
    return this.inner.has(key);
  }

  get(key: string): Promise<StoredObjectBody | null> {
    return this.inner.get(key);
  }

  put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    return this.inner.put(key, value);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  list(options?: ListOptions): Promise<ListResult> {
    return this.inner.list(options);
  }

  async compareAndSwap(
    key: string,
    expectedEtag: string | null,
    value: ArrayBuffer | ArrayBufferView | string
  ): Promise<boolean> {
    if (this.failing && key.startsWith(this.prefix)) throw new Error("private storage unavailable");
    return this.inner.compareAndSwap(key, expectedEtag, value);
  }
}

function stableHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "x-capture-id": CAPTURE_ID,
    "x-captured-at": CAPTURED_AT,
    ...overrides,
  };
}

describe("upload route", () => {
  test("a stable retry returns the same key as a duplicate", async () => {
    const { photos, deps } = memoryDeps();
    const first = await handleUpload(request("launch", { headers: stableHeaders() }), deps);
    const retry = await handleUpload(request("launch", { headers: stableHeaders() }), deps);

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      key: "launch/1753315200000-018f0000-0000-4000-8000-000000000001.jpg",
      duplicate: false,
      url: "https://photos.example/launch/1753315200000-018f0000-0000-4000-8000-000000000001.jpg",
    });
    expect(await retry.json()).toMatchObject({ duplicate: true });
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
  });

  test("legacy uploads retain the url response field", async () => {
    const { deps } = memoryDeps();
    const response = await handleUpload(request(), deps);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(typeof body.key).toBe("string");
    expect(body.duplicate).toBe(false);
  });

  test("an Event Booth Key can upload only after its private hash is resolved", async () => {
    const { deps } = memoryDeps();
    await deps.store.writeConfig("launch", {
      frames: ["square"],
      boothKeyHash: await hashBoothKey("event-key-123"),
    });

    const response = await handleUpload(request("launch", {
      headers: { "x-booth-key": "event-key-123", ...stableHeaders() },
    }), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: false });
  });

  test("rejects partial stable identity before writing either store", async () => {
    const { photos, state, deps } = memoryDeps();
    const response = await handleUpload(request("launch", {
      headers: { "x-capture-id": CAPTURE_ID },
    }), deps);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "incomplete_capture_identity" });
    expect((await photos.list()).objects).toHaveLength(0);
    expect((await state.list()).objects).toHaveLength(0);
  });

  test("rejects canonical aliases and unauthorized uploads without writes", async () => {
    const alias = memoryDeps();
    const aliasResponse = await handleUpload(request("Launch", { headers: stableHeaders() }), alias.deps);
    expect(aliasResponse.status).toBe(400);
    expect((await alias.photos.list()).objects).toHaveLength(0);
    expect((await alias.state.list()).objects).toHaveLength(0);

    const unauthorized = memoryDeps();
    const denied = await handleUpload(request("launch", {
      headers: { "x-booth-key": "wrong", ...stableHeaders() },
    }), unauthorized.deps);
    expect(denied.status).toBe(401);
    expect((await unauthorized.photos.list()).objects).toHaveLength(0);
    expect((await unauthorized.state.list()).objects).toHaveLength(0);
  });

  test("maps declared size, empty/non-image data, and missing key configuration precisely", async () => {
    const { deps } = memoryDeps();
    const tooLarge = await handleUpload(request("launch", {
      headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) },
    }), deps);
    expect(tooLarge.status).toBe(413);

    const empty = await handleUpload(new NextRequest("https://app.test/api/upload?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY, "content-type": "image/jpeg" },
    }), deps);
    expect(empty.status).toBe(400);

    const unsupported = await handleUpload(new NextRequest("https://app.test/api/upload?event=launch", {
      method: "POST",
      headers: { "x-booth-key": ADMIN_KEY, "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    }), deps);
    expect(unsupported.status).toBe(415);

    const previous = process.env.ALLOW_KEYLESS;
    delete process.env.ALLOW_KEYLESS;
    const disabled = await handleUpload(request(), memoryDeps({ adminKey: undefined }).deps);
    expect(disabled.status).toBe(503);
    if (previous === undefined) delete process.env.ALLOW_KEYLESS;
    else process.env.ALLOW_KEYLESS = previous;
  });

  test("an index failure is retryable and an identical retry recovers the same public photo", async () => {
    const state = new FailPrivateWrites("events/launch/photo-index/");
    const { photos, deps } = memoryDeps({ state });
    const first = await handleUpload(request("launch", { headers: stableHeaders() }), deps);

    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("1");
    expect(await first.json()).toEqual({ error: "photo index unavailable" });
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);

    state.allowWrites();
    const retry = await handleUpload(request("launch", { headers: stableHeaders() }), deps);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true });
    expect((await photos.list({ prefix: "launch/" })).objects).toHaveLength(1);
  });

  test("a receipt failure still acknowledges the stable upload", async () => {
    const state = new FailPrivateWrites("events/launch/photo-metadata/");
    const { deps } = memoryDeps({ state });
    const response = await handleUpload(request("launch", { headers: stableHeaders() }), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: false });
  });
});
