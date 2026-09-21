import * as Sentry from "@sentry/nextjs";

/** Cargado condicionalmente desde src/instrumentation.ts solo si SENTRY_DSN existe. */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  // Bajo por defecto — suficiente para detectar problemas de latencia sin
  // acercarse a cuotas del plan gratuito de Sentry con tráfico real.
  tracesSampleRate: 0.1,
});
