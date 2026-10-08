/**
 * Cinematic V6 en producción: la intención por SECUENCIA sale del guion aprobado
 * (no de los recursos). Cada beat es una unidad narrativa con su propósito; cada
 * escena declarada por el guionista conserva su contrato v4 (clase, identidad,
 * prueba) y su IMPACTO, que propone el guionista (nunca se deduce de la clase).
 *
 * El rol se deriva de la función de la escena (qué afirma), la escala sigue al rol
 * (la cámara la decide el rol), y la revelación del titular (DETAIL) se propone
 * solo para una prueba de impacto 3: si el registro no tiene la región curada, el
 * resolver la descarta y no se fabrica ningún recorte.
 *
 * Si el guion no declara impacto en TODAS sus escenas, devuelve null: ese guion no
 * es v6 y sigue en el plan por defecto.
 */
import { narrationWords } from "./scene-anchoring";
import { IMPACT_LEVELS, type ImpactLevel, type RoleSlot, type SequenceIntent, type SequenceRole } from "./sequence-intent";

type ScriptVisual = Record<string, unknown> & { beatClass?: string; quote?: string; impact?: unknown; impactReason?: unknown };
type ScriptBeat = { id: string; type?: string; purpose?: string; narration: string; visuals?: unknown };

const ROLE_BY_CLASS: Record<string, SequenceRole> = { IDENTITY: "ANCHOR", PLACE: "CONTEXT", EVIDENCE: "EVIDENCE", PROCESS: "CONTEXT", TRANSITION: "TRANSITION", METAPHOR: "ATMOSPHERE" };
const SCALE_REASON: Record<SequenceRole, string> = {
  ANCHOR: "introduce or hold the person or record at the centre of the sequence",
  CONTEXT: "establish place, era or institution",
  EVIDENCE: "show the whole record so it reads as a real document",
  DETAIL: "the curated region carries the claim",
  GEOGRAPHY: "draw only the curated mark",
  TRANSITION: "connect narrative states with type",
  ATMOSPHERE: "texture that proves nothing",
};

const sentence = (text: string) => (text.split(/(?<=[.!?…])\s+/)[0] ?? text).trim().slice(0, 200);

export function sequencesFromScript(beats: ScriptBeat[]): SequenceIntent[] | null {
  const sequences: SequenceIntent[] = [];
  for (const beat of beats) {
    const visuals = Array.isArray(beat.visuals) ? (beat.visuals as ScriptVisual[]) : [];
    if (visuals.length === 0) return null;
    const slots: RoleSlot[] = [];
    for (const v of visuals) {
      const role = ROLE_BY_CLASS[String(v.beatClass)];
      const impact = v.impact as ImpactLevel;
      if (!role || !(IMPACT_LEVELS as readonly number[]).includes(impact) || typeof v.impactReason !== "string" || !v.impactReason.trim()) return null;
      const { impact: _i, impactReason: _r, ...declared } = v;
      void _i;
      void _r;
      const quoteWords = narrationWords(String(v.quote ?? ""));
      if (role === "EVIDENCE" && impact === 3 && quoteWords.length >= 8) {
        // Prueba de impacto 3: la página se sostiene (respiro) y, a mitad del pasaje citado, se revela su titular curado.
        const half = Math.floor(quoteWords.length / 2);
        const at = slots.length;
        slots.push({ role, scale: "WIDE", scaleReason: SCALE_REASON.EVIDENCE, beatId: beat.id, visual: { ...declared, quote: quoteWords.slice(0, half).join(" ") }, impact: 1, impactReason: "breath before the reveal" });
        slots.push({ role: "DETAIL", scale: "DETAIL", scaleReason: SCALE_REASON.DETAIL, beatId: beat.id, visual: { ...declared, quote: quoteWords.slice(half).join(" ") }, detail: { of: at, region: "headline" }, impact: 3, impactReason: v.impactReason });
        continue;
      }
      slots.push({ role, scale: role === "ANCHOR" ? "MEDIUM" : "WIDE", scaleReason: SCALE_REASON[role], beatId: beat.id, visual: declared, impact, impactReason: v.impactReason });
    }
    sequences.push({ id: `seq-${beat.id}`, purpose: (beat.purpose || beat.type || "sequence").slice(0, 200), viewerTakeaway: sentence(beat.narration), beatIds: [beat.id], slots });
  }
  return sequences;
}
