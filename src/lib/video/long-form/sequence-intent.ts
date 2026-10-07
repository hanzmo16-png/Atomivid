/**
 * Plan v5 — Directed Opening V1. LA SECUENCIA ES LA COLUMNA.
 *
 * Orden creativo (nunca al revés):
 *
 *   INTENCIÓN NARRATIVA DE LA SECUENCIA (qué debe entender/sentir el espectador)
 *   → ROLES VISUALES (ANCHOR, CONTEXT, EVIDENCE, DETAIL, GEOGRAPHY, TRANSITION, ATMOSPHERE)
 *   → REQUISITOS DE RECURSO (los contratos v4 de BeatVisual: identidad, prueba, lugar…)
 *   → RESOLUCIÓN (registro verificado + selector existentes, aguas abajo)
 *   → SECUENCIA EJECUTABLE → planos → render.
 *
 * El planner PROPONE límites, propósito y roles. NO aprueba recursos, licencias,
 * identidad, prueba ni procedencia: eso sigue siendo del registro verificado y
 * del selector. El resolver responde "¿hay un recurso legal y verdadero capaz de
 * ocupar este rol?", nunca "¿qué debería significar esta secuencia?".
 */
import { normalizeDeclaredVisuals, personActionIndex, requiresEvidence, requiresIdentity, type BeatVisual } from "./visual-intents";
import { RENDERER_CAPABILITIES } from "./cinematic-director";
import type { VerifiedAssetRegistry } from "./verified-assets";

export const SEQUENCE_ROLES = ["ANCHOR", "CONTEXT", "EVIDENCE", "DETAIL", "GEOGRAPHY", "TRANSITION", "ATMOSPHERE"] as const;
export type SequenceRole = (typeof SEQUENCE_ROLES)[number];
export const SHOT_SCALES = ["WIDE", "MEDIUM", "DETAIL"] as const;
export type ShotScale = (typeof SHOT_SCALES)[number];
/** Regiones a las que un DETAIL puede ir: solo las curadas por una persona en el registro verificado. */
export const DETAIL_REGIONS = ["headline", "date", "detail", "subject"] as const;
export type DetailRegion = (typeof DETAIL_REGIONS)[number];

export type RoleSlot = {
  role: SequenceRole;
  scale: ShotScale;
  /** Por qué ESTA escala sirve a la narración (la escala es una herramienta expresiva, no una rotación). */
  scaleReason: string;
  /** Beat cuya narración cubre el plano. */
  beatId: string;
  /** Requisito de recurso con la MISMA forma que un visual declarado (v4): descripción, cita, clase, identidad, prueba… */
  visual: Record<string, unknown>;
  /** Solo DETAIL: plano de la secuencia del que es detalle y región curada a la que va. Nunca prueba nueva. */
  detail?: { of: number; region: DetailRegion };
};

export type SequenceIntent = {
  id: string;
  /** Propósito narrativo de la secuencia. */
  purpose: string;
  /** Qué debe entender o sentir el espectador al terminar la secuencia (se responde ANTES de elegir roles). */
  viewerTakeaway: string;
  beatIds: string[];
  slots: RoleSlot[];
  /** Rótulo de apertura opcional: año (serif) y lugar (sans). Texto del planner, nunca una afirmación de archivo. */
  slug?: { year?: string; place?: string };
};

export type SequenceValidation = { errors: string[]; warnings: string[] };

/** Duración orientativa (no un temporizador): 15–30 s; menos de 10 s o más de 60 s es una advertencia. */
export const SEQUENCE_SECONDS_GUIDE = { min: 15, max: 30, warnBelow: 10, warnAbove: 60 } as const;

