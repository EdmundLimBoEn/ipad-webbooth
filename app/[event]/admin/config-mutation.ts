export type RestoreRequest = Readonly<{
  revisionId: string;
  mutationId: string;
  baseRevisionId: string | null;
}>;

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
  return (status >= 200 && status < 300) || [400, 401, 404, 409].includes(status);
}
