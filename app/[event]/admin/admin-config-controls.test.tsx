import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GROUPS, TEMPLATES } from "../../templates";
import {
  BoothKeyControls,
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