/** Contrato de la secuencia: roles cerrados, escala justificada, DETAIL solo sobre regiones curadas, sin dobles de persona. */
export function validateSequenceIntents(
  sequences: unknown,
  beats: { id: string; narration: string }[],
  estimateSeconds: (narration: string) => number = (n) => n.trim().split(/\s+/).filter(Boolean).length / 2.5,
): SequenceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(sequences) || sequences.length === 0) return { errors: ["plan v5 sin secuencias"], warnings };
  const beatIndex = new Map(beats.map((b, i) => [b.id, i]));
  const used = new Set<string>();
  let lastBeat = -1;
  for (const raw of sequences as SequenceIntent[]) {
    const id = raw?.id ?? "?";
    if (!raw?.id || !raw.purpose?.trim() || !raw.viewerTakeaway?.trim()) errors.push(`${id}: falta id, propósito o lo que debe entender/sentir el espectador`);
    if (!Array.isArray(raw?.beatIds) || raw.beatIds.length === 0) {
      errors.push(`${id}: sin beats`);
      continue;
    }
    for (const b of raw.beatIds) {
      const i = beatIndex.get(b);
      if (i === undefined) errors.push(`${id}: beat desconocido ${b}`);
      else if (used.has(b)) errors.push(`${id}: el beat ${b} ya pertenece a otra secuencia`);
      else if (i !== lastBeat + 1) errors.push(`${id}: las secuencias cubren los beats en orden y sin huecos (${b})`);
      else lastBeat = i;
      used.add(b);
    }
    const seconds = raw.beatIds.reduce((s, b) => s + estimateSeconds(beats[beatIndex.get(b) ?? 0]?.narration ?? ""), 0);
    if (seconds < SEQUENCE_SECONDS_GUIDE.warnBelow) warnings.push(`${id}: secuencia de ${seconds.toFixed(0)} s (orientativo 15–30 s): ¿cambió de verdad el propósito?`);
    if (seconds > SEQUENCE_SECONDS_GUIDE.warnAbove) warnings.push(`${id}: secuencia de ${seconds.toFixed(0)} s: probablemente agrupa varios propósitos`);
    if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
      errors.push(`${id}: sin roles`);
      continue;
    }
    raw.slots.forEach((slot, k) => {
      const at = `${id}#${k}`;
      if (!(SEQUENCE_ROLES as readonly string[]).includes(slot?.role)) errors.push(`${at}: rol fuera de la lista cerrada (${String(slot?.role)})`);
      if (!(SHOT_SCALES as readonly string[]).includes(slot?.scale)) errors.push(`${at}: escala inválida`);
      if (!slot?.scaleReason?.trim()) errors.push(`${at}: la escala necesita una razón narrativa`);
      if (!raw.beatIds.includes(slot?.beatId)) errors.push(`${at}: el plano narra un beat fuera de su secuencia`);
      const v = (slot?.visual ?? {}) as { identity?: unknown; evidence?: { sourceIds?: unknown[] }; beatClass?: string; description?: unknown };
      if (typeof v.description !== "string" || !v.description.trim()) errors.push(`${at}: requisito de recurso sin descripción`);
      const hasIdentity = !!v.identity;
      const hasEvidence = Array.isArray(v.evidence?.sourceIds) && v.evidence!.sourceIds!.length > 0;
      switch (slot?.role) {
        case "CONTEXT":
        case "ATMOSPHERE":
          // Nunca un doble de la persona; la atmósfera tampoco prueba nada.
          if (hasIdentity || v.beatClass === "IDENTITY") errors.push(`${at}: ${slot.role} nunca representa a una persona`);
          if (hasEvidence || v.beatClass === "EVIDENCE") errors.push(`${at}: ${slot.role} nunca prueba una proposición`);
          break;
        case "EVIDENCE":
          if (!hasEvidence) errors.push(`${at}: EVIDENCE exige la proposición (evidence.sourceIds)`);
          break;
        case "GEOGRAPHY":
          if (!hasEvidence) errors.push(`${at}: GEOGRAPHY exige un esquema curado vinculado a su fuente`);
          break;
        case "TRANSITION":
          if (hasIdentity || v.beatClass === "IDENTITY" || typeof (v as { action?: unknown }).action === "string") errors.push(`${at}: TRANSITION nunca es un plano de acción`);
          break;
        case "DETAIL": {
          const d = slot.detail;
          if (!d || !Number.isInteger(d.of) || d.of < 0 || d.of >= k) errors.push(`${at}: DETAIL debe señalar un plano ANTERIOR de la misma secuencia`);
          else if (raw.slots[d.of].role === "DETAIL" || raw.slots[d.of].role === "TRANSITION" || raw.slots[d.of].role === "ATMOSPHERE") errors.push(`${at}: DETAIL de un ${raw.slots[d.of].role} no tiene región curada`);
          if (!d || !(DETAIL_REGIONS as readonly string[]).includes(d.region)) errors.push(`${at}: DETAIL solo va a una región curada (${DETAIL_REGIONS.join("/")})`);
          if (slot.scale !== "DETAIL") errors.push(`${at}: un DETAIL se encuadra en escala DETAIL`);
          break;
        }
        default:
          break;
      }
      if (slot?.scale === "DETAIL" && slot.role !== "DETAIL") errors.push(`${at}: la escala DETAIL solo existe para el rol DETAIL (región curada)`);
    });
  }
  if (lastBeat !== beats.length - 1) errors.push("las secuencias deben cubrir todos los beats");
  return { errors, warnings };
}

