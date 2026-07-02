import { timingSafeEqual } from "node:crypto";

// Booth JPEGs are a few hundred KB; Vercel's function body limit (~4.5MB) is the
// real first line of defense, this is an explicit belt-and-suspenders cap.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Constant-time compare so the upload key can't be recovered byte-by-byte via
// response timing. Length mismatch short-circuits (length is not secret here).
export function keyOk(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
  // HEIF/HEIC (iOS): '....ftyp' box
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
  return false;
}
