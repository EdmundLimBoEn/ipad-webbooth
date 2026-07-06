import { test, expect } from "bun:test";
import { localPart, centralPart, endPart } from "./zip";

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
