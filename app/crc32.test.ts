import { test, expect } from "bun:test";
import { crc32 } from "./crc32";

// Known-answer tests against the standard CRC-32 (zip/IEEE 802.3) values.
test("crc32 of empty buffer is 0", () => {
  expect(crc32(new Uint8Array(0))).toBe(0);
});

test("crc32 of 'hello' matches the well-known value", () => {
  expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
});
