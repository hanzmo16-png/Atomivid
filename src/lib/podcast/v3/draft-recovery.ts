/**
 * Borradores aparcados del asistente de Podcast («Empezar de nuevo» los guarda, «Recuperar» los devuelve).
 * Usa EXACTAMENTE el formato de la entrada «Personalizado» (#269, wizard.ts: WIZARD_RECOVERY_KEY):
 *   { v: 1, items: [{ raw, at, step }], legacy? }  — el más reciente primero; nada se borra.
 * Así una entrada desde la portada y «Empezar de nuevo» comparten la misma lista, en cualquier orden de despliegue.
 * Semántica IDÉNTICA a parseRecovery/restorePreviousDraft de #269 (auditoría de integración de Grok):
 *  - un valor que no es lista ni { items } (p. ej. un borrador crudo) queda en `legacy`, intacto, como en #269;
 *  - sin tope: la lista nunca se recorta (nada se pierde al aparcar).
 * Cuando #269 se integre, este módulo debe pasar a importar el parser de wizard.ts en vez de duplicarlo.
 * Puro: el almacenamiento se inyecta (localStorage en el navegador, un Map en pruebas).
 */
export const DRAFT_RECOVERY_KEY = "atomivid.podcast.asistente.v2.recuperable";
export type DraftStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export type ParkedDraft = { raw: string; at: string; step: number };
type RecoveryFile = { v: 1; items: ParkedDraft[]; legacy?: string };

const stepOf = (raw: string) => { try { const n = Number(JSON.parse(raw)?.step); return Number.isFinite(n) ? n : 0; } catch { return 0; } };

export function parseRecovery(raw: string | null): { items: ParkedDraft[]; legacy: string | null } {
  if (!raw) return { items: [], legacy: null };
  try {
    const v = JSON.parse(raw) as unknown;
    const norm = (x: unknown): ParkedDraft | null => {
      const o = x as { raw?: unknown; at?: unknown; step?: unknown };
      if (!o || typeof o !== "object" || typeof o.raw !== "string" || !o.raw) return null;
      return { raw: o.raw, at: typeof o.at === "string" ? o.at : "", step: Number.isFinite(Number(o.step)) ? Number(o.step) : stepOf(o.raw) };
    };
    if (Array.isArray(v)) return { items: v.map(norm).filter((x): x is ParkedDraft => !!x), legacy: null };
    if (v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) {
      const o = v as { items: unknown[]; legacy?: unknown };
      return { items: o.items.map(norm).filter((x): x is ParkedDraft => !!x), legacy: typeof o.legacy === "string" ? o.legacy : null };
    }
    return { items: [], legacy: raw };
  } catch { return { items: [], legacy: raw }; }
}

function write(store: DraftStore, items: ParkedDraft[], legacy: string | null) {
  if (!items.length && !legacy) { store.removeItem(DRAFT_RECOVERY_KEY); return; }
  const body: RecoveryFile = { v: 1, items };
  if (legacy) body.legacy = legacy;
  store.setItem(DRAFT_RECOVERY_KEY, JSON.stringify(body));
}

/** ¿Tiene trabajo este borrador guardado (tema, guion o un guion con IA a medias)? Uno vacío no se aparca. */
export function hasWork(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try { const x = JSON.parse(raw) as { topic?: unknown; script?: unknown; scriptJob?: unknown }; return !!(String(x.topic ?? "").trim() || String(x.script ?? "").trim() || x.scriptJob); } catch { return false; }
}

/** Aparca un borrador con trabajo al principio de la lista (sin duplicar el que ya está primero). */
export function parkDraft(store: DraftStore, raw: string | null, now = new Date().toISOString()): boolean {
  if (!hasWork(raw)) return false;
  const p = parseRecovery(store.getItem(DRAFT_RECOVERY_KEY));
  if (p.items[0]?.raw !== raw) p.items.unshift({ raw: raw!, at: now, step: stepOf(raw!) });
  write(store, p.items, p.legacy);
  return true;
}

/** ¿Hay algún borrador aparcado con trabajo? */
export function hasParked(store: DraftStore): boolean {
  return parseRecovery(store.getItem(DRAFT_RECOVERY_KEY)).items.some((x) => hasWork(x.raw));
}

/**
 * Devuelve el borrador aparcado más reciente; el actual (si tenía trabajo) ocupa su lugar en la lista, como
 * restorePreviousDraft de #269. Devuelve el JSON crudo a cargar, o null si no había ninguno.
 */
export function takeParked(store: DraftStore, current: string | null, now = new Date().toISOString()): string | null {
  const p = parseRecovery(store.getItem(DRAFT_RECOVERY_KEY));
  const at = p.items.findIndex((x) => hasWork(x.raw));
  if (at < 0) return null;
  const head = p.items[at];
  const rest = p.items.filter((_, i) => i !== at);
  const next = hasWork(current) && current !== head.raw ? [{ raw: current!, at: now, step: stepOf(current!) }, ...rest] : rest;
  write(store, next, p.legacy);
  return head.raw;
}
