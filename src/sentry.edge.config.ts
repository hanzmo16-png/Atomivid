import * as Sentry from "@sentry/nextjs";

/** Cargado condicionalmente desde src/instrumentation.ts solo si SENTRY_DSN existe — cubre src/proxy.ts (edge runtime). */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