// --------------------------------------------------------------------------
// Resolver determinista
// --------------------------------------------------------------------------

/** Lo que el SERVIDOR sabe que existe (registro verificado). Producción solo construye esto desde el registro. */
export type SlotAvailability = {
  /** ¿Material verificado para la identidad/proposición EXACTA? */
  covers(visual: BeatVisual): boolean;
  /** ¿Un SVG curado (con trazo y etiqueta aprobados) para esta proposición? */
  curatedSvg(visual: BeatVisual): boolean;
  /** Regiones curadas del material verificado de este contrato. */
  regions(visual: BeatVisual): string[];
};

export function registryAvailability(registry: VerifiedAssetRegistry | undefined): SlotAvailability {
  return {
    covers: (v) => !!registry?.covers(v),
    curatedSvg: (v) => !!registry?.recordsFor(v).some((r) => r.mime === "image/svg+xml" && !!r.svgReveal),
    regions: (v) => [...new Set((registry?.recordsFor(v) ?? []).flatMap((r) => (r.regions ?? []).map((g) => g.label)))],
  };
}

/**
 * FILL: el rol se ocupa con su propio requisito (verificado ya, o lo decide el selector: PENDING_SELECTOR).
 * RECOMPOSED: el rol no se puede ocupar con verdad y se reordenan roles LEGALES ya disponibles en la secuencia.
 * ABSTAIN: ausencia verdadera (tarjeta dirigida); el selector igualmente nunca acepta un parecido.
 * CARD: TRANSITION de tipo (año/texto), por diseño.
 * DROPPED: DETAIL sin región curada: no se fabrica; el plano anterior se sostiene.
 */
export type SlotStatus = "FILL" | "PENDING_SELECTOR" | "RECOMPOSED" | "ABSTAIN" | "CARD" | "DROPPED";

export type ResolvedSlot = {
  sequenceId: string;
  index: number;
  role: SequenceRole;
  scale: ShotScale;
  scaleReason: string;
  beatId: string;
  status: SlotStatus;
  /** Contrato v4 que se ejecuta (el propio, o el del rol legal que lo recompone). */
  visual: BeatVisual;
  detail?: { of: number; region: DetailRegion };
  reason?: string;
};

export type ExecutableSequence = {
  id: string;
  purpose: string;
  viewerTakeaway: string;
  slug?: SequenceIntent["slug"];
  slots: ResolvedSlot[];
};

