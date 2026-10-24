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
import { intentWordSpans, narrationWords, quoteStart } from "./scene-anchoring";
import { LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";
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

/**
 * Densidad de planos (recuperación cinematográfica, 2026-10-23): ningún plano sostiene más de `maxShotSec` de
 * narración. Un plano largo se divide en sub-planos consecutivos que CONTINÚAN el mismo sujeto/lugar/época con otra
 * escala, perspectiva y movimiento (sin afirmar nada nuevo: misma clase, misma identidad/prueba que su padre).
 * Cada sub-plano se ancla con una cita literal de su tramo, que se verifica única. Determinista.
 * Solo afecta a planes NUEVOS: los planes confirmados guardan sus secuencias y se ejecutan tal cual.
 */
export const SHOT_DENSITY_MAX_SEC: Record<"economical" | "balanced" | "cinematic", number> = { economical: 20, balanced: 14, cinematic: 8 };
const FRAMINGS: Record<string, { scale: "WIDE" | "MEDIUM"; framing: string }[]> = {
  ANCHOR: [{ scale: "MEDIUM", framing: "medium shot, three-quarter angle, same person and costume" }, { scale: "WIDE", framing: "wide shot placing the same person in the setting" }, { scale: "MEDIUM", framing: "low-angle medium close-up, same person, dramatic light" }, { scale: "WIDE", framing: "over-the-shoulder view from behind the same person" }],
  CONTEXT: [{ scale: "MEDIUM", framing: "closer view of the same place, different angle" }, { scale: "WIDE", framing: "high aerial perspective of the same place" }, { scale: "MEDIUM", framing: "ground-level perspective, foreground texture" }, { scale: "WIDE", framing: "reverse angle of the same place" }],
  ATMOSPHERE: [{ scale: "MEDIUM", framing: "closer, slower detail of the same mood" }, { scale: "WIDE", framing: "wider view of the same atmosphere" }, { scale: "MEDIUM", framing: "shallow depth of field, same elements" }],
  EVIDENCE: [{ scale: "MEDIUM", framing: "closer view of the same record, different angle, no new text" }, { scale: "WIDE", framing: "the same record in its archive setting" }],
};
const MIN_SUB_WORDS = 8;
type Slot = RoleSlot;
/** La cita de un sub-plano debe anclarse EXACTAMENTE en su posición (primera aparición = esa posición). */
function probeUnique(narration: string, words: string[], at: number): boolean {
  return quoteStart(narration, words.slice(at, at + 6).join(" ")) === at;
}
export function densifySlots(narration: string, slots: Slot[], maxShotSec: number): Slot[] {
  const words = narrationWords(narration);
  const maxWords = Math.max(MIN_SUB_WORDS, Math.round(maxShotSec * LONG_FORM_NARRATION_WORDS_PER_SECOND));
  const spans = intentWordSpans(narration, slots.map((s) => s.visual) as never);
  if (spans.some((sp) => sp.anchoredBy !== "quote")) return densifyByOrder(slots, words.length, maxWords);
  const out: Slot[] = [];
  const order = slots.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start);
  const remap = new Map<number, number>();
  for (const i of order) {
    const slot = slots[i], sp = spans[i], len = sp.end - sp.start;
    remap.set(i, out.length);
    out.push(slot);
    const framings = FRAMINGS[slot.role];
    if (!framings || slot.role === "DETAIL" || len <= maxWords) continue;
    const k = Math.ceil(len / maxWords);
    for (let j = 1; j < k; j++) {
      let at = sp.start + Math.round((j * len) / k);
      while (at < sp.end - MIN_SUB_WORDS && !probeUnique(narration, words, at)) at++;
      if (at >= sp.end - MIN_SUB_WORDS + 1 || !probeUnique(narration, words, at)) continue;
      const f = framings[(j - 1) % framings.length];
      const parent = slot.visual as Record<string, unknown>;
      out.push({ ...slot, scale: f.scale, scaleReason: `${slot.scaleReason}; continuation: ${f.framing}`,
        visual: { ...parent, description: `${String(parent.description ?? "").trim()} — ${f.framing}`, quote: words.slice(at, at + 6).join(" "), motion: true, continuityOf: i, subShot: j },
        impact: (Math.min(2, slot.impact ?? 2) as 1 | 2), impactReason: `continuation of the same moment (new angle, no new claim): ${slot.impactReason ?? ""}`.slice(0, 200) });
    }
  }
  // DETAIL apunta a un índice de la secuencia: se reasigna al nuevo índice de su padre.
  return out.map((s) => (s.detail ? { ...s, detail: { ...s.detail, of: remap.get(s.detail.of) ?? s.detail.of } } : s));
}

