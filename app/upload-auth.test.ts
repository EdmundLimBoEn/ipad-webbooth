import { test, expect } from "bun:test";
import { keyOk, isImage } from "./upload-auth";

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

test("isImage rejects non-image payloads", () => {
  // e.g. an HTML/script payload someone might try to stash
  expect(isImage(new TextEncoder().encode("<html><script>"))).toBe(false);
  expect(isImage(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // ZIP
});