/**
 * Los requisitos se normalizan EXACTAMENTE como los visuales v4 de un beat: todos los del mismo beat
 * juntos (la clasificación se juzga entre hermanos) y con las acciones de cada persona en TODO el
 * documento (personActionIndex): así ningún CONTEXT puede ser un doble de la persona (botones, pies, ejecutivo…).
 */
/**
 * v5: en una secuencia que trata de una PERSONA, CONTEXT/ATMOSPHERE/TRANSITION no pueden mostrar
 * a ningún humano genérico (un botones, un ejecutivo, unos pies…): sería su doble. Se expresa con
 * el mecanismo existente (personActions → personSubstitute del selector), no con otro filtro.
 */
export const HUMAN_STAND_IN_TERMS = [
  "man", "men", "woman", "women", "person", "people", "figure", "silhouette", "face", "portrait", "feet", "foot", "hand", "hands", "leg", "legs",
  "businessman", "businesswoman", "executive", "bellboy", "bellhop", "attendant", "doorman", "porter", "worker", "guard", "officer", "employee", "gentleman", "lady", "suit",
];
const NON_PERSON_ROLES: SequenceRole[] = ["CONTEXT", "ATMOSPHERE", "TRANSITION"];

function normalizeSlotVisuals(sequences: SequenceIntent[]): BeatVisual[][] {
  const byBeat = new Map<string, { s: number; k: number; declared: Record<string, unknown> }[]>();
  sequences.forEach((seq, s) => seq.slots.forEach((slot, k) => byBeat.set(slot.beatId, [...(byBeat.get(slot.beatId) ?? []), { s, k, declared: slot.visual }])));
  const personActions = personActionIndex([...byBeat.values()].map((list) => ({ visuals: list.map((x) => x.declared) })));
  const out: BeatVisual[][] = sequences.map((seq) => new Array<BeatVisual>(seq.slots.length));
  for (const list of byBeat.values()) {
    const normalized = normalizeDeclaredVisuals(list.map((x) => x.declared), { identity: true, personActions });
    if (normalized.length !== list.length) throw new Error(`requisito de recurso inválido en el beat ${sequences[list[0].s].slots[list[0].k].beatId}`);
    list.forEach((x, i) => (out[x.s][x.k] = normalized[i]));
  }
  sequences.forEach((seq, s) => {
    const aboutPerson = seq.slots.some((slot, k) => slot.role === "ANCHOR" && !!out[s][k].identity);
    if (!aboutPerson) return;
    seq.slots.forEach((slot, k) => {
      if (NON_PERSON_ROLES.includes(slot.role)) out[s][k] = { ...out[s][k], personActions: [...new Set([...(out[s][k].personActions ?? []), ...HUMAN_STAND_IN_TERMS])] };
    });
  });
  return out;
}

/**
 * Intención + roles + disponibilidad del servidor + capacidades REALES del renderer
 * → secuencia ejecutable, recomposición verdadera o abstención. Determinista y sin red.
 * Recomponer es REORDENAR roles verdaderos ya disponibles; nunca generar ni buscar un sustituto genérico.
 */
