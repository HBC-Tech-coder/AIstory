import type { NextConfig } from "next";

import { WORLD_MODEL_DEMO_REWRITES } from "./lib/world-model-demos/rewrites";

const config: NextConfig = {
  output: process.env.BUILD_STANDALONE === "true" ? "standalone" : undefined,
  images: {
    // The packaged desktop runtime must never mutate its installation tree by
    // creating `.next/cache/images` entries. Steam release assets are already
    // reviewed derivatives, so serve them directly for this explicit build.
    unoptimized: process.env.AISTORY_STEAM_OFFLINE_BUILD === "true",
  },
  serverExternalPackages: ["ali-oss"],
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.3.11", "192.168.110.254"],
  reactStrictMode: true,
  typedRoutes: false,
  // Keep the original request origin for middleware's same-origin locale rewrite.
  // Otherwise NextURL's loopback normalization can cause HTTPS self-proxying.
  skipProxyUrlNormalize: true,
  turbopack: {
    root: process.env.AISTORY_STEAM_TURBOPACK_ROOT || __dirname,
  },
  // /public defaults to `max-age=0, must-revalidate`; pin the stable /home/* covers + first-act JSON for 1y so browsers/CDN stop re-downloading them.
  async headers() {
    return [
      {
        source: "/home/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: WORLD_MODEL_DEMO_REWRITES,
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
