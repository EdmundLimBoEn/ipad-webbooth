import { expect, test } from "bun:test";
import {
  clearRestoreRequestAfterReconciliation,
  getOrCreateRestoreRequest,
  rebaseConfigHistory,
  shouldClearRestoreRequest,
  type RestoreRequest,
} from "./config-mutation";

const SOURCE_REVISION = "018f0000-0000-7000-8000-000000000030";
const FIRST_BASE = "018f0000-0000-7000-8000-000000000031";
const LATER_BASE = "018f0000-0000-7000-8000-000000000032";
const MUTATION_ID = "018f0000-0000-7000-8000-000000000033";
const NEXT_MUTATION_ID = "018f0000-0000-7000-8000-000000000034";

test("restore retries retain the complete immutable request when the editor base changes", () => {
  const pending = new Map<string, RestoreRequest>();
  let generated = 0;
  const createMutationId = () => {
    generated += 1;
    return MUTATION_ID;
  };

  const first = getOrCreateRestoreRequest(
    pending,
    SOURCE_REVISION,
    FIRST_BASE,
    createMutationId
  );
  const retry = getOrCreateRestoreRequest(
    pending,
    SOURCE_REVISION,
    LATER_BASE,
    createMutationId
  );

  expect(first).toEqual({
    revisionId: SOURCE_REVISION,
    mutationId: MUTATION_ID,
    baseRevisionId: FIRST_BASE,
  });
  expect(retry).toBe(first);
  expect(Object.isFrozen(retry)).toBe(true);
  expect(generated).toBe(1);

  pending.delete(SOURCE_REVISION);
  const nextIntent = getOrCreateRestoreRequest(
    pending,
    SOURCE_REVISION,
    LATER_BASE,
    () => NEXT_MUTATION_ID
  );
  expect(nextIntent).toEqual({
    revisionId: SOURCE_REVISION,
    mutationId: NEXT_MUTATION_ID,
    baseRevisionId: LATER_BASE,
  });
  expect(nextIntent).not.toBe(first);
});

test("only definitive restore failures clear a retained request before reconciliation", () => {
  for (const status of [400, 401, 404, 409]) {
    expect(shouldClearRestoreRequest(status)).toBe(true);
  }
  for (const status of [0, 200, 204, 408, 425, 429, 500, 503]) {
    expect(shouldClearRestoreRequest(status)).toBe(false);
  }
});

test("a successful history rebase clears an ambiguous Save mutation ID", () => {
  const pendingSave = { current: MUTATION_ID as string | null };

  const rebased = rebaseConfigHistory(
    {
      config: { frames: ["one"], hasBoothKey: true },
      currentRevisionId: LATER_BASE,
      revisions: [],
    },
    ["fallback"],
    pendingSave
  );

  expect(rebased.frames).toEqual(["one"]);
  expect(rebased.hasBoothKey).toBe(true);
  expect(rebased.currentRevisionId).toBe(LATER_BASE);
  expect(pendingSave.current).toBeNull();
});

test("a 2xx restore retains its exact tuple until parsing, apply, and history reload finish", async () => {
  const pending = new Map<string, RestoreRequest>();
  const request = getOrCreateRestoreRequest(
    pending,
    SOURCE_REVISION,
    FIRST_BASE,
    () => MUTATION_ID
  );

  for (const failedStep of ["response JSON", "response apply", "history reload"]) {
    await expect(
      clearRestoreRequestAfterReconciliation(pending, request, async () => {
        throw new Error(`${failedStep} failed`);
      })
    ).rejects.toThrow(`${failedStep} failed`);
    expect(pending.get(SOURCE_REVISION)).toBe(request);
  }

  await clearRestoreRequestAfterReconciliation(pending, request, async () => {});
  expect(pending.has(SOURCE_REVISION)).toBe(false);
});
