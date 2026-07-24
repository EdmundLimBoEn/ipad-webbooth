import { describe, expect, test } from "bun:test";
import type { EventExperience } from "./event-config";
import {
  isPresetId,
  parseEventPreset,
  serializePresetExperience,
} from "./event-preset";

const completeExperience: EventExperience = {
  frames: ["square", "strip"],
  locales: ["en", "zh-SG", "ar"],
  defaultLocale: "en",
  timeZone: "Asia/Singapore",
  capture: {
    reviewEnabled: true,
    autoAcceptSeconds: 5,
    countdownAudioDefault: false,
  },
  gallery: {
    title: "Launch Night",
    accentColor: "#c45f39",
  },
};

const storedPreset = {
  version: 1 as const,
  id: "launch-night",
  label: "Launch Night",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T01:00:00.000Z",
  config: completeExperience,
};

describe("Event presets", () => {
  test("round-trips the complete safe experience using fresh nested values", () => {
    const parsed = parseEventPreset(storedPreset);
    expect(parsed).toEqual(storedPreset);
    expect(parsed?.config).not.toBe(completeExperience);
    expect(parsed?.config.frames).not.toBe(completeExperience.frames);
    expect(parsed?.config.capture).not.toBe(completeExperience.capture);
    expect(parsed?.config.gallery).not.toBe(completeExperience.gallery);
  });

  test("explicit serialization omits Event, credential, revision, and operational data", () => {
    const unsafe = {
      ...completeExperience,
      event: "secret-event",
      boothKey: "plaintext",
      boothKeyHash: "hash",
      currentRevisionId: "018f0000-0000-7000-8000-000000000001",
      health: { status: "up" },
      booths: [{ id: "device" }],
      rehearsal: { id: "run" },
      photos: ["launch/photo.jpg"],
      capture: { ...completeExperience.capture, credential: "leak" },
      gallery: { ...completeExperience.gallery, private: "leak" },
    } as EventExperience;

    expect(serializePresetExperience(unsafe)).toEqual(completeExperience);
    const json = JSON.stringify(serializePresetExperience(unsafe));
    for (const forbidden of [
      "event",
      "boothKey",
      "boothKeyHash",
      "currentRevisionId",
      "health",
      "booths",
      "rehearsal",
      "photos",
      "credential",
      "private",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  test("rejects unsafe identities, labels, versions, fields, and malformed experience", () => {
    expect(isPresetId("a")).toBeTrue();
    expect(isPresetId("launch-night-2")).toBeTrue();
    for (const id of ["", "-launch", "launch-", "Launch", "../launch", "a".repeat(65)]) {
      expect(isPresetId(id)).toBeFalse();
    }

    expect(parseEventPreset({ ...storedPreset, version: 2 })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, id: "../launch" })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, label: "   " })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, label: "x".repeat(81) })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, label: "\ud800" })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, boothKeyHash: "leak" })).toBeNull();
    expect(parseEventPreset({ ...storedPreset, config: { frames: ["bad/frame"] } })).toBeNull();
  });
});
