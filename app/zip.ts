// Minimal STORE (no compression) zip primitives, split into per-file parts so
// the export route can stream an archive without ever holding more than one
// photo in memory. JPEGs are already compressed — deflate would burn CPU for
// no size win. No ZIP64: callers must reject >65,535 files or >4 GB totals.
import { crc32 } from "./crc32";

const le16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const le32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Local file header + name + data — the streamable per-file chunk.
export function localPart(name: Uint8Array, data: Uint8Array): { bytes: Uint8Array; crc: number } {
  const crc = crc32(data);
  const header = concat(
    le32(0x04034b50),
    le16(20), // version needed
    le16(0), // flags
    le16(0), // method: store
    le16(0), // mod time
    le16(0), // mod date
    le32(crc),
    le32(data.length), // compressed size
    le32(data.length), // uncompressed size
    le16(name.length),
    le16(0) // extra field length
  );
  return { bytes: concat(header, name, data), crc };
}

// Central directory record for one file, pointing back at its local header.
export function centralPart(f: { name: Uint8Array; crc: number; size: number; offset: number }): Uint8Array {
  const header = concat(
    le32(0x02014b50),
    le16(20), // version made by
    le16(20), // version needed
    le16(0), // flags
    le16(0), // method
    le16(0), // mod time
    le16(0), // mod date
    le32(f.crc),
    le32(f.size),
    le32(f.size),
    le16(f.name.length),
    le16(0), // extra length
    le16(0), // comment length
    le16(0), // disk number
    le16(0), // internal attrs
    le32(0), // external attrs
    le32(f.offset)
  );
  return concat(header, f.name);
}

// End-of-central-directory record — the archive's final bytes.
export function endPart(count: number, centralLen: number, centralOffset: number): Uint8Array {
  return concat(
    le32(0x06054b50),
    le16(0), // disk number
    le16(0), // disk with central dir
    le16(count),
    le16(count),
    le32(centralLen),
    le32(centralOffset),
    le16(0) // comment length
  );
}
