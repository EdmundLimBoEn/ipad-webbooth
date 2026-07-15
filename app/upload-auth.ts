import { timingSafeEqual } from "node:crypto";
import { slugifyEvent } from "./event-identity";

// Booth JPEGs are a few hundred KB; this is an explicit belt-and-suspenders cap.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Constant-time compare so a key can't be recovered byte-by-byte via response
// timing. Length mismatch short-circuits (length is not secret here).
export function keyOk(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Admin gate shared by upload/config/export. BOOTH_UPLOAD_KEY (a Worker
// secret) is the admin key. Fail closed by default: an unset key only means
// "open" when ALLOW_KEYLESS=1 is explicitly set (local dev convenience in
// .env.local) — never in a deployed worker, and never just because
// NODE_ENV happened to not be "production".
export function adminOk(provided: string, adminKey: string | undefined): "ok" | "unauthorized" | "disabled" {
  if (!adminKey) return process.env.ALLOW_KEYLESS === "1" ? "ok" : "disabled";
  return keyOk(provided, adminKey) ? "ok" : "unauthorized";
}

// Per-event booth keys are stored hashed, never plaintext, in private STATE.
// Salt + stretch them as defense in depth against a backup/config exposure;
// a human-chosen key's bare SHA-256 would be offline-brute-forceable.
// ponytail: 20k iterations ≈ 5ms — sized to the Workers free tier's 10ms CPU
// cap per request; raise it if the plan ever changes. Real safety comes from
// using the admin page's Generate button (96-bit random keys).
const PBKDF2_ITERS = 20_000;
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function pbkdf2(key: string, salt: Uint8Array): Promise<string> {
  const mat = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERS },
    mat,
    256
  );
  return toHex(new Uint8Array(bits));
}

// -> "salthex:hashhex", the format stored in the config object
export async function hashBoothKey(key: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${toHex(salt)}:${await pbkdf2(key, salt)}`;
}

export async function boothKeyMatches(key: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  return keyOk(await pbkdf2(key, fromHex(saltHex)), hashHex);
}

// Slugs an event name to a safe key prefix; anything else -> "event".
// Shared by every API route (was four hand-synced copies).
export const safeEvent = slugifyEvent;

// Allowlist the sink to real image signatures so it can't be used to stash
// arbitrary files. Needs the first ~12 bytes. Covers what a phone camera or the
// canvas compositor can produce (JPEG/PNG/GIF/WebP/HEIF); not a security
// boundary on its own (blobs are force-served as image/jpeg), just abuse hygiene.
export function isImage(b: Uint8Array): boolean {
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // GIF: 47 49 46
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  // WebP: 'RIFF' .... 'WEBP'
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return true;
  // HEIF/HEIC/AVIF: '....ftyp' + an image brand. A bare 'ftyp' check would
  // also match every MP4/MOV video container (ftypisom, ftypqt, ...).
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis"].includes(brand);
  }
  return false;
}
