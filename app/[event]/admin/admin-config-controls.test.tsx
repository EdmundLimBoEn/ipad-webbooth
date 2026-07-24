import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUPS, TEMPLATES } from "../../templates";
import {
  BoothKeyControls,
  CaptureExperienceControls,
  FrameProgrammeControls,
  SaveConfigurationButton,
} from "./admin-config-controls";

test("Frame and pack controls are disabled while a configuration mutation is busy", () => {
  const [defaultFrame] = Object.keys(TEMPLATES).filter((key) => !TEMPLATES[key].group);
  const html = renderToStaticMarkup(
    <FrameProgrammeControls
      frames={new Set([defaultFrame])}
      defaults={[defaultFrame]}
      disabled
      onToggle={() => {}}
      onSetGroup={() => {}}
    />
  );
  const controls = html.match(/<(?:button|input)\b/g) ?? [];
  const disabledControls = html.match(/disabled=""/g) ?? [];

  expect(controls.length).toBeGreaterThan(Object.keys(GROUPS).length);
  expect(disabledControls.length).toBe(controls.length);
});

test("Booth-key input, generate, and clear are disabled while copy remains available", () => {
  const html = renderToStaticMarkup(
    <BoothKeyControls
      value="a-secure-booth-key"
      saved
      copied={false}
      disabled
      placeholder="Unchanged"
      onChange={() => {}}
      onGenerate={() => {}}
      onCopy={() => {}}
      onClear={() => {}}
    />
  );

  expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
  expect(html).toContain(">Generate</button>");
  expect(html).toContain(">Copy generated key</button>");
  expect(html).toContain(">Stored safely — clear key</button>");
});

test("Save is disabled while a configuration mutation is busy", () => {
  const html = renderToStaticMarkup(
    <SaveConfigurationButton disabled saving={false} onSave={() => {}} />
  );

  expect(html).toContain("disabled");
  expect(html).toContain(">Save configuration</button>");
});

test("capture experience controls expose supported locales and plain capture settings", () => {
  const html = renderToStaticMarkup(
    <CaptureExperienceControls
      enabledLocales={new Set(["en", "ar"])}
      defaultLocale="ar"
      reviewEnabled
      autoAcceptSeconds={5}
      countdownAudioDefault={false}
      disabled={false}
      onToggleLocale={() => {}}
      onDefaultLocaleChange={() => {}}
      onReviewEnabledChange={() => {}}
      onAutoAcceptSecondsChange={() => {}}
      onCountdownAudioDefaultChange={() => {}}
    />
  );

  expect(html).toContain("Enabled guest languages");
  expect(html).toContain("English");
  expect(html).toContain("简体中文");
  expect(html).toContain("العربية");
  expect(html).toContain('dir="rtl"');
  expect(html).toContain("Default guest language");
  expect(html).toContain("Show photo review");
  expect(html).toContain("Auto-accept after");
  expect(html).toContain("Countdown sounds on by default");
  expect(html).toContain('min="1"');
  expect(html).toContain('max="30"');
});

test("configuration mutation guard disables every locale and capture control", () => {
  const html = renderToStaticMarkup(
    <CaptureExperienceControls
      enabledLocales={new Set(["en"])}
      defaultLocale="en"
      reviewEnabled
      autoAcceptSeconds={5}
      countdownAudioDefault={false}
      disabled
      onToggleLocale={() => {}}
      onDefaultLocaleChange={() => {}}
      onReviewEnabledChange={() => {}}
      onAutoAcceptSecondsChange={() => {}}
      onCountdownAudioDefaultChange={() => {}}
    />
  );

  const controls = html.match(/<(?:input|select)\b/g) ?? [];
  expect(controls).toHaveLength(7);
  expect((html.match(/disabled=""/g) ?? [])).toHaveLength(controls.length);
});
