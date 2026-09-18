import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  // Remotion (y su webpack/esbuild internos) usan requires dinámicos por
  // plataforma que el bundler de Next no puede resolver estáticamente.
  serverExternalPackages: ["@remotion/renderer", "@remotion/bundler", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"],
  outputFileTracingIncludes: { "/dashboard/avatar/prepare": ["./node_modules/@ffmpeg-installer/linux-x64/**", "./node_modules/@ffprobe-installer/linux-x64/**"] },
};

export default nextConfig;
