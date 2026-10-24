/**
 * Encabezados de seguridad de toda la web (next.config.ts → headers()).
 *
 * Auditoría de aceptación (docs/qa-aceptacion, PR #202): producción solo enviaba HSTS; faltaban CSP, protección contra
 * iframes (clickjacking en /login), nosniff y Referrer-Policy.
 *
 * Diseño para no romper el producto:
 *  - CSP APLICADA solo con directivas que no dependen de orígenes de terceros ni de scripts en línea:
 *    frame-ancestors 'none' (nadie puede incrustar Atomivid en un iframe), object-src 'none', base-uri 'self'.
 *    No restringe scripts, estilos, imágenes, medios ni conexiones: Next inyecta scripts en línea, Supabase (auth,
 *    storage, subidas firmadas, realtime), Sentry, Stripe y los enlaces firmados de medios siguen funcionando igual.
 *  - CSP COMPLETA en modo informe (Content-Security-Policy-Report-Only): el navegador la evalúa y solo avisa en consola,
 *    nunca bloquea. Sirve para medir violaciones reales antes de endurecer la política aplicada.
 *    Sin report-uri: no se envía nada a ningún servicio.
 *  - X-Frame-Options DENY (navegadores sin frame-ancestors), X-Content-Type-Options nosniff,
 *    Referrer-Policy strict-origin-when-cross-origin (el valor por defecto de los navegadores modernos, ahora explícito).
 */
export type SecurityHeader = { key: string; value: string };

function origin(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/** Orígenes externos que el navegador contacta (fetch/WebSocket). Se derivan de la configuración, nunca se inventan. */
export function connectOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  const supabase = origin(env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabase) { out.add(supabase); out.add(supabase.replace(/^http/, "ws")); }
  const sentry = origin(env.NEXT_PUBLIC_SENTRY_DSN);
  if (sentry) out.add(sentry);
  out.add("https://*.ingest.sentry.io").add("https://*.ingest.us.sentry.io");
  out.add("https://vercel.live").add("wss://ws-us3.pusher.com"); // barra de comentarios de Vercel en Previews
  return [...out];
}

export const ENFORCED_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

export function reportOnlyCsp(env: Record<string, string | undefined> = process.env): string {
  const dev = env.NODE_ENV === "development";
  // Medios e imágenes firmados de Storage salen del origen de Supabase (https en producción; http en el arnés local).
  const storage = origin(env.NEXT_PUBLIC_SUPABASE_URL);
  const media = storage ? ` ${storage}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} https://vercel.live https://va.vercel-scripts.com https://js.stripe.com`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https:${media}`,
    `media-src 'self' blob: https:${media}`,
    "font-src 'self' data:",
    `connect-src 'self' ${connectOrigins(env).join(" ")}`,
    "frame-src 'self' https://vercel.live https://js.stripe.com https://checkout.stripe.com",
    "worker-src 'self' blob:",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://accounts.google.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export function securityHeaders(env: Record<string, string | undefined> = process.env): SecurityHeader[] {
  return [
    { key: "Content-Security-Policy", value: ENFORCED_CSP },
    { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp(env) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
}
