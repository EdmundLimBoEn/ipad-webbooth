import { describe, expect, test } from "bun:test";
import {
  EventStore,
  InMemoryObjectStore,
  type ExportPhotoSource,
  type StoredObjectBody,
} from "./event-store";
import {
  ExportTooLargeError,
  MAX_ZIP_ENTRIES,
  preparePackageExport,
  preparePhotoOnlyExport,
} from "./export-stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function storeWith(
  photos: Record<string, string> = {},
  state: Record<string, string> = {},
): EventStore {
  return new EventStore(
    new InMemoryObjectStore(photos),
    new InMemoryObjectStore(state),
    "https://photos.example",
    () => new Date("2026-07-24T12:00:00.000Z"),
  );
}

async function chunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const values: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return values;
    values.push(next.value);
  }
}

function entries(values: Uint8Array[]): Map<string, Uint8Array> {
  const bytes = new Uint8Array(values.flatMap((value) => [...value]));
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (
    bytes[offset] === 0x50
    && bytes[offset + 1] === 0x4b
    && bytes[offset + 2] === 0x03
    && bytes[offset + 3] === 0x04
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

describe("export streams", () => {
  test("keeps legacy root names and emits photo headers and bodies separately", async () => {
    const store = storeWith({
      "launch/1700000000000-a.jpg": "alpha",
      "launch/1700000000001-b.jpg": "beta",
    });
    const values = await chunks(await preparePhotoOnlyExport("launch", {
      store,
      frameLabelFor: () => undefined,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    }));
    const archive = entries(values);

    expect([...archive.keys()]).toEqual([
      "1700000000000-a.jpg",
      "1700000000001-b.jpg",
    ]);
    expect(decoder.decode(archive.get("1700000000000-a.jpg"))).toBe("alpha");
    expect(values.some((value) => value.length === encoder.encode("alpha").length)).toBe(true);
    expect([...archive.keys()].some((name) => name.includes("manifest"))).toBe(false);
  });

  test("enriched package joins metadata and appends generated entries", async () => {
    const key = "launch/1700000000000-a.jpg";
    const store = storeWith(
      { [key]: "alpha" },
      {
        "events/launch/photo-metadata/1700000000000-a.jpg.json": JSON.stringify({
          version: 1,
          key,
          uploadedAt: "2026-07-24T12:00:00.000Z",
          capturedAt: 1700000000000,
          source: "framed",
          frameKey: "square",
        }),
      },
    );
    const archive = entries(await chunks(await preparePackageExport(
      "launch",
      "Asia/Singapore",
      {
        store,
        frameLabelFor: (frame) => frame === "square" ? "Square" : undefined,
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    )));

    expect([...archive.keys()]).toEqual([
      "photos/1700000000000-a.jpg",
      "manifest.csv",
      "summary.json",
      "contact-sheet.html",
    ]);
    expect(decoder.decode(archive.get("manifest.csv"))).toContain("square,Square,framed");
    expect(decoder.decode(archive.get("summary.json"))).toContain('"timeZone": "Asia/Singapore"');
    expect(decoder.decode(archive.get("contact-sheet.html"))).toContain('src="photos/1700000000000-a.jpg"');
    expect(decoder.decode(archive.get("manifest.csv"))).not.toContain("events/launch/photos/");
  });

  test("a photo deleted after inventory is absent from every package section", async () => {
    const source: ExportPhotoSource = {
      key: "launch/1700000000000-gone.jpg",
      size: 5,
      uploadedAt: "2026-07-24T12:00:00.000Z",
      receipt: null,
    };
    const store = {
      async *iterateExportPhotoSources() { yield source; },
      getPhoto: async () => null,
    } as unknown as EventStore;
    const archive = entries(await chunks(await preparePackageExport(
      "launch",
      undefined,
      {
        store,
        frameLabelFor: () => undefined,
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    )));

    expect([...archive.keys()]).toEqual([
      "manifest.csv",
      "summary.json",
      "contact-sheet.html",
    ]);
    expect(decoder.decode(archive.get("manifest.csv"))).not.toContain("gone.jpg");
    expect(JSON.parse(decoder.decode(archive.get("summary.json"))).photoCount).toBe(0);
    expect(decoder.decode(archive.get("contact-sheet.html"))).not.toContain("gone.jpg");
  });

  test("reads at most one photo body before asking for the next", async () => {
    let firstFinished = false;
    let secondStartedBeforeFirstFinished = false;
    const source = (index: number): ExportPhotoSource => ({
      key: `launch/170000000000${index}-photo.jpg`,
      size: 1,
      uploadedAt: "2026-07-24T12:00:00.000Z",
      receipt: null,
    });
    const body = (key: string, index: number): StoredObjectBody => ({
      key,
      size: 1,
      uploaded: new Date(),
      etag: String(index),
      async arrayBuffer() {
        if (index === 2 && !firstFinished) secondStartedBeforeFirstFinished = true;
        await Promise.resolve();
        if (index === 1) firstFinished = true;
        return new Uint8Array([index]).buffer;
      },
      async text() { return ""; },
      async json<T>() { return {} as T; },
    });
    const store = {
      async *iterateExportPhotoSources() { yield source(1); yield source(2); },
      async getPhoto(key: string) {
        return body(key, key.includes("001-") ? 1 : 2);
      },
    } as unknown as EventStore;

    await chunks(await preparePackageExport("launch", undefined, {
      store,
      frameLabelFor: () => undefined,
      now: () => new Date(),
    }));
    expect(secondStartedBeforeFirstFinished).toBe(false);
  });

  test("rejects classic ZIP entry overflow before returning a stream", async () => {
    const store = {
      async *iteratePhotoObjects() {
        for (let index = 0; index <= MAX_ZIP_ENTRIES; index++) {
          yield {
            key: `launch/${index}.jpg`,
            size: 0,
            uploaded: new Date(),
            etag: String(index),
          };
        }
      },
    } as unknown as EventStore;

    await expect(preparePhotoOnlyExport("launch", {
      store,
      frameLabelFor: () => undefined,
      now: () => new Date(),
    })).rejects.toEqual(new ExportTooLargeError("entry_count"));
  });
});
