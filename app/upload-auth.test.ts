import { test, expect } from "bun:test";
import { keyOk, adminOk, hashBoothKey, boothKeyMatches, safeEvent, isImage } from "./upload-auth";

test("keyOk accepts the exact key", () => {
  expect(keyOk("b29b8260981f1548", "b29b8260981f1548")).toBe(true);
});

test("keyOk rejects wrong key and length mismatches", () => {
  expect(keyOk("wrong", "b29b8260981f1548")).toBe(false);
  expect(keyOk("", "b29b8260981f1548")).toBe(false);
  expect(keyOk("b29b8260981f1548x", "b29b8260981f1548")).toBe(false);
});

test("isImage accepts a JPEG signature", () => {
  expect(isImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
});

test("isImage accepts PNG and HEIF signatures", () => {
  expect(isImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(true); // PNG
  // HEIF/HEIC: bytes 4..7 = 'ftyp'
  expect(isImage(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBe(true);
});

test("isImage rejects video ftyp containers", () => {
  const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand)]);
  expect(isImage(ftyp("isom"))).toBe(false); // MP4
  expect(isImage(ftyp("qt  "))).toBe(false); // MOV
  expect(isImage(ftyp("avif"))).toBe(true);
  expect(isImage(ftyp("mif1"))).toBe(true);
});

test("adminOk gates on the admin key and fails closed without one", () => {
  expect(adminOk("k", "k")).toBe("ok");
  expect(adminOk("wrong", "k")).toBe("unauthorized");
  expect(adminOk("", "k")).toBe("unauthorized");
  const prev = process.env.ALLOW_KEYLESS;
  delete process.env.ALLOW_KEYLESS;
  expect(adminOk("anything", undefined)).toBe("disabled");
  process.env.ALLOW_KEYLESS = "1";
  expect(adminOk("", undefined)).toBe("ok");
  if (prev === undefined) delete process.env.ALLOW_KEYLESS;
  else process.env.ALLOW_KEYLESS = prev;
});

test("booth key hashing round-trips and is salted", async () => {
  const stored = await hashBoothKey("my-booth-key-123");
  expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/); // salt:hash
  expect(await boothKeyMatches("my-booth-key-123", stored)).toBe(true);
  expect(await boothKeyMatches("wrong-key-00000", stored)).toBe(false);
  expect(await boothKeyMatches("my-booth-key-123", "garbage")).toBe(false);
  // fresh salt every time — identical keys must not produce identical hashes
  expect(await hashBoothKey("my-booth-key-123")).not.toBe(stored);
});

test("safeEvent slugs to a-z0-9- and never emits an underscore", () => {
  expect(safeEvent("My Event! 2026")).toBe("my-event-2026");
  expect(safeEvent("_config")).toBe("config");
  expect(safeEvent(null)).toBe("event");
  expect(safeEvent("---")).toBe("event");
});

test("isImage rejects non-image payloads", () => {
  // e.g. an HTML/script payload someone might try to stash
  expect(isImage(new TextEncoder().encode("<html><script>"))).toBe(false);
  expect(isImage(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // ZIP
});
