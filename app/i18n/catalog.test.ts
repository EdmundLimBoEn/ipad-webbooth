import { describe, expect, test } from "bun:test";
import {
  arabicMessages,
  chineseSingaporeMessages,
  englishMessages,
  isSupportedLocale,
  localeDirection,
  message,
  SUPPORTED_LOCALES,
} from "./catalog";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

describe("guest message catalogs", () => {
  test("publishes the fixed supported locale contract", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-SG", "ar"]);
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("zh-SG")).toBe(true);
    expect(isSupportedLocale("ar")).toBe(true);
    expect(isSupportedLocale("zh")).toBe(false);
    expect(isSupportedLocale({ locale: "en" })).toBe(false);
  });

  test("every translation has exactly the English keys and placeholders", () => {
    const englishKeys = Object.keys(englishMessages).sort();

    for (const catalog of [chineseSingaporeMessages, arabicMessages]) {
      expect(Object.keys(catalog).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        expect(placeholders(catalog[key as keyof typeof catalog])).toEqual(
          placeholders(englishMessages[key as keyof typeof englishMessages])
        );
      }
    }
  });

  test("interpolates values without disturbing unknown placeholders", () => {
    expect(message("zh-SG", "photoCount", { count: 3 })).toBe("3 张照片");
    expect(message("ar", "uploading", { count: 2 })).toContain("2");
    expect(message("en", "photoCount")).toBe("{count} photos");
  });

  test("falls back to English when a runtime catalog entry is unavailable", () => {
    const key = "pickStyle";
    const original = chineseSingaporeMessages[key];
    Reflect.deleteProperty(chineseSingaporeMessages, key);
    try {
      expect(message("zh-SG", key)).toBe(englishMessages[key]);
    } finally {
      chineseSingaporeMessages[key] = original;
    }
  });

  test("marks Arabic as RTL and the other catalogs as LTR", () => {
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("zh-SG")).toBe("ltr");
  });
});
