import {
  parseEventExperience,
  type EventExperience,
} from "./event-config";

export const EVENT_PRESET_VERSION = 1 as const;
const PRESET_FIELDS = new Set([
  "version",
  "id",
  "label",
  "createdAt",
  "updatedAt",
  "config",
]);

export type EventPreset = {
  version: typeof EVENT_PRESET_VERSION;
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  config: EventExperience;
};

export const isPresetId = (value: unknown): value is string =>
  typeof value === "string"
  && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPresetLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && [...value].length <= 80;
}

export function serializePresetExperience(
  experience: EventExperience,
): EventExperience {
  const parsed = parseEventExperience(experience);
  if (!parsed) throw new TypeError("invalid preset experience");
  return {
    frames: [...parsed.frames],
    ...(parsed.locales ? { locales: [...parsed.locales] } : {}),
    ...(parsed.defaultLocale !== undefined ? { defaultLocale: parsed.defaultLocale } : {}),
    ...(parsed.timeZone !== undefined ? { timeZone: parsed.timeZone } : {}),
    ...(parsed.capture
      ? {
          capture: {
            ...(parsed.capture.reviewEnabled !== undefined
              ? { reviewEnabled: parsed.capture.reviewEnabled }
              : {}),
            ...(parsed.capture.autoAcceptSeconds !== undefined
              ? { autoAcceptSeconds: parsed.capture.autoAcceptSeconds }
              : {}),
            ...(parsed.capture.countdownAudioDefault !== undefined
              ? { countdownAudioDefault: parsed.capture.countdownAudioDefault }
              : {}),
          },
        }
      : {}),
    ...(parsed.gallery
      ? {
          gallery: {
            ...(parsed.gallery.title !== undefined ? { title: parsed.gallery.title } : {}),
            ...(parsed.gallery.accentColor !== undefined
              ? { accentColor: parsed.gallery.accentColor }
              : {}),
          },
        }
      : {}),
  };
}

export function parseEventPreset(value: unknown): EventPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !PRESET_FIELDS.has(key))
    || Object.keys(record).length !== PRESET_FIELDS.size
    || record.version !== EVENT_PRESET_VERSION
    || !isPresetId(record.id)
    || !isPresetLabel(record.label)
    || !isIsoTimestamp(record.createdAt)
    || !isIsoTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    return null;
  }
  const config = parseEventExperience(record.config);
  if (!config) return null;
  return {
    version: EVENT_PRESET_VERSION,
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    config: serializePresetExperience(config),
  };
}

export function validatePresetLabel(value: unknown): string {
  if (!isPresetLabel(value)) throw new TypeError("preset label must contain 1 to 80 characters");
  return value;
}
