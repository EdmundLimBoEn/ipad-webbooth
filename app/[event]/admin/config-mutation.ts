import type { ConfigRevision, PublicEventConfig } from "../../event-config";

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

export function rebaseConfigHistory(
  history: ConfigHistoryResponse,
  defaultFrames: readonly string[],
  pendingSaveMutationId: { current: string | null }
) {
  const rebased = {
    frames: Array.isArray(history.config.frames)
      ? [...history.config.frames]
      : [...defaultFrames],
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
