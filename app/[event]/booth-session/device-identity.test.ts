import { describe, expect, test } from "bun:test";
import { clearBoothCredential } from "./credential";
import { loadOrCreateDeviceId } from "./device-identity";

const DEVICE_ID_KEY = "webbooth:device-id";
const DEVICE_ID = "0f9c4f16-2f58-4ea3-88c0-c7a3f2c2b81a";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class FailingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new DOMException("Storage unavailable", "SecurityError");
  }

  override setItem(_key: string, _value: string): void {
    throw new DOMException("Storage unavailable", "SecurityError");
  }
}

class WriteFailingStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException("Storage unavailable", "SecurityError");
  }
}

describe("Booth device identity", () => {
  test("returns the stored lowercase UUID-v4", () => {
    const storage = new MemoryStorage();
    storage.setItem(DEVICE_ID_KEY, DEVICE_ID);

    expect(loadOrCreateDeviceId(storage, () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .toBe(DEVICE_ID);
  });

  test("creates and stores a lowercase UUID-v4 when missing", () => {
    const storage = new MemoryStorage();

    expect(loadOrCreateDeviceId(storage, () => DEVICE_ID.toUpperCase())).toBe(DEVICE_ID);
    expect(storage.getItem(DEVICE_ID_KEY)).toBe(DEVICE_ID);
  });

  test("uses one session-only ID when local storage throws", () => {
    const storage = new FailingStorage();
    let made = 0;
    const makeId = () => {
      made++;
      return DEVICE_ID;
    };

    expect(loadOrCreateDeviceId(storage, makeId)).toBe(DEVICE_ID);
    expect(loadOrCreateDeviceId(storage, makeId)).toBe(DEVICE_ID);
    expect(made).toBe(1);
  });

  test("keeps the generated ID when storage fails while writing it", () => {
    const storage = new WriteFailingStorage();
    const first = DEVICE_ID;
    const second = "2e29bd33-8750-4f58-b23c-f4ebf0d8267e";
    let made = 0;

    expect(loadOrCreateDeviceId(storage, () => (++made === 1 ? first : second))).toBe(first);
    expect(made).toBe(1);
  });

  test("clearing Booth credentials leaves the device ID untouched", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    local.setItem(DEVICE_ID_KEY, DEVICE_ID);
    local.setItem("webbooth:launch:booth-key", "secret");

    clearBoothCredential("launch", session, local);

    expect(local.getItem(DEVICE_ID_KEY)).toBe(DEVICE_ID);
    expect(loadOrCreateDeviceId(local)).toBe(DEVICE_ID);
  });
});
