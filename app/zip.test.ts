import { test, expect } from "bun:test";
import {
  centralPart,
  endPart,
  estimateStoreZipBytes,
  localPart,
  storedEntryHeader,
} from "./zip";

const te = new TextEncoder();
const le32At = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | ((b[i + 3] << 24) >>> 0);
const le16At = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

// Assemble a 2-file archive exactly the way the export route streams it and
// check the structural invariants a zip reader relies on.
test("zip parts assemble into a structurally valid STORE archive", () => {
  const files = [
    { name: te.encode("a.jpg"), data: te.encode("hello") },
    { name: te.encode("b.jpg"), data: te.encode("world!") },
  ];

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  for (const f of files) {
    const { bytes, crc } = localPart(f.name, f.data);
    offsets.push(offset);
    central.push(centralPart({ name: f.name, crc, size: f.data.length, offset }));
    offset += bytes.length;
    chunks.push(bytes);
  }
  const centralLen = central.reduce((n, c) => n + c.length, 0);
  const zip = new Uint8Array([...chunks, ...central, endPart(files.length, centralLen, offset)].flatMap((c) => [...c]));

  // each local header sits where its central record says, with the right signature
  for (const o of offsets) expect(le32At(zip, o)).toBe(0x04034b50);
  // first central record signature at the recorded central offset
  expect(le32At(zip, offset)).toBe(0x02014b50);
  // EOCD: last 22 bytes, right signature, right counts and central dir size
  const eocd = zip.length - 22;
  expect(le32At(zip, eocd)).toBe(0x06054b50);
  expect(le16At(zip, eocd + 8)).toBe(2); // entries on this disk
  expect(le16At(zip, eocd + 10)).toBe(2); // total entries
  expect(le32At(zip, eocd + 12)).toBe(centralLen);
  expect(le32At(zip, eocd + 16)).toBe(offset); // central dir starts after locals
  // second central record points at the second local header
  const second = offset + central[0].length;
  expect(le32At(zip, second + 42)).toBe(offsets[1]);
});

test("stored entry header describes separate bytes without copying them", () => {
  const name = te.encode("portrait.jpg");
  const data = te.encode("separate photo bytes");
  const split = storedEntryHeader(name, data);
  const combined = localPart(name, data);

  expect(split.header.length).toBe(30 + name.length);
  expect(split.header.slice(30)).toEqual(name);
  expect(le32At(split.header, 14) >>> 0).toBe(split.crc >>> 0);
  expect(le32At(split.header, 18)).toBe(data.length);
  expect(le32At(split.header, 22)).toBe(data.length);
  expect(split.size).toBe(data.length);
  expect(combined.bytes).toEqual(
    new Uint8Array([...split.header, ...data]),
  );
});

test("STORE zip estimates exact local, central, and EOCD byte lengths", () => {
  const entries = [
    { nameBytes: te.encode("plain.jpg").length, dataBytes: 123 },
    { nameBytes: te.encode("照片.jpg").length, dataBytes: 456 },
  ];
  const expected = entries.reduce(
    (total, entry) =>
      total + 30 + entry.nameBytes + entry.dataBytes + 46 + entry.nameBytes,
    22,
  );

  expect(estimateStoreZipBytes(entries)).toBe(expected);
});
