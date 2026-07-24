import type {
  ConfigRevision,
  EventExperience,
  PublicEventConfig,
} from "../../event-config";
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
