import { expect, test } from "bun:test";
import {
  buildConfigSaveBody,
  clearRestoreRequestAfterReconciliation,
  getOrCreateRestoreRequest,
  parseConfigHistoryResponse,
  parseConfigMutationResponse,
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
  expect(rebased.locales).toEqual(["en"]);
  expect(rebased.defaultLocale).toBe("en");
  expect(rebased.reviewEnabled).toBe(true);
  expect(rebased.autoAcceptSeconds).toBe(5);
  expect(rebased.countdownAudioDefault).toBe(false);
  expect(pendingSave.current).toBeNull();
});

test("history rebase restores the complete safe editable experience", () => {
  const pendingSave = { current: MUTATION_ID as string | null };
  const gallery = { title: "Launch Night", accentColor: "#ff3366" };

  const rebased = rebaseConfigHistory(
    {
      config: {
        frames: ["one"],
        hasBoothKey: true,
        locales: ["zh-SG", "ar"],
        defaultLocale: "ar",
        timeZone: "Asia/Singapore",
        capture: {
          reviewEnabled: false,
          autoAcceptSeconds: 12,
          countdownAudioDefault: true,
        },
        gallery,
      },
      currentRevisionId: LATER_BASE,
      revisions: [],
    },
    ["fallback"],
    pendingSave
  );

  expect(rebased).toMatchObject({
    frames: ["one"],
    hasBoothKey: true,
    locales: ["en", "zh-SG", "ar"],
    defaultLocale: "ar",
    timeZone: "Asia/Singapore",
    reviewEnabled: false,
    autoAcceptSeconds: 12,
    countdownAudioDefault: true,
    gallery,
  });
  expect(rebased.gallery).not.toBe(gallery);
});

test("save input carries the complete safe experience without unchanged Booth credentials", () => {
  const body = buildConfigSaveBody({
    frames: ["one"],
    locales: ["en", "ar"],
    defaultLocale: "ar",
    timeZone: "Asia/Singapore",
    reviewEnabled: false,
    autoAcceptSeconds: 8,
    countdownAudioDefault: true,
    gallery: { title: "Launch Night", accentColor: "#ff3366" },
    mutationId: MUTATION_ID,
    baseRevisionId: FIRST_BASE,
  });

  expect(body).toEqual({
    frames: ["one"],
    locales: ["en", "ar"],
    defaultLocale: "ar",
    timeZone: "Asia/Singapore",
    capture: {
      reviewEnabled: false,
      autoAcceptSeconds: 8,
      countdownAudioDefault: true,
    },
    gallery: { title: "Launch Night", accentColor: "#ff3366" },
    mutationId: MUTATION_ID,
    baseRevisionId: FIRST_BASE,
  });
  expect(JSON.stringify(body)).not.toContain("boothKey");
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

test("strictly parses a complete Admin configuration history response", () => {
  expect(parseConfigHistoryResponse({
    config: {
      frames: ["one"],
      hasBoothKey: true,
      locales: ["en", "ar"],
      defaultLocale: "ar",
      capture: {
        reviewEnabled: false,
        autoAcceptSeconds: 9,
        countdownAudioDefault: true,
      },
    },
    currentRevisionId: SOURCE_REVISION,
    revisions: [{
      version: 1,
      id: SOURCE_REVISION,
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "save",
      config: {
        frames: ["one"],
        locales: ["en", "ar"],
        defaultLocale: "ar",
        capture: {
          reviewEnabled: false,
          autoAcceptSeconds: 9,
          countdownAudioDefault: true,
        },
      },
    }],
  })).toMatchObject({
    config: {
      frames: ["one"],
      hasBoothKey: true,
      locales: ["en", "ar"],
      defaultLocale: "ar",
    },
    currentRevisionId: SOURCE_REVISION,
    revisions: [{ id: SOURCE_REVISION }],
  });
});

test("rejects malformed nested config and revision data before rebase", () => {
  const base = {
    config: { frames: ["one"], hasBoothKey: false },
    currentRevisionId: null,
    revisions: [],
  };
  const malformed = [
    { ...base, config: { ...base.config, locales: [null] } },
    { ...base, config: { ...base.config, capture: { autoAcceptSeconds: 0 } } },
    { ...base, currentRevisionId: "../revision" },
    { ...base, revisions: [null] },
    {
      ...base,
      revisions: [{
        version: 1,
        id: SOURCE_REVISION,
        createdAt: "2026-07-24T00:00:00.000Z",
        parentRevisionId: null,
        reason: "save",
        config: { frames: ["one"], capture: { reviewEnabled: "yes" } },
      }],
    },
  ];

  for (const response of malformed) {
    expect(() => parseConfigHistoryResponse(response)).not.toThrow();
    expect(parseConfigHistoryResponse(response)).toBeNull();
  }
});

test("strictly parses mutation responses before applying restored settings", () => {
  expect(parseConfigMutationResponse({
    frames: ["one"],
    hasBoothKey: true,
    locales: ["en"],
    defaultLocale: "en",
    capture: {
      reviewEnabled: true,
      autoAcceptSeconds: 5,
      countdownAudioDefault: false,
    },
    currentRevisionId: SOURCE_REVISION,
    idempotent: false,
  })).toMatchObject({
    frames: ["one"],
    currentRevisionId: SOURCE_REVISION,
    idempotent: false,
  });

  expect(parseConfigMutationResponse({
    frames: ["one"],
    hasBoothKey: true,
    locales: ["en"],
    defaultLocale: "en",
    capture: { autoAcceptSeconds: "soon" },
    currentRevisionId: SOURCE_REVISION,
    idempotent: false,
  })).toBeNull();
});
