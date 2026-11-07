/**
 * «Cambiar duración» desde la configuración (incidente Anunnaki, 2026-11-07: se pidieron 30 min y el guion guardado era
 * de 7 sin que el cliente lo notara hasta el costo). Lógica pura, sin red: arma el enlace al formulario con los mismos
 * datos y la duración VACÍA, para que se escriba de nuevo a propósito. No borra ni modifica el guion actual. Como la
 * duración forma parte de la huella de la solicitud, el envío crea una preparación distinta; reenviar los mismos datos
 * vuelve a la misma preparación (sin un segundo cobro).
 */
export type ChangeDurationFields = { topic?: unknown; language?: unknown; sources?: unknown; openQuestions?: unknown };

/** Por encima de esto las referencias no viajan en la URL (límites de cabecera de proxies); se pide volver a pegarlas. */
export const MAX_PREFILL_URL = 6000;

export function changeDurationHref(fields: ChangeDurationFields | null | undefined, fallbackTopic: string): { href: string; sourcesDropped: boolean } {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const topic = (str(fields?.topic) || fallbackTopic).slice(0, 200);
  const language = str(fields?.language) === "en" ? "en" : "es";
  const base: Record<string, string> = { topic, language };
  const questions = str(fields?.openQuestions);
  if (questions) base.open_questions = questions;
  const sources = str(fields?.sources);
  const withSources = new URLSearchParams(sources ? { ...base, sources } : base);
  const href = `/dashboard/long-form/new?${withSources}`;
  if (href.length <= MAX_PREFILL_URL) return { href, sourcesDropped: false };
  return { href: `/dashboard/long-form/new?${new URLSearchParams(base)}`.slice(0, MAX_PREFILL_URL), sourcesDropped: Boolean(sources) };
}

/** m:ss o h:mm:ss, como el resto de la configuración. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
