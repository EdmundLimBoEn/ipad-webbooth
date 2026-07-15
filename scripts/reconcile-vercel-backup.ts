#!/usr/bin/env bun
// Additive backup reconciliation: Vercel Blob -> Cloudflare R2.
// It checks the destination first, copies only missing objects, and never
// deletes or overwrites an object in either store.
import { list } from "@vercel/blob";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const wranglerEnv = envIndex >= 0 ? args[envIndex + 1] : undefined;
if (envIndex >= 0 && !wranglerEnv) fail("--env requires a Wrangler environment name");
const bucketIndex = args.indexOf("--bucket");
const explicitBucket = bucketIndex >= 0 ? args[bucketIndex + 1] : undefined;
if (bucketIndex >= 0 && !explicitBucket) fail("--bucket requires an R2 bucket name");

const bucketsByEnvironment: Record<string, string> = {
  production: "photobooth",
  staging: "photobooth-staging",
};
const bucket = explicitBucket ?? process.env.R2_BACKUP_BUCKET ?? (wranglerEnv ? bucketsByEnvironment[wranglerEnv] : "photobooth");
if (!bucket) fail(`No safe bucket mapping for --env ${wranglerEnv}; pass --bucket explicitly`);
const tmp = mkdtempSync(join(tmpdir(), "vercel-r2-reconcile-"));
const envArgs = wranglerEnv ? ["--env", wranglerEnv] : [];

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  fail("BLOB_READ_WRITE_TOKEN is not set (keep it in .env.local)");
}

const blobs = [];
let cursor: string | undefined;
do {
  const page = await list({ cursor });
  blobs.push(...page.blobs);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

console.log(`Reconciling ${blobs.length} Vercel objects into R2 bucket ${bucket}${wranglerEnv ? ` (${wranglerEnv})` : ""}`);

let copied = 0;
let present = 0;
let failed = 0;
for (const [index, blob] of blobs.entries()) {
  const object = `${bucket}/${blob.pathname}`;
  const probeFile = join(tmp, `probe-${index}`);
  const get = wrangler(["r2", "object", "get", object, "--file", probeFile, "--remote", ...envArgs]);
  if (get.status === 0) {
    present++;
    continue;
  }
  const diagnostic = `${get.stdout.toString()}\n${get.stderr.toString()}`;
  if (!/(?:404|not found|NoSuchKey|does not exist)/i.test(diagnostic)) {
    console.error(`CHECK FAIL ${blob.pathname}; refusing to write because absence was not confirmed:\n${diagnostic}`);
    failed++;
    continue;
  }

  const response = await fetch(blob.url);
  if (!response.ok) {
    console.error(`FETCH FAIL ${blob.pathname}: ${response.status}`);
    failed++;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sourceFile = join(tmp, `source-${index}`);
  writeFileSync(sourceFile, bytes);
  const contentType = blob.pathname.endsWith(".json") ? "application/json" : "image/jpeg";
  const put = wrangler(["r2", "object", "put", object, "--file", sourceFile, "--content-type", contentType, "--remote", ...envArgs]);
  if (put.status !== 0) {
    console.error(`PUT FAIL ${blob.pathname}:\n${put.stderr.toString()}`);
    failed++;
    continue;
  }
  copied++;
  console.log(`${copied}. copied ${blob.pathname} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

console.log(`Done: ${copied} copied, ${present} already present, ${failed} failed. Nothing deleted or overwritten.`);
if (failed) process.exit(1);

function wrangler(wranglerArgs: string[]) {
  return spawnSync("bunx", ["wrangler", ...wranglerArgs], { stdio: ["ignore", "pipe", "pipe"] });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
