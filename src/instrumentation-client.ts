import * as Sentry from "@sentry/nextjs";

/**
 * Monitoreo de errores del navegador — opt-in vía NEXT_PUBLIC_SENTRY_DSN
 * (con prefijo NEXT_PUBLIC_ porque, a diferencia de SENTRY_DSN en
 * src/sentry.server.config.ts, este código corre en el navegador). Sin
 * esa variable, `Sentry.init` no envía nada — no-op seguro en desarrollo.
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}
