import {
  canonicalEvent,
  type EventStore,
  type ExportPhotoSource,
} from "./event-store";
import {
  encodePackageArtifacts,
  preparePackageRows,
  type PackagePhotoRow,
} from "./export-package";
import {
  centralPart,
  endPart,
  estimateStoreZipBytes,
  storedEntryHeader,
} from "./zip";

export const MAX_ZIP_ENTRIES = 0xffff;
export const MAX_ZIP_BYTES = 3_900_000_000;
export const MAX_GENERATED_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_GENERATED_TOTAL_BYTES = 16 * 1024 * 1024;

export class ExportTooLargeError extends Error {
  constructor(
    readonly reason:
      | "entry_count"
      | "zip_bytes"
      | "generated_entry"
      | "generated_total",
  ) {
    super(`event export exceeds ${reason} limit`);
  }
}

export type ExportStreamDeps = {
  store: EventStore;
  frameLabelFor: (frameKey: string) => string | undefined;
  now: () => Date;
};

type PlannedPhoto = {
  key: string;
  size: number;
  name: Uint8Array;
  row?: PackagePhotoRow;
};

type GeneratedFile = {
  name: string;
  data: Uint8Array;
};

const encoder = new TextEncoder();
const GENERATED_NAMES = [
  "manifest.csv",
  "summary.json",
  "contact-sheet.html",
] as const;

function basename(key: string): string {
  return key.split("/").at(-1) ?? key;
}

function checkEntries(count: number): void {
  if (count > MAX_ZIP_ENTRIES) throw new ExportTooLargeError("entry_count");
}

function checkZipSize(
  entries: readonly { nameBytes: number; dataBytes: number }[],
): void {
  if (estimateStoreZipBytes(entries) > MAX_ZIP_BYTES) {
    throw new ExportTooLargeError("zip_bytes");
  }
}

function generatedFiles(input: {
  event: string;
  generatedAt: Date;
  configuredTimeZone?: string;
  rows: readonly PackagePhotoRow[];
}): GeneratedFile[] {
  const artifacts = encodePackageArtifacts(input);
  return [
    { name: GENERATED_NAMES[0], data: artifacts.manifest },
    { name: GENERATED_NAMES[1], data: artifacts.summary },
    { name: GENERATED_NAMES[2], data: artifacts.contactSheet },
  ];
}

function checkGenerated(files: readonly GeneratedFile[]): void {
  if (files.some((file) => file.data.byteLength > MAX_GENERATED_ENTRY_BYTES)) {
    throw new ExportTooLargeError("generated_entry");
  }
  const total = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (total > MAX_GENERATED_TOTAL_BYTES) {
    throw new ExportTooLargeError("generated_total");
  }
}

function buildStream(input: {
  photos: readonly PlannedPhoto[];
  store: EventStore;
  finish: (emittedRows: readonly PackagePhotoRow[]) => GeneratedFile[];
}): ReadableStream<Uint8Array> {
  const central: Uint8Array[] = [];
  const emittedRows: PackagePhotoRow[] = [];
  let photoIndex = 0;
  let offset = 0;
  let finished = false;

  const emitFile = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    name: Uint8Array,
    data: Uint8Array,
  ) => {
    const { header, crc, size } = storedEntryHeader(name, data);
    central.push(centralPart({ name, crc, size, offset }));
    offset += header.byteLength + data.byteLength;
    controller.enqueue(header);
    controller.enqueue(data);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (photoIndex < input.photos.length) {
        const photo = input.photos[photoIndex++]!;
        const object = await input.store.getPhoto(photo.key);
        if (!object) continue;
        const data = new Uint8Array(await object.arrayBuffer());
        emitFile(controller, photo.name, data);
        if (photo.row) {
          emittedRows.push({ ...photo.row, sizeBytes: data.byteLength });
        }
        return;
      }
      if (finished) return;
      finished = true;
      const generated = input.finish(emittedRows);
      checkGenerated(generated);
      for (const file of generated) {
        emitFile(controller, encoder.encode(file.name), file.data);
      }
      const centralLength = central.reduce(
        (sum, part) => sum + part.byteLength,
        0,
      );
      for (const part of central) controller.enqueue(part);
      controller.enqueue(endPart(central.length, centralLength, offset));
      controller.close();
    },
  });
}

export async function preparePhotoOnlyExport(
  event: string,
  deps: ExportStreamDeps,
): Promise<ReadableStream<Uint8Array>> {
  const canonical = canonicalEvent(event);
  const photos: PlannedPhoto[] = [];
  for await (const object of deps.store.iteratePhotoObjects(canonical)) {
    photos.push({
      key: object.key,
      size: object.size,
      name: encoder.encode(basename(object.key)),
    });
    checkEntries(photos.length);
  }
  checkZipSize(photos.map((photo) => ({
    nameBytes: photo.name.byteLength,
    dataBytes: photo.size,
  })));
  return buildStream({
    photos,
    store: deps.store,
    finish: () => [],
  });
}

export async function preparePackageExport(
  event: string,
  configuredTimeZone: string | undefined,
  deps: ExportStreamDeps,
): Promise<ReadableStream<Uint8Array>> {
  const canonical = canonicalEvent(event);
  const sources: ExportPhotoSource[] = [];
  for await (const source of deps.store.iterateExportPhotoSources(canonical)) {
    sources.push(source);
    checkEntries(sources.length + GENERATED_NAMES.length);
  }
  const rows = preparePackageRows(sources, deps.frameLabelFor);
  const generatedAt = deps.now();
  const candidate = generatedFiles({
    event: canonical,
    generatedAt,
    configuredTimeZone,
    rows,
  });
  checkGenerated(candidate);
  const photos = sources.map((source, index): PlannedPhoto => ({
    key: source.key,
    size: source.size,
    name: encoder.encode(rows[index]!.archivePath),
    row: rows[index],
  }));
  checkZipSize([
    ...photos.map((photo) => ({
      nameBytes: photo.name.byteLength,
      dataBytes: photo.size,
    })),
    ...candidate.map((file) => ({
      nameBytes: encoder.encode(file.name).byteLength,
      dataBytes: file.data.byteLength,
    })),
  ]);

  return buildStream({
    photos,
    store: deps.store,
    finish: (emittedRows) => generatedFiles({
      event: canonical,
      generatedAt,
      configuredTimeZone,
      rows: emittedRows,
    }),
  });
}
