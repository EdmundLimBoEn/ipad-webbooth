import { describe, expect, test } from "bun:test";
import {
  clearBoothCredential,
  loadBoothCredential,
  saveBoothCredential,
} from "./credential";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new DOMException("Storage unavailable", "SecurityError");
  }

  override removeItem(_key: string): void {
    throw new DOMException("Storage unavailable", "SecurityError");
  }

  override setItem(_key: string, _value: string): void {
    throw new DOMException("Storage unavailable", "SecurityError");
  }
}

describe("Booth credential persistence", () => {
  test("loads the session credential before a remembered credential", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    session.setItem("webbooth:launch:booth-key", "session-key");
    local.setItem("webbooth:launch:booth-key", "remembered-key");

    expect(loadBoothCredential("launch", session, local)).toEqual({
      key: "session-key",
      persistence: "session",
    });
  });

  test("remembering a credential moves it from session to local storage", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    session.setItem("webbooth:launch:booth-key", "old-session-key");

    saveBoothCredential("launch", "remembered-key", true, session, local);

    expect(session.getItem("webbooth:launch:booth-key")).toBeNull();
    expect(local.getItem("webbooth:launch:booth-key")).toBe("remembered-key");
  });

  test("the default credential moves from local to session storage", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    local.setItem("webbooth:launch:booth-key", "old-remembered-key");

    saveBoothCredential("launch", "session-key", false, session, local);

    expect(session.getItem("webbooth:launch:booth-key")).toBe("session-key");
    expect(local.getItem("webbooth:launch:booth-key")).toBeNull();
  });

  test("clears both persistence choices for only the intended Event", () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    session.setItem("webbooth:launch:booth-key", "session-key");
    local.setItem("webbooth:launch:booth-key", "remembered-key");
    session.setItem("webbooth:other:booth-key", "other-session-key");
    local.setItem("unrelated", "keep-me");

    clearBoothCredential("launch", session, local);

    expect(session.getItem("webbooth:launch:booth-key")).toBeNull();
    expect(local.getItem("webbooth:launch:booth-key")).toBeNull();
    expect(session.getItem("webbooth:other:booth-key")).toBe("other-session-key");
    expect(local.getItem("unrelated")).toBe("keep-me");
  });

  test("storage failures do not discard the caller's active in-memory credential", () => {
    const active = { key: "current-page-key" };
    const broken = new FailingStorage();

    expect(() => {
      saveBoothCredential("launch", active.key, true, broken, broken);
      clearBoothCredential("launch", broken, broken);
    }).not.toThrow();
    expect(loadBoothCredential("launch", broken, broken)).toBeNull();
    expect(active.key).toBe("current-page-key");
  });
});