export function resolveSequences(sequences: SequenceIntent[], availability: SlotAvailability, capabilities: Record<string, string> = RENDERER_CAPABILITIES): ExecutableSequence[] {
  const normalized = normalizeSlotVisuals(sequences);
  return sequences.map((seq, sequenceIndex) => {
    const visuals = normalized[sequenceIndex];
    const out: ResolvedSlot[] = [];
    seq.slots.forEach((slot, index) => {
      const base = { sequenceId: seq.id, index, role: slot.role, scale: slot.scale, scaleReason: slot.scaleReason, beatId: slot.beatId };
      const v = visuals[index];
      const recomposeFromSequence = (why: string): ResolvedSlot => {
        // Escalera verdadera: otra prueba VERIFICADA de esta misma secuencia (el documento, en plano general); si no, tarjeta de año/texto.
        const k = seq.slots.findIndex((s, j) => j !== index && (s.role === "EVIDENCE" || (s.role === "ANCHOR" && !s.visual.identity)) && requiresEvidence(visuals[j]) && availability.covers(visuals[j]));
        if (k >= 0) {
          return { ...base, role: "EVIDENCE", scale: "WIDE", scaleReason: `recomposición: ${why}; se muestra el documento verificado de la secuencia, completo`, status: "RECOMPOSED", visual: { ...visuals[k], quote: v.quote ?? visuals[k].quote }, reason: `${slot.role} → EVIDENCE (#${k})` };
        }
        return { ...base, role: "TRANSITION", scale: "WIDE", scaleReason: `ausencia dirigida: ${why}`, status: "ABSTAIN", visual: v, reason: `${slot.role} sin material verdadero: tarjeta de año/texto` };
      };
      switch (slot.role) {
        case "ANCHOR":
          if (v.identity && requiresIdentity(v)) {
            out.push(availability.covers(v) ? { ...base, status: "FILL", visual: v } : recomposeFromSequence(`sin material verificado de ${v.identity.name}`));
          } else if (requiresEvidence(v)) {
            out.push(availability.covers(v) ? { ...base, status: "FILL", visual: v } : { ...base, status: "ABSTAIN", visual: v, reason: "ancla documental sin material verificado" });
          } else out.push({ ...base, status: "PENDING_SELECTOR", visual: v });
          break;
        case "EVIDENCE":
          // Una prueba que falta NUNCA se rellena con otra proposición.
          out.push(availability.covers(v) ? { ...base, status: "FILL", visual: v } : { ...base, status: "ABSTAIN", visual: v, reason: "proposición sin material verificado" });
          break;
        case "GEOGRAPHY":
          out.push(
            availability.curatedSvg(v) && capabilities.svg_reveal === "SUPPORTED_NOW"
              ? { ...base, status: "FILL", visual: v }
              : { ...base, status: "ABSTAIN", visual: v, reason: "sin esquema curado: nunca se infiere geografía" },
          );
          break;
        case "DETAIL": {
          const parent = slot.detail ? out[slot.detail.of] : undefined;
          const parentOk = !!parent && (parent.status === "FILL" || parent.status === "RECOMPOSED");
          const curated = parentOk && slot.detail ? availability.regions(parent!.visual).includes(slot.detail.region) : false;
          out.push(
            curated && parent
              ? { ...base, status: "FILL", visual: { ...parent.visual, quote: v.quote ?? parent.visual.quote }, detail: slot.detail }
              : { ...base, status: "DROPPED", visual: v, detail: slot.detail, reason: parentOk ? `sin región curada "${slot.detail?.region}": no se fabrica un detalle` : "el plano del que sería detalle no tiene material" },
          );
          break;
        }
        case "TRANSITION":
          out.push({ ...base, status: "CARD", visual: v, reason: "transición de tipo (año/texto)" });
          break;
        default:
          // CONTEXT / ATMOSPHERE: material legal de contexto que decide el selector (con sus filtros de dobles y falsos amigos).
          out.push({ ...base, status: "PENDING_SELECTOR", visual: v });
      }
    });
    return { id: seq.id, purpose: seq.purpose, viewerTakeaway: seq.viewerTakeaway, ...(seq.slug ? { slug: seq.slug } : {}), slots: out };
  });
}

/** Estimación del PLAN (antes de cargar el registro): cada rol se cuenta como ocupable; la ejecución lo resuelve de verdad. */
export const PLAN_ESTIMATE_AVAILABILITY: SlotAvailability = { covers: () => true, curatedSvg: () => true, regions: () => [...DETAIL_REGIONS] };

/** Planes que dirigen por secuencias (v5+). v1–v4 nunca leen este camino. */
export function usesSequences(plan: { version: number; sequences?: unknown }): boolean {
  return plan.version >= 5 && Array.isArray(plan.sequences) && plan.sequences.length > 0;
}
