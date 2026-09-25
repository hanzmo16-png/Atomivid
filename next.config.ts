import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // RC mission Avatar (2026-09-25): el límite anterior de 4mb forzaba el
  // límite artificial "foto+audio <= 3 MB" que rechazaba una grabación
  // real de ~45s (ver recording.ts, MAX_AVATAR_PHOTO_BYTES/
  // MAX_RECORDING_BYTES). createVideoRequest sigue enviando foto+audio
  // en una única Server Action (no se migró a upload directo a Storage,
  // que habría requerido nuevas policies de RLS del lado del cliente,
  // fuera del alcance de este cambio) — 30mb da margen real para el peor
  // caso combinado (8MB foto + 16MB audio) más overhead de multipart,
  // sin acercarse al límite. Si en QA real con dispositivo se topa con un
  // límite de plataforma de Vercel por debajo de este valor, la migración
  // a upload directo a Storage (con policies RLS por usuario) es el
  // siguiente paso correcto — no adivinar un número mayor aquí.
  experimental: { serverActions: { bodySizeLimit: "30mb" } },
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