/**
 * Sin anclas literales completas el reparto es por ORDEN (intentWordSpans reparte por igual): basta añadir
 * continuaciones (sin cita, para no fingir un ancla) hasta que cada plano cubra ≤ maxWords. Round-robin sobre los
 * planos divisibles, en orden; nunca DETAIL/TRANSITION.
 */
function densifyByOrder(slots: Slot[], totalWords: number, maxWords: number): Slot[] {
  const needed = Math.ceil(totalWords / maxWords) - slots.length;
  const divisible = slots.map((s, i) => (FRAMINGS[s.role] && s.role !== "DETAIL" ? i : -1)).filter((i) => i >= 0);
  if (needed <= 0 || divisible.length === 0) return slots;
  const extra = new Map<number, number>();
  for (let n = 0; n < needed; n++) { const i = divisible[n % divisible.length]; extra.set(i, (extra.get(i) ?? 0) + 1); }
  const out: Slot[] = [], remap = new Map<number, number>();
  slots.forEach((slot, i) => {
    remap.set(i, out.length); out.push(slot);
    for (let j = 1; j <= (extra.get(i) ?? 0); j++) {
      const f = FRAMINGS[slot.role][(j - 1) % FRAMINGS[slot.role].length], parent = slot.visual as Record<string, unknown>;
      const { quote: _q, ...rest } = parent; void _q;
      out.push({ ...slot, scale: f.scale, scaleReason: `${slot.scaleReason}; continuation: ${f.framing}`,
        visual: { ...rest, description: `${String(parent.description ?? "").trim()} — ${f.framing}`, motion: true, continuityOf: i, subShot: j },
        impact: (Math.min(2, slot.impact ?? 2) as 1 | 2), impactReason: `continuation of the same moment (new angle, no new claim): ${slot.impactReason ?? ""}`.slice(0, 200) });
    }
  });
  return out.map((s) => (s.detail ? { ...s, detail: { ...s.detail, of: remap.get(s.detail.of) ?? s.detail.of } } : s));
}

/**
 * Clips generativos SOLO donde aportan (cinematográfica): momentos de impacto 3 con movimiento declarado, en planos que no
 * prueban nada ni muestran un documento (CONTEXT/ATMOSPHERE). Marca de PLAN (`aiVideoCandidate`): el reparto decide
 * con su elegibilidad y tope de clips; si no se permite, el plano queda como imagen. Planes sin la marca no cambian.
 */
export function markAiVideoCandidates(sequences: SequenceIntent[]): SequenceIntent[] {
  return sequences.map((seq) => ({ ...seq, slots: seq.slots.map((slot) => {
    const v = slot.visual as Record<string, unknown>;
    const ok = slot.impact === 3 && v.motion === true && (slot.role === "CONTEXT" || slot.role === "ATMOSPHERE") && !v.subShot;
    return ok ? { ...slot, aiVideoCandidate: true } : slot;
  }) }));
}

export function sequencesFromScript(beats: ScriptBeat[], opts: { maxShotSec?: number; aiVideoCandidates?: boolean } = {}): SequenceIntent[] | null {
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
    const finalSlots = opts.maxShotSec ? densifySlots(beat.narration, slots, opts.maxShotSec) : slots;
    slots.splice(0, slots.length, ...finalSlots);
    sequences.push({ id: `seq-${beat.id}`, purpose: (beat.purpose || beat.type || "sequence").slice(0, 200), viewerTakeaway: sentence(beat.narration), beatIds: [beat.id], slots });
  }
  return opts.aiVideoCandidates ? markAiVideoCandidates(sequences) : sequences;
}
