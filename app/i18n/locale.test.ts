import { describe, expect, test } from "bun:test";
import {
  applyDocumentLocale,
  DocumentLocaleLease,
  deviceLocaleStorageKey,
  resolveDeviceLocale,
  resolveEnabledLocales,
  saveDeviceLocale,
} from "./locale";

describe("guest locale resolution", () => {
  test("intersects configured locales with catalogs, deduplicates, and retains English", () => {
    expect(resolveEnabledLocales(undefined)).toEqual(["en"]);
    expect(resolveEnabledLocales(["ar", "legacy", "ar", "zh-SG"])).toEqual([
      "en",
      "zh-SG",
      "ar",
    ]);
  });

  test("uses an enabled stored locale before the configured default and browser", () => {
    expect(resolveDeviceLocale({
      event: "launch",
      configured: ["en", "zh-SG", "ar"],
      defaultLocale: "en",
      storedLocale: "ar",
      navigatorLanguages: ["zh-SG"],
    })).toBe("ar");
  });

  test("falls back through configured default, browser language, and English", () => {
    expect(resolveDeviceLocale({
      event: "launch",
      configured: ["en", "zh-SG"],
      defaultLocale: "zh-SG",
      storedLocale: "ar",
      navigatorLanguages: ["en-SG"],
    })).toBe("zh-SG");
    expect(resolveDeviceLocale({
      event: "launch",
      configured: ["en", "ar"],
      defaultLocale: "legacy",
      navigatorLanguages: ["ar-SG", "en-SG"],
    })).toBe("ar");
    expect(resolveDeviceLocale({
      event: "launch",
      configured: ["legacy"],
      defaultLocale: "legacy",
      navigatorLanguages: ["fr-FR"],
    })).toBe("en");
  });

  test("maps only compatible Simplified Chinese browser tags to zh-SG", () => {
    for (const language of [
      "zh-SG",
      "zh-CN",
      "zh-Hans",
      "zh-Hans-SG",
      "zh-Hans-CN",
      "ZH-cn",
    ]) {
      expect(resolveDeviceLocale({
        event: "launch",
        configured: ["en", "zh-SG"],
        defaultLocale: "legacy",
        navigatorLanguages: [language],
      })).toBe("zh-SG");
    }
  });

  test("does not map bare or Traditional Chinese browser tags to zh-SG", () => {
    for (const language of [
      "zh",
      "zh-TW",
      "zh-HK",
      "zh-MO",
      "zh-Hant",
      "zh-Hant-HK",
      "zh-Hans-TW",
    ]) {
      expect(resolveDeviceLocale({
        event: "launch",
        configured: ["en", "zh-SG"],
        defaultLocale: "legacy",
        navigatorLanguages: [language],
      })).toBe("en");
    }
  });

  test("a Traditional Chinese browser tag falls through to a configured default", () => {
    expect(resolveDeviceLocale({
      event: "launch",
      configured: ["en", "zh-SG", "ar"],
      defaultLocale: "ar",
      navigatorLanguages: ["zh-TW"],
    })).toBe("ar");
  });

  test("persists locale under an Event-isolated device key", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    saveDeviceLocale("launch", "ar", storage);
    saveDeviceLocale("wedding", "zh-SG", storage);

    expect(deviceLocaleStorageKey("launch")).not.toBe(deviceLocaleStorageKey("wedding"));
    expect(values.get(deviceLocaleStorageKey("launch"))).toBe("ar");
    expect(values.get(deviceLocaleStorageKey("wedding"))).toBe("zh-SG");
  });

  test("locale persistence is best-effort when browser storage is denied", () => {
    const deniedStorage = {
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
    };

    expect(() => saveDeviceLocale("launch", "ar", deniedStorage)).not.toThrow();
  });

  test("applies real language direction to the document root", () => {
    const root = { lang: "", dir: "" };
    applyDocumentLocale(root, "ar");
    expect(root).toEqual({ lang: "ar", dir: "rtl" });
    applyDocumentLocale(root, "zh-SG");
    expect(root).toEqual({ lang: "zh-SG", dir: "ltr" });
  });

  test("restores prior document language only for the active Event or unmount", () => {
    const root = { lang: "fr", dir: "ltr" };
    const lease = new DocumentLocaleLease(root);

    lease.apply("launch", "ar");
    expect(root).toEqual({ lang: "ar", dir: "rtl" });
    expect(lease.restore("other-event")).toBe(false);
    expect(root).toEqual({ lang: "ar", dir: "rtl" });

    expect(lease.restore("launch")).toBe(true);
    expect(root).toEqual({ lang: "fr", dir: "ltr" });

    lease.apply("wedding", "zh-SG");
    expect(root).toEqual({ lang: "zh-SG", dir: "ltr" });
    expect(lease.restore()).toBe(true);
    expect(root).toEqual({ lang: "fr", dir: "ltr" });
  });
});
