/**
 * Plan y control de gasto de las MUESTRAS REALES de la dirección
 * audiovisual (scripts/audiovisual-samples.ts). Puro: sin red.
 *
 * Topes duros (en código, no solo en el workflow): US$3,50 en total y
 * US$0,75 por muestra. Las entradas del workflow solo pueden BAJARLOS.
 * El acumulado se calcula desde los registros durables de TODAS las
 * muestras (incluidos intentos fallidos y operaciones inciertas), así que
 * un reintento del workflow nunca reinicia el presupuesto.
 */
import { PROFILES, parseSelection, type AudiovisualSelection } from "./catalog";
import { IMAGE_RESERVE_USD, SCRIPT_RESERVE_USD, voiceReserveUsd } from "./paid-costs";
import { expectedSceneCount } from "./readiness";
import { targetWordsFor } from "../script-pacing";

export const SAMPLE_HARD_TOTAL_USD = 3.5;
export const SAMPLE_HARD_PER_SAMPLE_USD = 0.75;
export const SAMPLE_DURATION_SECONDS = 30;
/** Caracteres por palabra narrada en español (promedio con espacios), para reservar voz antes de tener el guion. */
const CHARS_PER_WORD = 6.2;

export type SampleSpec = { id: string; purpose: string; topic: string; style: string; selection: AudiovisualSelection };
export type SampleManifest = { version: 1; samples: SampleSpec[] };

export function parseSampleManifest(raw: unknown): SampleManifest {
  const m = raw as { version?: number; samples?: unknown[] };
  if (m?.version !== 1 || !Array.isArray(m.samples) || m.samples.length === 0) throw new Error("Manifiesto de muestras inválido");
  const ids = new Set<string>();
  const samples = m.samples.map((s) => {
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || !/^[a-z0-9-]+$/.test(x.id) || ids.has(x.id)) throw new Error(`id de muestra inválido: ${String(x.id)}`);
    ids.add(x.id);
    if (typeof x.topic !== "string" || typeof x.style !== "string") throw new Error(`Muestra ${x.id}: tema/tono inválidos`);
    const sel = parseSelection((x.selection ?? {}) as Record<string, unknown>);
    if (!sel.ok) throw new Error(`Muestra ${x.id}: ${sel.error}`);
    return { id: x.id, purpose: String(x.purpose ?? ""), topic: x.topic, style: x.style, selection: sel.selection };
  });
  return { version: 1, samples };
}

export type BudgetCaps = { totalUsd: number; perSampleUsd: number };

/** Las entradas del workflow solo pueden reducir los topes duros. */
export function resolveCaps(input: { totalUsd?: string | number; perSampleUsd?: string | number }): BudgetCaps {
  const num = (v: unknown, hard: number) => {
    if (v === undefined || v === "") return hard;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Tope inválido: ${String(v)}`);
    if (n > hard + 1e-9) throw new Error(`El tope US$${n} supera el máximo autorizado de US$${hard}`);
    return n;
  };
  return { totalUsd: num(input.totalUsd, SAMPLE_HARD_TOTAL_USD), perSampleUsd: num(input.perSampleUsd, SAMPLE_HARD_PER_SAMPLE_USD) };
}

export type SampleEstimate = {
  id: string;
  images: number;
  /** Peor caso reservado: guion + voz + corrección de voz + imágenes. */
  reserveUsd: number;
  /** Estimación típica (tarifas de referencia; voz sin corrección). */
  typicalUsd: number;
  lines: { item: string; reserveUsd: number; typicalUsd: number; basis: string }[];
};

export function estimateSample(sample: SampleSpec, rates: { imageTypicalUsd: number; voiceTypicalUsd: (chars: number) => number; scriptTypicalUsd: number }): SampleEstimate {
  const chars = Math.round(targetWordsFor(SAMPLE_DURATION_SECONDS) * CHARS_PER_WORD);
  const images = PROFILES[sample.selection.profile].visualSource === "generated_image" ? expectedSceneCount(SAMPLE_DURATION_SECONDS) : 0;
  const lines = [
    { item: "guion (Claude)", reserveUsd: SCRIPT_RESERVE_USD, typicalUsd: rates.scriptTypicalUsd, basis: "estimado (tokens desde caracteres)" },
    { item: `voz (ElevenLabs, ~${chars} caracteres)`, reserveUsd: voiceReserveUsd(chars), typicalUsd: rates.voiceTypicalUsd(chars), basis: "estimado (caracteres × tarifa registrada)" },
    { item: "corrección de duración de voz (solo si hace falta)", reserveUsd: voiceReserveUsd(chars), typicalUsd: 0, basis: "estimado; ocurre solo si la voz queda fuera de ±10 %" },
    ...(images > 0
      ? [{ item: `${images} imágenes (OpenAI)`, reserveUsd: images * IMAGE_RESERVE_USD, typicalUsd: images * rates.imageTypicalUsd, basis: "medido por usage cuando la respuesta lo trae; si no, estimado" }]
      : []),
  ];
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return {
    id: sample.id,
    images,
    reserveUsd: r(lines.reduce((a, l) => a + l.reserveUsd, 0)),
    typicalUsd: r(lines.reduce((a, l) => a + l.typicalUsd, 0)),
    lines: lines.map((l) => ({ ...l, reserveUsd: r(l.reserveUsd), typicalUsd: r(l.typicalUsd) })),
  };
}

/**
 * Tope efectivo de una muestra = mínimo entre el tope por muestra y lo que
 * queda del total tras lo comprometido por las DEMÁS muestras. Una muestra
 * solo arranca si su peor caso restante cabe (para no quedar a medias).
 */
export function sampleBudgetDecision(input: {
  caps: BudgetCaps;
  committedBySample: Record<string, number>;
  sampleId: string;
  estimate: SampleEstimate;
}): { start: boolean; effectiveCapUsd: number; othersCommittedUsd: number; alreadyCommittedUsd: number; reason?: string } {
  const own = input.committedBySample[input.sampleId] ?? 0;
  const others = Object.entries(input.committedBySample).reduce((a, [id, v]) => (id === input.sampleId ? a : a + v), 0);
  const effectiveCapUsd = Math.round(Math.max(0, Math.min(input.caps.perSampleUsd, input.caps.totalUsd - others)) * 1e6) / 1e6;
  const remaining = effectiveCapUsd - own;
  if (input.estimate.reserveUsd - 1e-9 > input.caps.perSampleUsd) {
    return { start: false, effectiveCapUsd, othersCommittedUsd: others, alreadyCommittedUsd: own, reason: `el peor caso de la muestra (US$${input.estimate.reserveUsd}) supera el tope por muestra` };
  }
  if (own === 0 && input.estimate.reserveUsd - 1e-9 > remaining) {
    return { start: false, effectiveCapUsd, othersCommittedUsd: others, alreadyCommittedUsd: own, reason: `no queda presupuesto suficiente (restan US$${remaining.toFixed(2)}, peor caso US$${input.estimate.reserveUsd})` };
  }
  return { start: true, effectiveCapUsd, othersCommittedUsd: others, alreadyCommittedUsd: own };
}
