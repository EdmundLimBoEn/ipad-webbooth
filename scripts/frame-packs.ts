#!/usr/bin/env bun
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AssetInfo, FramePackManifest } from "../app/frame-packs/types";
import { validateFramePacks } from "../app/frame-packs/validate";

const root = join(import.meta.dir, "..", "public", "templates");
const [command = "validate", key, ...labelParts] = process.argv.slice(2);

if (command === "validate") await validate();
else if (command === "scaffold") await scaffold(key, labelParts.join(" "));
else fail("Usage: bun scripts/frame-packs.ts validate | scaffold <pack-key> [label]");

async function validate() {
  const manifests: FramePackManifest[] = [];
  const assets: Record<string, AssetInfo> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packDir = join(root, entry.name);
    try {
      manifests.push(JSON.parse(await readFile(join(packDir, "manifest.json"), "utf8")));
    } catch (error) {
      fail(`${entry.name}/manifest.json: ${error instanceof Error ? error.message : error}`);
    }
    for (const file of await readdir(packDir)) {
      if (!file.toLowerCase().endsWith(".png")) continue;
      const dimensions = pngDimensions(await readFile(join(packDir, file)));
      assets[`${entry.name}/${file}`] = { path: join(packDir, file), ...dimensions };
    }
  }
  const issues = validateFramePacks(manifests, assets);
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  console.log(`Valid: ${manifests.length} frame packs, ${Object.keys(assets).length} PNG assets`);
}

async function scaffold(packKey?: string, label?: string) {
  if (!packKey || !/^[a-z][a-zA-Z0-9-]*$/.test(packKey)) {
    fail("Pack key is required and must be URL-safe (example: summer-party)");
  }
  const dir = join(root, packKey);
  await mkdir(dir, { recursive: false });
  const manifest: FramePackManifest = {
    version: 1,
    pack: { key: packKey, label: label || titleCase(packKey) },
    templates: {
      [`${packKey}-frame`]: {
        label: "Frame",
        shots: 1,
        intervalMs: 3000,
        canvas: { w: 1080, h: 1080 },
        background: "#ffffff",
        slots: [{ x: 80, y: 80, w: 920, h: 920 }],
      },
    },
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Created ${basename(dir)}/manifest.json. Add PNG artwork, then run validate.`);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") fail("Invalid PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function titleCase(value: string) {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
