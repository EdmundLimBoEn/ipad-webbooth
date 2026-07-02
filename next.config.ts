import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json in $HOME makes Next infer the home dir as the
  // workspace root, so build-trace collection walks all of ~/. Pin it here.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
