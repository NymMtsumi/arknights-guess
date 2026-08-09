import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",       // OpenNext Cloudflare Workers 模式
  images: { unoptimized: true },
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
