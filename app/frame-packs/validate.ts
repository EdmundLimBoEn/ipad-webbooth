import type { AssetInfo, FramePackManifest, ValidationIssue } from "./types";
import { isSupportedLocale } from "../i18n/catalog";

const KEY = /^[a-z][a-zA-Z0-9-]*$/;
const IMAGE_FIELDS = ["bgImage", "overlay", "preview"] as const;

export function validateFramePacks(
  manifests: FramePackManifest[],
  assets: Record<string, AssetInfo> = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const packKeys = new Set<string>();
  const templateKeys = new Set<string>();

  for (const manifest of manifests) {
    const root = manifest?.pack?.key || "<unknown>";
    if (manifest.version !== 1) issues.push({ path: root, message: "version must be 1" });
    if (!KEY.test(root)) issues.push({ path: root, message: "pack key must be URL-safe camelCase/kebab-case" });
    if (packKeys.has(root)) issues.push({ path: root, message: "pack key is duplicated" });
    packKeys.add(root);
    if (!manifest.pack?.label?.trim()) issues.push({ path: root, message: "pack label is required" });

    for (const [key, frame] of Object.entries(manifest.templates || {})) {
      const path = `${root}.templates.${key}`;
      if (!KEY.test(key)) issues.push({ path, message: "template key must be URL-safe camelCase/kebab-case" });
      if (templateKeys.has(key)) issues.push({ path, message: "template key is duplicated across packs" });
      templateKeys.add(key);
      if (!frame.label?.trim()) issues.push({ path: `${path}.label`, message: "label is required" });
      else if (frame.label.length > 80) {
        issues.push({ path: `${path}.label`, message: "label must be at most 80 characters" });
      }
      if (frame.labels !== undefined) {
        if (!frame.labels || typeof frame.labels !== "object" || Array.isArray(frame.labels)) {
          issues.push({ path: `${path}.labels`, message: "localized labels must be an object" });
        } else {
          for (const [locale, label] of Object.entries(frame.labels)) {
            const labelPath = `${path}.labels.${locale}`;
            if (!isSupportedLocale(locale)) {
              issues.push({ path: labelPath, message: "localized label locale is unsupported" });
            }
            if (typeof label !== "string" || !label.trim()) {
              issues.push({ path: labelPath, message: "localized label is required" });
            } else if (label.length > 80) {
              issues.push({ path: labelPath, message: "localized label must be at most 80 characters" });
            }
          }
        }
      }
      if (!positive(frame.canvas?.w) || !positive(frame.canvas?.h)) {
        issues.push({ path: `${path}.canvas`, message: "canvas dimensions must be positive integers" });
      }
      if (!positive(frame.intervalMs)) issues.push({ path: `${path}.intervalMs`, message: "intervalMs must be a positive integer" });
      if (!Array.isArray(frame.slots) || frame.slots.length === 0) {
        issues.push({ path: `${path}.slots`, message: "at least one slot is required" });
      }
      if (frame.shots !== frame.slots?.length) {
        issues.push({ path: `${path}.shots`, message: "shots must equal slots.length" });
      }
      frame.slots?.forEach((slot, index) => {
        const slotPath = `${path}.slots.${index}`;
        if (![slot.x, slot.y].every(nonNegative) || ![slot.w, slot.h].every(positive)) {
          issues.push({ path: slotPath, message: "slot coordinates must be non-negative and dimensions positive integers" });
        } else if (slot.x + slot.w > frame.canvas.w || slot.y + slot.h > frame.canvas.h) {
          issues.push({ path: slotPath, message: "slot must stay within the canvas" });
        }
        if (slot.fit && slot.fit !== "cover" && slot.fit !== "contain") {
          issues.push({ path: `${slotPath}.fit`, message: "fit must be cover or contain" });
        }
      });
      if (frame.fit && frame.fit !== "cover" && frame.fit !== "contain") {
        issues.push({ path: `${path}.fit`, message: "fit must be cover or contain" });
      }
      if (!frame.background && !frame.bgImage && !frame.overlay) {
        issues.push({ path, message: "provide a background, bgImage, or overlay" });
      }
      if (frame.bgImage && frame.overlay && frame.bgImage === frame.overlay) {
        issues.push({ path, message: "bgImage and overlay must not reference the same asset" });
      }
      if (frame.background && !validColor(frame.background)) {
        issues.push({ path: `${path}.background`, message: "background must be a CSS hex color" });
      }

      const preview = frame.preview || frame.overlay || frame.bgImage || frame.background;
      if (!preview) issues.push({ path, message: "frame has no usable preview source" });

      for (const field of IMAGE_FIELDS) {
        const assetName = frame[field];
        if (!assetName) continue;
        if (assetName.startsWith("/") || assetName.includes("..")) {
          issues.push({ path: `${path}.${field}`, message: "asset paths must be filenames relative to their frame pack" });
          continue;
        }
        const asset = assets[`${root}/${assetName}`];
        if (!asset) {
          issues.push({ path: `${path}.${field}`, message: `asset does not exist: ${assetName}` });
        } else if (asset.width !== frame.canvas.w || asset.height !== frame.canvas.h) {
          issues.push({
            path: `${path}.${field}`,
            message: `PNG is ${asset.width}x${asset.height}; expected ${frame.canvas.w}x${frame.canvas.h}`,
          });
        }
      }
    }
  }
  return issues;
}

function positive(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function validColor(value: string): boolean {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(value);
}
