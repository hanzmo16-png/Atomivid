/**
 * Borradores aparcados del asistente de Podcast («Empezar de nuevo» los guarda, «Recuperar» los devuelve).
 * Usa EXACTAMENTE el formato de la entrada «Personalizado» (#269, wizard.ts: WIZARD_RECOVERY_KEY):
 *   { v: 1, items: [{ raw, at, step }], legacy? }  — el más reciente primero; nada se borra.
 * Así una entrada desde la portada y «Empezar de nuevo» comparten la misma lista, en cualquier orden de despliegue.
 * Mismo sobre que parseRecovery/restorePreviousDraft de #269, más (CORRECCION-2 de Grok):
 *  - un borrador CRUDO del asistente en la clave (lo que escribía 16ab4473) se promueve a items[0] y se recupera con su
 *    scriptJob intacto; la siguiente escritura ya es el sobre { v: 1, items } que el parser de #269 lista;
 *  - lo que no es un borrador (ilegible u otra cosa) queda en `legacy`, intacto, como en #269;
 *  - sin tope: la lista nunca se recorta.
 * Debe ser el ÚNICO parser de esta clave: al integrar #269, wizard.ts tiene que importar parseRecovery de aquí.
 * Puro: el almacenamiento se inyecta (localStorage en el navegador, un Map en pruebas).
 */
export const DRAFT_RECOVERY_KEY = "atomivid.podcast.asistente.v2.recuperable";
export type DraftStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export type ParkedDraft = { raw: string; at: string; step: number };
type RecoveryFile = { v: 1; items: ParkedDraft[]; legacy?: string };

const stepOf = (raw: string) => { try { const n = Number(JSON.parse(raw)?.step); return Number.isFinite(n) ? n : 0; } catch { return 0; } };
const isDraftJson = (raw: string) => { try { return looksLikeDraft(JSON.parse(raw)); } catch { return false; } };
/** ¿Es un borrador del asistente (y no el sobre)? Tiene tema, guion, trabajo de guion o participantes. */
const looksLikeDraft = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && !("items" in (v as object))
  && ["topic", "script", "scriptJob", "participants"].some((k) => k in (v as object));

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
      const items = o.items.map(norm).filter((x): x is ParkedDraft => !!x);
      const legacy = typeof o.legacy === "string" ? o.legacy : null;
      // Un borrador crudo que el parser de #269 (sin este módulo) dejó en `legacy` también se recupera: al final de la lista.
      if (legacy && isDraftJson(legacy)) return { items: [...items, { raw: legacy, at: "", step: stepOf(legacy) }], legacy: null };
      return { items, legacy };
    }
    // Borrador crudo (formato de 16ab4473): se promueve a elemento recuperable, sin tocar su contenido.
    if (looksLikeDraft(v)) return { items: [{ raw, at: "", step: stepOf(raw) }], legacy: null };
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

/** Dueño (id de la cuenta) con el que se guardó un borrador, o null si es anterior al aislamiento por cuenta. */
export function draftOwner(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try { const o = (JSON.parse(raw) as { ownerId?: unknown })?.ownerId; return typeof o === "string" && o ? o : null; } catch { return null; }
}
/** Un borrador aparcado es visible para `owner` si es suyo o no tiene dueño (anterior al aislamiento); sin `owner`, todos. */
const visibleTo = (raw: string, owner?: string | null) => { const o = draftOwner(raw); return !owner || !o || o === owner; };

/**
 * Aparca un borrador con trabajo al principio de la lista. Si ya estaba aparcado (el mismo JSON), se mueve al principio
 * en vez de duplicarse. Nada más se toca: ni los de otras cuentas ni el legado.
 */
export function parkDraft(store: DraftStore, raw: string | null, now = new Date().toISOString()): boolean {
  if (!hasWork(raw)) return false;
  const p = parseRecovery(store.getItem(DRAFT_RECOVERY_KEY));
  if (p.items[0]?.raw !== raw) p.items = [{ raw: raw!, at: now, step: stepOf(raw!) }, ...p.items.filter((x) => x.raw !== raw)];
  write(store, p.items, p.legacy);
  return true;
}

/** ¿Hay algún borrador aparcado con trabajo visible para esta cuenta? */
export function hasParked(store: DraftStore, owner?: string | null): boolean {
  return parseRecovery(store.getItem(DRAFT_RECOVERY_KEY)).items.some((x) => hasWork(x.raw) && visibleTo(x.raw, owner));
}

/**
 * Devuelve el borrador aparcado más reciente de esta cuenta; el actual (si tenía trabajo) ocupa su lugar en la lista,
 * como restorePreviousDraft de #269, sin duplicados. Devuelve el JSON crudo a cargar, o null si no había ninguno.
 * Los borradores de OTRA cuenta (mismo navegador) no se devuelven ni se tocan.
 */
export function takeParked(store: DraftStore, current: string | null, now = new Date().toISOString(), owner?: string | null): string | null {
  const p = parseRecovery(store.getItem(DRAFT_RECOVERY_KEY));
  const at = p.items.findIndex((x) => hasWork(x.raw) && visibleTo(x.raw, owner));
  if (at < 0) return null;
  const head = p.items[at];
  const rest = p.items.filter((_, i) => i !== at);
  const next = hasWork(current) && current !== head.raw ? [{ raw: current!, at: now, step: stepOf(current!) }, ...rest.filter((x) => x.raw !== current)] : rest;
  write(store, next, p.legacy);
  return head.raw;
}
