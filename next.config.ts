import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // يسمح ببناء إنتاجية في مجلد منفصل دون تعارض مع خادم التطوير الجاري (.next)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
