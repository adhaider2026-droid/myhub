import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone للتنفيذ الذاتي محليًا فقط (npm run build:standalone)؛
  // على Netlify تترك القيمة الافتراضية — إضافة Next الرسمية تتكفل بالتغليف
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // يسمح ببناء إنتاجية في مجلد منفصل دون تعارض مع خادم التطوير الجاري (.next)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
