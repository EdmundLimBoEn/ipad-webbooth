import { describe, expect, test } from "bun:test";
import {
  applyDocumentLocale,
  deviceLocaleStorageKey,
  resolveDeviceLocale,
  resolveEnabledLocales,
  saveDeviceLocale,
} from "./locale";

describe("guest locale resolution", () => {
  test("intersects configured locales with catalogs, deduplicates, and retains English", () => {
    expect(resolveEnabledLocales(undefined)).toEqual(["en"]);
    expect(resolveEnabledLocales(["ar", "legacy", "ar", "zh-SG"])).toEqual([
      "ar",
      "zh-SG",
      "en",
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

  test("applies real language direction to the document root", () => {
    const root = { lang: "", dir: "" };
    applyDocumentLocale(root, "ar");
    expect(root).toEqual({ lang: "ar", dir: "rtl" });
    applyDocumentLocale(root, "zh-SG");
    expect(root).toEqual({ lang: "zh-SG", dir: "ltr" });
  });
});
