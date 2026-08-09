import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",           // 静态导出，生成纯 HTML/CSS/JS
  images: { unoptimized: true }, // 静态导出必须关闭图片优化
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
