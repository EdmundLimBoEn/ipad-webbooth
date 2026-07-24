import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventPreset } from "../../event-preset";
import type { EventExperience } from "../../event-config";
import { PresetPanel, type PresetPanelProps } from "./preset-panel";

const currentExperience: EventExperience = {
  frames: ["beacon", "birthday"],
  locales: ["en", "zh-SG", "ar"],
  defaultLocale: "ar",
  timeZone: "Asia/Singapore",
  capture: {
    reviewEnabled: false,
    autoAcceptSeconds: 8,
    countdownAudioDefault: true,
  },
  gallery: {
    title: "Launch night",
    accentColor: "#ff357f",
  },
};

const preset: EventPreset = {
  version: 1,
  id: "launch-night",
  label: "Launch Night",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  config: currentExperience,
};

const props = (
  overrides: Partial<PresetPanelProps> = {},
): PresetPanelProps => ({
  locale: "en",
  event: "talent-beacon",
  currentExperience,
  presets: [preset],
  selectedPresetId: null,
  presetIdDraft: "",
  presetLabelDraft: "",
  loading: false,
  loadError: "",
  mutationBusy: false,
  saving: false,
  applyingPresetId: null,
  confirmingPresetId: null,
  hasBoothKey: true,
  successMessage: "",
  errorMessage: "",
  onPresetIdChange: () => {},
  onPresetLabelChange: () => {},
  onSelectPreset: () => {},
  onSave: () => {},
  onRequestApply: () => {},
  onConfirmApply: () => {},
  onCancelApply: () => {},
  onReload: () => {},
  ...overrides,
});

test("renders labelled create fields and a complete safe experience summary", () => {
  const html = renderToStaticMarkup(<PresetPanel {...props()} />);

  expect(html).toContain('for="preset-id"');
  expect(html).toContain('id="preset-id"');
  expect(html).toContain('for="preset-label"');
  expect(html).toContain('id="preset-label"');
  expect(html).toContain("Save current setup as preset");
  expect(html).toContain("2 frames");
  expect(html).toContain("English, 简体中文, العربية");
  expect(html).toContain("Default: العربية");
  expect(html).toContain("Review: off");
  expect(html).toContain("Auto-accept: 8s");
  expect(html).toContain("Countdown audio: on");
  expect(html).toContain("Asia/Singapore");
  expect(html).toContain("Launch night");
  expect(html).toContain("#ff357f");
  expect(html).toContain("Create preset");
  expect(html).toContain("Booth credentials are never copied into presets.");
  expect(html).not.toMatch(/>Delete</);
});

test("renders update and explicit apply confirmation with RTL-safe exact IDs", () => {
  const html = renderToStaticMarkup(
    <PresetPanel
      {...props({
        locale: "ar",
        selectedPresetId: preset.id,
        presetIdDraft: preset.id,
        presetLabelDraft: preset.label,
        confirmingPresetId: preset.id,
        hasBoothKey: false,
      })}
    />,
  );

  expect(html).toContain('dir="rtl"');
  expect(html).toContain("تحديث الإعداد المسبق");
  expect(html).toContain("talent-beacon");
  expect(html).toContain("Launch Night");
  expect(html).toContain("<bdi><code>launch-night</code></bdi>");
  expect(html).toContain("لا يحتوي الحدث المستهدف على مفتاح كشك");
  expect(html).toContain("تطبيق الإعداد المسبق");
  expect(html).toContain("إلغاء");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('role="alert"');
  expect(html).not.toMatch(/>Delete</);
});

test("shares the mutation guard with Save, Restore, and Apply", () => {
  const html = renderToStaticMarkup(
    <PresetPanel
      {...props({
        selectedPresetId: preset.id,
        presetIdDraft: preset.id,
        presetLabelDraft: preset.label,
        confirmingPresetId: preset.id,
        mutationBusy: true,
        saving: true,
        applyingPresetId: preset.id,
      })}
    />,
  );

  const buttons = [...html.matchAll(/<button[^>]*>/g)].map(([button]) => button);
  const inputs = [...html.matchAll(/<(?:input|select)[^>]*>/g)].map(([input]) => input);
  expect(buttons.length).toBeGreaterThanOrEqual(4);
  expect(buttons.every((button) => button.includes("disabled"))).toBe(true);
  expect(inputs.every((input) => input.includes("disabled"))).toBe(true);
  expect(html).toContain("Applying…");
});
