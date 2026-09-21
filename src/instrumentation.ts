import type { Instrumentation } from "next";

/**
 * Monitoreo de errores en producción (Sentry) — opt-in vía SENTRY_DSN.
 * Sin esa variable, `Sentry.init` no envía nada (comportamiento estándar
 * del SDK), así que este archivo es un no-op seguro en desarrollo, en este
 * sandbox (sin egress a sentry.io) y en cualquier build/CI que todavía no
 * tenga la cuenta de Sentry configurada — nunca rompe el arranque.
 *
 * Node y Edge runtime cargan SDKs distintos (`@sentry/nextjs/server` vs
 * `/edge`) — el import dinámico evita empaquetar el que no corresponde.
 * Ver src/instrumentation-client.ts para el lado del navegador.
 */
export async function register() {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
