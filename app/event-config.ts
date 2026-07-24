export const EVENT_CONFIG_VERSION = 1 as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type LocaleCode = string;

export type EventExperience = {
  frames: string[];
  locales?: LocaleCode[];
  defaultLocale?: LocaleCode;
  timeZone?: string;
  capture?: {
    reviewEnabled?: boolean;
    autoAcceptSeconds?: number;
    countdownAudioDefault?: boolean;
  };
  gallery?: { title?: string; accentColor?: string };
};

export type EventConfig = EventExperience & {
  boothKeyHash?: string;
  currentRevisionId?: string;
};

export type ConfigRevision = {
  version: 1;
  id: string;
  createdAt: string;
  parentRevisionId: string | null;
  reason: "baseline" | "save" | "restore" | "preset";
  sourceRevisionId?: string;
  sourcePresetId?: string;
  config: EventExperience;
};

export type PublicEventConfig = Omit<EventExperience, "frames"> & {
  frames: string[] | null;
  hasBoothKey: boolean;
};

export const isRevisionId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

function parseExperience(value: unknown): EventExperience | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.frames) || !v.frames.every((x) => typeof x === "string" && TOKEN.test(x))) return null;
  if (v.locales !== undefined && (!Array.isArray(v.locales) || !v.locales.every((x) => typeof x === "string" && TOKEN.test(x)))) return null;
  if (v.defaultLocale !== undefined && (typeof v.defaultLocale !== "string" || !TOKEN.test(v.defaultLocale))) return null;
  if (v.timeZone !== undefined && (typeof v.timeZone !== "string" || v.timeZone.length > 128)) return null;

  const capture = v.capture as Record<string, unknown> | undefined;
  if (capture !== undefined && (!capture || typeof capture !== "object" || Array.isArray(capture))) return null;
  if (capture?.reviewEnabled !== undefined && typeof capture.reviewEnabled !== "boolean") return null;
  if (capture?.countdownAudioDefault !== undefined && typeof capture.countdownAudioDefault !== "boolean") return null;
  if (capture?.autoAcceptSeconds !== undefined && (typeof capture.autoAcceptSeconds !== "number" || !Number.isInteger(capture.autoAcceptSeconds) || capture.autoAcceptSeconds < 1 || capture.autoAcceptSeconds > 30)) return null;

  const gallery = v.gallery as Record<string, unknown> | undefined;
  if (gallery !== undefined && (!gallery || typeof gallery !== "object" || Array.isArray(gallery))) return null;
  if (gallery?.title !== undefined && (typeof gallery.title !== "string" || gallery.title.length > 120)) return null;
  if (gallery?.accentColor !== undefined && (typeof gallery.accentColor !== "string" || !HEX_COLOR.test(gallery.accentColor))) return null;

  return {
    frames: [...v.frames] as string[],
    ...(v.locales ? { locales: [...v.locales] as string[] } : {}),
    ...(typeof v.defaultLocale === "string" ? { defaultLocale: v.defaultLocale } : {}),
    ...(typeof v.timeZone === "string" ? { timeZone: v.timeZone } : {}),
    ...(capture ? { capture: { ...capture } as EventExperience["capture"] } : {}),
    ...(gallery ? { gallery: { ...gallery } as EventExperience["gallery"] } : {}),
  };
}

export function parseEventConfig(value: unknown): EventConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== undefined && v.version !== EVENT_CONFIG_VERSION) return null;
  const experience = parseExperience({ ...v, frames: v.frames ?? [] });
  if (!experience) return null;
  if (v.boothKeyHash !== undefined && typeof v.boothKeyHash !== "string") return null;
  if (v.currentRevisionId !== undefined && !isRevisionId(v.currentRevisionId)) return null;
  return {
    ...experience,
    ...(typeof v.boothKeyHash === "string" ? { boothKeyHash: v.boothKeyHash } : {}),
    ...(typeof v.currentRevisionId === "string" ? { currentRevisionId: v.currentRevisionId } : {}),
  };
}

export function parseConfigRevision(value: unknown): ConfigRevision | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !isRevisionId(v.id) || typeof v.createdAt !== "string") return null;
  if (v.parentRevisionId !== null && !isRevisionId(v.parentRevisionId)) return null;
  if (!["baseline", "save", "restore", "preset"].includes(String(v.reason))) return null;
  if (v.boothKeyHash !== undefined) return null;
  if (v.sourceRevisionId !== undefined && !isRevisionId(v.sourceRevisionId)) return null;
  if (v.sourcePresetId !== undefined && (typeof v.sourcePresetId !== "string" || !TOKEN.test(v.sourcePresetId))) return null;
  const config = parseExperience(v.config);
  if (!config || (v.config as Record<string, unknown>).boothKeyHash !== undefined) return null;
  return {
    version: EVENT_CONFIG_VERSION,
    id: v.id,
    createdAt: v.createdAt,
    parentRevisionId: v.parentRevisionId,
    reason: v.reason as ConfigRevision["reason"],
    ...(typeof v.sourceRevisionId === "string" ? { sourceRevisionId: v.sourceRevisionId } : {}),
    ...(typeof v.sourcePresetId === "string" ? { sourcePresetId: v.sourcePresetId } : {}),
    config,
  };
}

export function projectPublicConfig(config: EventConfig | null): PublicEventConfig {
  if (!config) return { frames: null, hasBoothKey: false };
  return {
    frames: [...config.frames],
    hasBoothKey: Boolean(config.boothKeyHash),
    ...(config.locales ? { locales: [...config.locales] } : {}),
    ...(config.defaultLocale ? { defaultLocale: config.defaultLocale } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(config.capture ? { capture: { ...config.capture } } : {}),
    ...(config.gallery ? { gallery: { ...config.gallery } } : {}),
  };
}
