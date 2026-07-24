import {
  isRevisionId,
  parseConfigRevision,
  parseEventConfig,
  projectEventExperience,
  type ConfigRevision,
  type EventExperience,
  type PublicEventConfig,
} from "../../event-config";
import { isPresetId } from "../../event-preset";
/*
 * Keep the runtime parsers in this client-safe helper: Admin responses cross
 * a network trust boundary even though their TypeScript interfaces are local.
 */
import {
  isSupportedLocale,
  type SupportedLocale,
} from "../../i18n/catalog";
import { resolveEnabledLocales } from "../../i18n/locale";

export type RestoreRequest = Readonly<{
  revisionId: string;
  mutationId: string;
  baseRevisionId: string | null;
}>;

export type ConfigHistoryResponse = {
  config: PublicEventConfig;
  currentRevisionId: string | null;
  revisions: ConfigRevision[];
};

export type ConfigMutationResponse = PublicEventConfig & {
  currentRevisionId: string;
  idempotent: boolean;
};

export type PresetApplyResponse = ConfigMutationResponse & {
  sourcePresetId: string;
};

const EXPERIENCE_KEYS = [
  "frames",
  "locales",
  "defaultLocale",
  "timeZone",
  "capture",
  "gallery",
] as const;
const PUBLIC_CONFIG_KEYS = [...EXPERIENCE_KEYS, "hasBoothKey"] as const;
const REVISION_KEYS = [
  "version",
  "id",
  "createdAt",
  "parentRevisionId",
  "reason",
  "sourceRevisionId",
  "sourcePresetId",
  "config",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasStrictExperienceShape(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  if (!hasOnlyKeys(value, allowed)) return false;
  if (
    value.capture !== undefined
    && (
      !isObject(value.capture)
      || !hasOnlyKeys(value.capture, [
        "reviewEnabled",
        "autoAcceptSeconds",
        "countdownAudioDefault",
      ])
    )
  ) {
    return false;
  }
  return value.gallery === undefined
    || (
      isObject(value.gallery)
      && hasOnlyKeys(value.gallery, ["title", "accentColor"])
    );
}

function parsePublicConfigResponse(value: unknown): PublicEventConfig | null {
  if (
    !isObject(value)
    || !hasStrictExperienceShape(value, PUBLIC_CONFIG_KEYS)
    || typeof value.hasBoothKey !== "boolean"
  ) {
    return null;
  }
  if (value.frames === null) {
    return Object.keys(value).every((key) => ["frames", "hasBoothKey"].includes(key))
      ? { frames: null, hasBoothKey: value.hasBoothKey }
      : null;
  }
  const parsed = parseEventConfig({ ...value, version: 1 });
  if (!parsed) return null;
  return {
    ...projectEventExperience(parsed),
    hasBoothKey: value.hasBoothKey,
  };
}

function parseStrictRevision(value: unknown): ConfigRevision | null {
  if (
    !isObject(value)
    || !hasOnlyKeys(value, REVISION_KEYS)
    || !isObject(value.config)
    || !hasStrictExperienceShape(value.config, EXPERIENCE_KEYS)
  ) {
    return null;
  }
  return parseConfigRevision(value);
}

export function parseConfigHistoryResponse(
  value: unknown
): ConfigHistoryResponse | null {
  if (
    !isObject(value)
    || !hasOnlyKeys(value, ["config", "currentRevisionId", "revisions"])
    || (
      value.currentRevisionId !== null
      && !isRevisionId(value.currentRevisionId)
    )
    || !Array.isArray(value.revisions)
  ) {
    return null;
  }
  const config = parsePublicConfigResponse(value.config);
  const revisions = value.revisions.map(parseStrictRevision);
  if (!config || revisions.some((revision) => revision === null)) return null;
  return {
    config,
    currentRevisionId: value.currentRevisionId,
    revisions: revisions as ConfigRevision[],
  };
}

export function parseConfigMutationResponse(
  value: unknown
): ConfigMutationResponse | null {
  if (
    !isObject(value)
    || !hasOnlyKeys(value, [
      ...PUBLIC_CONFIG_KEYS,
      "currentRevisionId",
      "idempotent",
    ])
    || !isRevisionId(value.currentRevisionId)
    || typeof value.idempotent !== "boolean"
  ) {
    return null;
  }
  const {
    currentRevisionId,
    idempotent,
    ...configValue
  } = value;
  const config = parsePublicConfigResponse(configValue);
  if (!config || config.frames === null) return null;
  return {
    ...config,
    currentRevisionId,
    idempotent,
  };
}

export function parsePresetApplyResponse(
  value: unknown
): PresetApplyResponse | null {
  if (
    !isObject(value)
    || !hasOnlyKeys(value, [
      ...PUBLIC_CONFIG_KEYS,
      "currentRevisionId",
      "sourcePresetId",
      "idempotent",
    ])
    || !isPresetId(value.sourcePresetId)
  ) {
    return null;
  }
  const { sourcePresetId, ...mutationValue } = value;
  const mutation = parseConfigMutationResponse(mutationValue);
  return mutation ? { ...mutation, sourcePresetId } : null;
}

export type EditableEventExperience = {
  frames: string[];
  locales: SupportedLocale[];
  defaultLocale: SupportedLocale;
  timeZone?: string;
  reviewEnabled: boolean;
  autoAcceptSeconds: number;
  countdownAudioDefault: boolean;
  gallery?: EventExperience["gallery"];
};

export type ConfigSaveInput = EditableEventExperience & {
  mutationId: string;
  baseRevisionId: string | null;
  boothKey?: string;
};

export function editableExperienceFromConfig(
  config: PublicEventConfig,
  defaultFrames: readonly string[]
): EditableEventExperience {
  const locales = resolveEnabledLocales(config.locales);
  return {
    frames: Array.isArray(config.frames) ? [...config.frames] : [...defaultFrames],
    locales,
    defaultLocale:
      isSupportedLocale(config.defaultLocale) && locales.includes(config.defaultLocale)
        ? config.defaultLocale
        : "en",
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    reviewEnabled: config.capture?.reviewEnabled ?? true,
    autoAcceptSeconds: config.capture?.autoAcceptSeconds ?? 5,
    countdownAudioDefault: config.capture?.countdownAudioDefault ?? false,
    ...(config.gallery ? { gallery: { ...config.gallery } } : {}),
  };
}

export function buildConfigSaveBody(input: ConfigSaveInput) {
  return {
    frames: [...input.frames],
    locales: [...input.locales],
    defaultLocale: input.defaultLocale,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    capture: {
      reviewEnabled: input.reviewEnabled,
      autoAcceptSeconds: input.autoAcceptSeconds,
      countdownAudioDefault: input.countdownAudioDefault,
    },
    ...(input.gallery
      ? {
        gallery: {
          ...(input.gallery.title !== undefined ? { title: input.gallery.title } : {}),
          ...(input.gallery.accentColor !== undefined
            ? { accentColor: input.gallery.accentColor }
            : {}),
        },
      }
      : {}),
    ...(input.boothKey ? { boothKey: input.boothKey } : {}),
    mutationId: input.mutationId,
    baseRevisionId: input.baseRevisionId,
  };
}

export function rebaseConfigHistory(
  history: ConfigHistoryResponse,
  defaultFrames: readonly string[],
  pendingSaveMutationId: { current: string | null }
) {
  const experience = editableExperienceFromConfig(history.config, defaultFrames);
  const rebased = {
    ...experience,
    hasBoothKey: Boolean(history.config.hasBoothKey),
    currentRevisionId: history.currentRevisionId,
    revisions: history.revisions,
  };
  pendingSaveMutationId.current = null;
  return rebased;
}

export function getOrCreateRestoreRequest(
  pending: Map<string, RestoreRequest>,
  revisionId: string,
  baseRevisionId: string | null,
  createMutationId: () => string
): RestoreRequest {
  const retained = pending.get(revisionId);
  if (retained) return retained;

  const request = Object.freeze({
    revisionId,
    mutationId: createMutationId(),
    baseRevisionId,
  });
  pending.set(revisionId, request);
  return request;
}

export function shouldClearRestoreRequest(status: number): boolean {
  return [400, 401, 404, 409].includes(status);
}

export async function clearRestoreRequestAfterReconciliation(
  pending: Map<string, RestoreRequest>,
  request: RestoreRequest,
  reconcile: () => Promise<void>
): Promise<void> {
  await reconcile();
  if (pending.get(request.revisionId) === request) {
    pending.delete(request.revisionId);
  }
}
