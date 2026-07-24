import type { EventExperience, PublicEventConfig } from "../../event-config";
import type { EventPreset } from "../../event-preset";
import type { ConfigHistoryResponse } from "./config-mutation";

export type PendingPresetApply = Readonly<{
  presetId: string;
  mutationId: string;
  baseRevisionId: string | null;
}>;

export function mergePresetPage(
  current: readonly EventPreset[],
  incoming: readonly EventPreset[],
): EventPreset[] {
  const byId = new Map(current.map((preset) => [preset.id, preset]));
  for (const preset of incoming) byId.set(preset.id, preset);
  return [...byId.values()].sort((left, right) =>
    left.label < right.label
      ? -1
      : left.label > right.label
        ? 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0
  );
}

export function getOrCreatePresetApply(
  pending: Map<string, PendingPresetApply>,
  presetId: string,
  baseRevisionId: string | null,
  makeId: () => string,
): PendingPresetApply {
  const retained = pending.get(presetId);
  if (retained?.baseRevisionId === baseRevisionId) return retained;
  const created = Object.freeze({
    presetId,
    mutationId: makeId(),
    baseRevisionId,
  });
  pending.set(presetId, created);
  return created;
}

export function reconcileAppliedPreset(input: {
  response: PublicEventConfig & { currentRevisionId: string };
  history: ConfigHistoryResponse;
  sourcePresetId: string;
}): {
  experience: EventExperience;
  currentRevisionId: string;
  hasBoothKey: boolean;
} {
  const head = input.history.revisions.find(
    (revision) => revision.id === input.history.currentRevisionId,
  );
  if (
    input.history.currentRevisionId !== input.response.currentRevisionId
    || head?.reason !== "preset"
    || head.sourcePresetId !== input.sourcePresetId
    || input.history.config.frames === null
    || input.history.config.hasBoothKey !== input.response.hasBoothKey
  ) {
    throw new TypeError("preset application response is stale");
  }
  const {
    hasBoothKey,
    frames,
    ...rest
  } = input.history.config;
  return {
    experience: { ...rest, frames: [...frames] },
    currentRevisionId: input.history.currentRevisionId,
    hasBoothKey,
  };
}
