import defaultPackJson from "../../public/templates/default/manifest.json";
import talentBeaconJson from "../../public/templates/talent-beacon-9-anniversary/manifest.json";
import type { FrameDefinition, FramePackManifest, Template } from "./types";

export const FRAME_PACKS = [defaultPackJson, talentBeaconJson] as FramePackManifest[];

export const GROUPS: Record<string, string> = Object.fromEntries(
  FRAME_PACKS.filter((manifest) => manifest.pack.key !== "default").map((manifest) => [
    manifest.pack.key,
    manifest.pack.label,
  ]),
);

export const TEMPLATES: Record<string, Template> = Object.fromEntries(
  FRAME_PACKS.flatMap((manifest) =>
    Object.entries(manifest.templates).map(([key, frame]) => [
      key,
      toRuntimeTemplate(manifest.pack.key, frame),
    ]),
  ),
);

export function assetUrl(packKey: string, asset: string): string {
  return `/templates/${packKey}/${asset}`;
}

function toRuntimeTemplate(packKey: string, frame: FrameDefinition): Template {
  const { preview: _preview, bgImage, overlay, ...rest } = frame;
  return {
    ...rest,
    ...(packKey === "default" ? {} : { group: packKey }),
    ...(bgImage ? { bgImage: assetUrl(packKey, bgImage) } : {}),
    ...(overlay ? { overlay: assetUrl(packKey, overlay) } : {}),
  };
}
