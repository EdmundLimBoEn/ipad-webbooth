// Typed shape of getCloudflareContext().env — @opennextjs/cloudflare's
// getCloudflareContext() is generic over a global `CloudflareEnv` interface;
// this is the hand-written equivalent of `wrangler types` output, kept in
// sync with the bindings/vars declared in wrangler.jsonc.
//
// Deliberately a type-only *import* of R2Bucket rather than a triple-slash
// `/// <reference types="@cloudflare/workers-types" />` or tsconfig "types"
// entry — either of those pulls in workers-types' ambient global overrides
// for fetch/Response (narrowing `.json()` to `unknown`), which breaks type
// checking across the whole (non-Workers-only) app.
import type { R2Bucket } from "@cloudflare/workers-types";

// The `import` above makes this a module, not a global script, so the
// CloudflareEnv interface needs an explicit `declare global` to still merge
// into @opennextjs/cloudflare's ambient (empty) CloudflareEnv interface.
declare global {
  interface CloudflareEnv {
    PHOTOS: R2Bucket;
    R2_PUBLIC_BASE: string;
    BOOTH_UPLOAD_KEY?: string;
  }
}
