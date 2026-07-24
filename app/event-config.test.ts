import { describe, expect, test } from "bun:test";
import {
  isRevisionId,
  parseConfigRevision,
  parseEventConfig,
  projectEventExperience,
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

  test("keeps legacy stored LocaleCode values readable", () => {
    expect(parseEventConfig({
      version: 1,
      frames: ["square"],
      locales: ["en", "future-locale"],
      defaultLocale: "future-locale",
    })).toEqual({
      frames: ["square"],
      locales: ["en", "future-locale"],
      defaultLocale: "future-locale",
    });
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

  test("projects a Booth experience without private configuration fields", () => {
    const projected = projectEventExperience({
      frames: ["square"],
      boothKeyHash: "salt:hash",
      currentRevisionId: "018f0000-0000-4000-8000-000000000001",
    });

    expect(projected).toEqual({ frames: ["square"] });
    expect(JSON.stringify(projected)).not.toContain("boothKeyHash");
    expect(JSON.stringify(projected)).not.toContain("currentRevisionId");
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

  test("revision parsing rejects top-level credentials", () => {
    expect(parseConfigRevision({
      version: 1,
      id: "018f0000-0000-7000-8000-000000000001",
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "baseline",
      boothKeyHash: "leak",
      config: { frames: ["square"] },
    })).toBeNull();
  });

  test("revision parsing rejects invalid source IDs", () => {
    const base = {
      version: 1,
      id: "018f0000-0000-7000-8000-000000000001",
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "baseline",
      config: { frames: ["square"] },
    };
    expect(parseConfigRevision({ ...base, sourceRevisionId: "../revision" })).toBeNull();
    expect(parseConfigRevision({ ...base, sourcePresetId: "preset<script>" })).toBeNull();
  });

  test("rejects array capture and gallery settings", () => {
    expect(parseEventConfig({ version: 1, frames: [], capture: [] })).toBeNull();
    expect(parseEventConfig({ version: 1, frames: [], gallery: [] })).toBeNull();
  });

  test("omits unknown nested fields from parsed and public config", () => {
    const nestedCapture = {
      reviewEnabled: true,
      boothKeyHash: "leak",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      unknownNestedField: "discard",
    };
    const nestedGallery = {
      title: "Launch Night",
      boothKeyHash: "leak",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      unknownNestedField: "discard",
    };
    const expectedExperience = {
      frames: ["square"],
      capture: { reviewEnabled: true },
      gallery: { title: "Launch Night" },
    };

    expect(parseEventConfig({ version: 1, ...expectedExperience, capture: nestedCapture, gallery: nestedGallery }))
      .toEqual(expectedExperience);
    expect(parseConfigRevision({
      version: 1,
      id: "018f0000-0000-7000-8000-000000000001",
      createdAt: "2026-07-24T00:00:00.000Z",
      parentRevisionId: null,
      reason: "baseline",
      config: { ...expectedExperience, capture: nestedCapture, gallery: nestedGallery },
    })?.config).toEqual(expectedExperience);
    expect(projectPublicConfig({
      ...expectedExperience,
      capture: nestedCapture,
      gallery: nestedGallery,
    } as Parameters<typeof projectPublicConfig>[0])).toEqual({
      ...expectedExperience,
      hasBoothKey: false,
    });
  });

  test("accepts UUID mutation/revision IDs only", () => {
    expect(isRevisionId("018f0000-0000-7000-8000-000000000001")).toBe(true);
    expect(isRevisionId("../config")).toBe(false);
  });
});
