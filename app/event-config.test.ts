import { describe, expect, test } from "bun:test";
import {
  isRevisionId,
  parseConfigRevision,
  parseEventConfig,
  projectPublicConfig,
} from "./event-config";

describe("event config schema", () => {
  test("parses the complete additive experience", () => {
    expect(parseEventConfig({
      version: 1,
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en", "zh-SG"],
      defaultLocale: "en",
      timeZone: "Asia/Singapore",
      capture: { reviewEnabled: true, autoAcceptSeconds: 5, countdownAudioDefault: false },
      gallery: { title: "Launch Night", accentColor: "#ff3366" },
    })).toEqual({
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en", "zh-SG"],
      defaultLocale: "en",
      timeZone: "Asia/Singapore",
      capture: { reviewEnabled: true, autoAcceptSeconds: 5, countdownAudioDefault: false },
      gallery: { title: "Launch Night", accentColor: "#ff3366" },
    });
  });

  test("rejects unsupported versions and malformed nested settings", () => {
    expect(parseEventConfig({ version: 2, frames: [] })).toBeNull();
    expect(parseEventConfig({ version: 1, frames: [], capture: { autoAcceptSeconds: -1 } })).toBeNull();
    expect(parseEventConfig({ version: 1, frames: [], gallery: { accentColor: "red<script>" } })).toBeNull();
  });

  test("projects only public allowlisted fields", () => {
    const projected = projectPublicConfig({
      frames: ["square"],
      boothKeyHash: "secret-hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      locales: ["en"],
      defaultLocale: "en",
    });
    expect(projected).toEqual({
      frames: ["square"],
      hasBoothKey: true,
      locales: ["en"],
      defaultLocale: "en",
    });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("boothKeyHash");
    expect(json).not.toContain("currentRevisionId");
    expect(projectPublicConfig(null)).toEqual({ frames: null, hasBoothKey: false });
  });

  test("revision parsing rejects credentials inside experience", () => {
    const base = {
      version: 1,
      id: "018f0000-0000-7000-8000-000000000001",
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "baseline",
    };
    expect(parseConfigRevision({ ...base, config: { frames: ["square"] } })).not.toBeNull();
    expect(parseConfigRevision({ ...base, config: { frames: ["square"], boothKeyHash: "leak" } })).toBeNull();
  });

  test("accepts UUID mutation/revision IDs only", () => {
    expect(isRevisionId("018f0000-0000-7000-8000-000000000001")).toBe(true);
    expect(isRevisionId("../config")).toBe(false);
  });
});
