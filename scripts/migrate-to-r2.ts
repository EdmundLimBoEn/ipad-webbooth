// One-way copy: Vercel Blob -> Cloudflare R2. NEVER deletes or writes to Vercel.
//
// Usage:  bun scripts/migrate-to-r2.ts            (needs `wrangler login` done once)
//
// - Reads BLOB_READ_WRITE_TOKEN from .env.local (bun loads it automatically).
// - Copies every blob (all event photos + _config/*.json) into the R2 bucket
//   under the SAME key, so the ported /api/photos route sees identical paths.
// - Idempotent: keys already copied are recorded in scripts/.migrated.json and
//   skipped on re-run. Run it again right before cutover to tail-copy any
//   photos taken since the first pass.
import { list } from "@vercel/blob";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUCKET = "photobooth";
const MANIFEST = new URL(".migrated.json", import.meta.url).pathname;

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN not set — run from the repo root so bun picks up .env.local");
  process.exit(1);
}

const done = new Set<string>(existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : []);
const tmp = mkdtempSync(join(tmpdir(), "blob-to-r2-"));

// Page through the ENTIRE store (no prefix): photos and _config alike.
const blobs = [];
let cursor: string | undefined;
do {
  const page = await list({ cursor });
  blobs.push(...page.blobs);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

console.log(`Vercel store: ${blobs.length} blobs; already migrated: ${done.size}`);

let copied = 0;
let failed = 0;
for (const b of blobs) {
  if (done.has(b.pathname)) continue;

  const res = await fetch(b.url);
  if (!res.ok) {
    console.error(`FETCH FAIL ${b.pathname}: ${res.status}`);
    failed++;
    continue;
  }
  const data = new Uint8Array(await res.arrayBuffer());
  const file = join(tmp, "obj");
  writeFileSync(file, data);

  const contentType = b.pathname.endsWith(".json") ? "application/json" : "image/jpeg";
  const put = spawnSync(
    "bunx",
    ["wrangler", "r2", "object", "put", `${BUCKET}/${b.pathname}`, "--file", file, "--content-type", contentType, "--remote"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  if (put.status !== 0) {
    console.error(`PUT FAIL ${b.pathname}:\n${put.stderr}`);
    failed++;
    continue;
  }

  done.add(b.pathname);
  writeFileSync(MANIFEST, JSON.stringify([...done], null, 2)); // checkpoint after every object
  copied++;
  console.log(`${copied}. ${b.pathname} (${(data.length / 1024).toFixed(0)} KB)`);
}

console.log(`\nDone: ${copied} copied, ${done.size}/${blobs.length} total in R2, ${failed} failed.`);
if (failed > 0) process.exit(1);
