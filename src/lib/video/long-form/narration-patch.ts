/**
 * Correcciones LOCALIZADAS de un guion ya escrito (recuperación de e8048599, 2026-10-23): sustituye pasajes concretos
 * de la narración sin regenerar el guion (sin llamadas de pago) y mantiene válidas las anclas que dependen del texto:
 * las citas de cada escena (`visuals[].quote`) y las marcas de edición (`creativeDirection`).
 *
 * Reglas (fail-closed, todo o nada):
 *  - cada `find` aparece EXACTAMENTE una vez en la narración de su beat;
 *  - si una cita o marca contiene `find`, se corrige igual; si la corrección la deja sin localizar, se rechaza todo;
 *  - ninguna cita o marca que antes se localizaba puede dejar de localizarse;
 *  - el resultado es una copia; el guion original no se modifica.
 * Aplicar SIEMPRE sobre el guion terminado (antes de confirmar la producción): aplicarlo durante el trabajo del guion
 * cambiaría la huella de las respuestas ya pagadas y obligaría a pagarlas de nuevo.
 */
import { quoteStart } from "./scene-anchoring";
import { locateNormalized } from "./text-locate";

export type NarrationPatch = { beatIndex: number; find: string; replace: string; reason: string };
type Visual = Record<string, unknown> & { quote?: string };
type Mark = { beatIndex: number; quote: string };
export type PatchableScript = { beats: ({ narration: string; visuals?: unknown } & Record<string, unknown>)[]; creativeDirection?: Record<string, unknown> } & Record<string, unknown>;
export type PatchReport = { ok: boolean; errors: string[]; applied: { beatIndex: number; reason: string; wordsBefore: number; wordsAfter: number }[]; quotesUpdated: number; marksUpdated: number; wordDelta: number };

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const located = (narration: string, quote: string | undefined) => !!quote && (quoteStart(narration, quote) !== null || locateNormalized(narration, quote) !== null);
const MARK_KEYS = ["signatureDetail", "shareableLine", "commentMoment", "closingCta"] as const;

function marksOf(cd: Record<string, unknown> | undefined): { get: () => Mark | null; set: (m: Mark) => void }[] {
  if (!cd) return [];
  const out: { get: () => Mark | null; set: (m: Mark) => void }[] = [];
  for (const k of MARK_KEYS) out.push({ get: () => (cd[k] as Mark | null) ?? null, set: (m) => { cd[k] = m; } });
  const protect = Array.isArray(cd.protectInEdit) ? (cd.protectInEdit as Mark[]) : [];
  protect.forEach((_, i) => out.push({ get: () => protect[i] ?? null, set: (m) => { protect[i] = m; } }));
  return out;
}

export function applyNarrationPatches<T extends PatchableScript>(script: T, patches: NarrationPatch[]): { script: T; report: PatchReport } {
  const copy = JSON.parse(JSON.stringify(script)) as T;
  const errors: string[] = [], applied: PatchReport["applied"] = [];
  let quotesUpdated = 0, marksUpdated = 0;
  const beforeQuotes = copy.beats.map((b) => (Array.isArray(b.visuals) ? (b.visuals as Visual[]) : []).map((v) => located(b.narration, v.quote)));
  const beforeMarks = marksOf(copy.creativeDirection).map((m) => { const x = m.get(); return !!x && located(copy.beats[x.beatIndex]?.narration ?? "", x.quote); });
  for (const p of patches) {
    const beat = copy.beats[p.beatIndex];
    if (!beat) { errors.push(`beat ${p.beatIndex}: no existe`); continue; }
    if (!p.find || p.find === p.replace) { errors.push(`beat ${p.beatIndex}: corrección vacía`); continue; }
    const first = beat.narration.indexOf(p.find);
    if (first < 0) { errors.push(`beat ${p.beatIndex}: el pasaje a corregir no está en la narración («${p.find.slice(0, 60)}»)`); continue; }
    if (beat.narration.indexOf(p.find, first + 1) >= 0) { errors.push(`beat ${p.beatIndex}: el pasaje aparece más de una vez (ambiguo)`); continue; }
    const wordsBefore = words(beat.narration);
    beat.narration = beat.narration.slice(0, first) + p.replace + beat.narration.slice(first + p.find.length);
    for (const v of Array.isArray(beat.visuals) ? (beat.visuals as Visual[]) : []) if (v.quote && v.quote.includes(p.find)) { v.quote = v.quote.replace(p.find, p.replace); quotesUpdated++; }
    for (const m of marksOf(copy.creativeDirection)) { const x = m.get(); if (x && x.beatIndex === p.beatIndex && x.quote.includes(p.find)) { m.set({ ...x, quote: x.quote.replace(p.find, p.replace) }); marksUpdated++; } }
    applied.push({ beatIndex: p.beatIndex, reason: p.reason, wordsBefore, wordsAfter: words(beat.narration) });
  }
  // Ninguna ancla que se localizaba antes puede perderse.
  copy.beats.forEach((b, bi) => (Array.isArray(b.visuals) ? (b.visuals as Visual[]) : []).forEach((v, vi) => {
    if (beforeQuotes[bi]?.[vi] && !located(b.narration, v.quote)) errors.push(`beat ${bi} escena ${vi}: su cita dejó de localizarse en la narración`);
  }));
  marksOf(copy.creativeDirection).forEach((m, i) => { const x = m.get(); if (beforeMarks[i] && x && !located(copy.beats[x.beatIndex]?.narration ?? "", x.quote)) errors.push(`marca de edición ${i}: dejó de localizarse`); });
  const wordDelta = copy.beats.reduce((n, b) => n + words(b.narration), 0) - script.beats.reduce((n, b) => n + words(b.narration), 0);
  const report: PatchReport = { ok: errors.length === 0, errors, applied, quotesUpdated, marksUpdated, wordDelta };
  return { script: report.ok ? copy : script, report };
}
