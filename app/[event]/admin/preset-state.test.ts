import { describe, expect, test } from "bun:test";
import type { EventPreset } from "../../event-preset";
import {
  getOrCreatePresetApply,
  mergePresetPage,
  reconcileAppliedPreset,
} from "./preset-state";

const preset = (id: string, label: string, updatedAt = "2026-07-24T00:00:00.000Z"): EventPreset => ({
  version: 1,
  id,
  label,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt,
  config: { frames: [id] },
});

describe("Admin preset state", () => {
  test("deduplicates exact IDs, keeps updates, and globally orders label then ID", () => {
    expect(mergePresetPage(
      [preset("z", "Beta"), preset("a", "Alpha")],
      [preset("z", "Aardvark", "2026-07-24T01:00:00.000Z"), preset("b", "Alpha")],
    ).map(({ id, label }) => [id, label])).toEqual([
      ["z", "Aardvark"],
      ["a", "Alpha"],
      ["b", "Alpha"],
    ]);
  });

  test("retains the exact retry tuple until the base changes", () => {
    const pending = new Map();
    let next = 0;
    const makeId = () => `id-${++next}`;
    const first = getOrCreatePresetApply(pending, "launch", null, makeId);
    expect(getOrCreatePresetApply(pending, "launch", null, makeId)).toBe(first);
    const rebased = getOrCreatePresetApply(pending, "launch", "revision-2", makeId);
    expect(rebased).not.toBe(first);
    expect(rebased).toEqual({
      presetId: "launch",
      mutationId: "id-2",
      baseRevisionId: "revision-2",
    });
  });

  test("rebases the complete authoritative experience and rejects stale responses", () => {
    const revisionId = "018f0000-0000-4000-8000-000000000401";
    const config = {
      frames: ["square"],
      locales: ["en", "ar"],
      defaultLocale: "ar",
      timeZone: "Asia/Singapore",
      capture: {
        reviewEnabled: false,
        autoAcceptSeconds: 8,
        countdownAudioDefault: true,
      },
      gallery: { title: "Night", accentColor: "#112233" },
      hasBoothKey: true,
    };
    const history = {
      config,
      currentRevisionId: revisionId,
      revisions: [{
        version: 1 as const,
        id: revisionId,
        createdAt: "2026-07-24T00:00:00.000Z",
        parentRevisionId: null,
        reason: "preset" as const,
        sourcePresetId: "launch",
        config: { ...config, hasBoothKey: undefined },
      }],
    };
    expect(reconcileAppliedPreset({
      response: { ...config, currentRevisionId: revisionId },
      history,
      sourcePresetId: "launch",
    })).toEqual({
      experience: {
        frames: ["square"],
        locales: ["en", "ar"],
        defaultLocale: "ar",
        timeZone: "Asia/Singapore",
        capture: config.capture,
        gallery: config.gallery,
      },
      currentRevisionId: revisionId,
      hasBoothKey: true,
    });
    expect(() => reconcileAppliedPreset({
      response: { ...config, currentRevisionId: revisionId },
      history: { ...history, currentRevisionId: null },
      sourcePresetId: "launch",
    })).toThrow("stale");
  });
});
