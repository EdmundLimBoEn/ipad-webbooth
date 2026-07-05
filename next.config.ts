import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // A stray package-lock.json in $HOME makes Next infer the home dir as the
  // workspace root, so build-trace collection walks all of ~/. Pin it here.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;

// Gives `next dev` local R2/etc bindings (via miniflare) sourced from
// wrangler.jsonc, so getCloudflareContext() works outside of a real Worker.
initOpenNextCloudflareForDev();
