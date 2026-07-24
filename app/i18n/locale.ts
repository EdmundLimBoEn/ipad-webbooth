import {
  isSupportedLocale,
  localeDirection,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./catalog";

const STORAGE_PREFIX = "boothLocale:";

export function deviceLocaleStorageKey(event: string): string {
  return `${STORAGE_PREFIX}${event}`;
}

export function resolveEnabledLocales(
  configured: readonly string[] | undefined
): SupportedLocale[] {
  const enabled = (configured ?? [])
    .filter(isSupportedLocale)
    .filter((locale, index, locales) => locales.indexOf(locale) === index);
  if (!enabled.includes("en")) enabled.push("en");
  return enabled;
}

function matchBrowserLocale(
  language: string,
  enabled: readonly SupportedLocale[]
): SupportedLocale | null {
  if (isSupportedLocale(language) && enabled.includes(language)) return language;
  const normalized = language.toLowerCase();
  const candidate = SUPPORTED_LOCALES.find((locale) => {
    if (!enabled.includes(locale)) return false;
    const supported = locale.toLowerCase();
    if (supported.startsWith("zh-")) return normalized === "zh" || normalized.startsWith("zh-");
    return normalized === supported || normalized.startsWith(`${supported}-`);
  });
  return candidate ?? null;
}

export function resolveDeviceLocale(input: {
  event: string;
  configured: readonly string[] | undefined;
  defaultLocale?: string;
  storedLocale?: string | null;
  navigatorLanguages?: readonly string[];
}): SupportedLocale {
  void input.event;
  const enabled = resolveEnabledLocales(input.configured);
  if (isSupportedLocale(input.storedLocale) && enabled.includes(input.storedLocale)) {
    return input.storedLocale;
  }
  if (isSupportedLocale(input.defaultLocale) && enabled.includes(input.defaultLocale)) {
    return input.defaultLocale;
  }
  for (const language of input.navigatorLanguages ?? []) {
    const matched = matchBrowserLocale(language, enabled);
    if (matched) return matched;
  }
  return "en";
}

export function saveDeviceLocale(
  event: string,
  locale: SupportedLocale,
  storage: Pick<Storage, "setItem">
): void {
  storage.setItem(deviceLocaleStorageKey(event), locale);
}

export function applyDocumentLocale(
  documentElement: Pick<HTMLElement, "lang" | "dir">,
  locale: SupportedLocale
): void {
  documentElement.lang = locale;
  documentElement.dir = localeDirection(locale);
}
