import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  // Remotion (y su webpack/esbuild internos) usan requires dinámicos por
  // plataforma que el bundler de Next no puede resolver estáticamente.
  serverExternalPackages: ["@remotion/renderer", "@remotion/bundler", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe"],
  outputFileTracingIncludes: { "/dashboard/avatar/prepare": ["./node_modules/@ffmpeg-installer/linux-x64/**", "./node_modules/@ffprobe-installer/linux-x64/**"] },
};

// withSentryConfig es seguro de aplicar siempre, incluso sin cuenta de
// Sentry configurada (este sandbox de desarrollo, o cualquier build/CI sin
// SENTRY_AUTH_TOKEN todavía): sin ese token, la subida de sourcemaps se
// desactiva explícitamente abajo en vez de fallar el build, y `telemetry:
// false` evita que el propio plugin de Sentry intente llamar a sentry.io
// durante cada build (sin egress a ese dominio en este sandbox).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
