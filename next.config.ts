import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  // Remotion (y su webpack/esbuild internos) usan requires dinámicos por
  // plataforma que el bundler de Next no puede resolver estáticamente.
  serverExternalPackages: ["@remotion/renderer", "@remotion/bundler"],
};

export default nextConfig;
