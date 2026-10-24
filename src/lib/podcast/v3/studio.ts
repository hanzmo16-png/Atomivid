/**
 * Podcast 2.1 — Estudio audiovisual: piezas puras (sin red) para el flujo de 10 pasos.
 *  - Interruptor: PODCAST_V3_ENABLED=1, o por defecto SOLO en Vercel Preview (VERCEL_ENV=preview). Producción no cambia.
 *  - Proveedores visuales con disponibilidad y motivo: un proveedor elegido NUNCA se sustituye en silencio.
 *  - Línea de tiempo de labios: en cada plano solo mueve los labios quien tiene el turno; el otro queda en reposo.
 *  - Estimación por modo (episodio de N minutos) con desglose por proveedor.
 */
import { estimateEpisodeCost, type CostEstimate } from "./cost";
import { planEpisode, type EditorialPlan, type Shot, type VisualAsset } from "./editorial";
import { RECRAFT_USD_PER_IMAGE } from "@/lib/providers/image/recraft";
import type { StudioMode } from "./spec";
import type { Turn } from "./script";

type Env = Record<string, string | undefined>;

export type StudioFlag = { enabled: boolean; source: "env" | "preview" | "off"; reason: string };
/** El estudio se ve si PODCAST_V3_ENABLED=1 o si es un despliegue Preview de Vercel (salvo PODCAST_STUDIO_PREVIEW=0). */
export function studioFlag(env: Env = process.env): StudioFlag {
  if (env.PODCAST_V3_ENABLED === "1") return { enabled: true, source: "env", reason: "PODCAST_V3_ENABLED=1" };
  if (env.VERCEL_ENV === "preview" && env.PODCAST_STUDIO_PREVIEW !== "0") return { enabled: true, source: "preview", reason: "Vercel Preview: activado por defecto solo en Preview" };
  return { enabled: false, source: "off", reason: "Apagado (producción sin PODCAST_V3_ENABLED=1)" };
}

export type VisualProviderId = "pexels" | "recraft" | "solo_set";
export type VisualProvider = { id: VisualProviderId; label: string; available: boolean; reason: string | null; usdPerImage: number };
/**
 * Recraft existe en el repo (src/lib/providers/image/recraft.ts, vía fal.ai) y lo usa Reels/Long Form; el worker del
 * estudio de podcast todavía NO tiene un adaptador de recreaciones conectado, así que aquí se muestra «No disponible»
 * con el motivo. Si se elige igualmente, la API rechaza (409) en vez de cambiar a otro proveedor.
 */
export function visualProviders(env: Env = process.env): VisualProvider[] {
  const recraftReason = env.PODCAST_STUDIO_RECRAFT === "1" && env.FAL_KEY
    ? null
    : !env.FAL_KEY ? "No disponible: falta FAL_KEY y el adaptador de Recraft para el estudio de podcast aún no está conectado (solo Reels/Long Form lo usan)."
    : "No disponible: el adaptador de Recraft para el estudio de podcast aún no está conectado (PODCAST_STUDIO_RECRAFT≠1).";
  return [
    { id: "pexels", label: "Fotos de archivo (Pexels)", available: true, reason: null, usdPerImage: 0 },
    { id: "recraft", label: "Ilustraciones Recraft (fal.ai)", available: recraftReason === null, reason: recraftReason, usdPerImage: RECRAFT_USD_PER_IMAGE },
    { id: "solo_set", label: "Solo set virtual y avatares (sin imágenes)", available: true, reason: null, usdPerImage: 0 },
  ];
}
export class ProviderUnavailableError extends Error {
  constructor(public provider: string, public why: string) { super(`El proveedor elegido (${provider}) no está disponible: ${why} No se sustituye por otro; elige uno disponible.`); this.name = "ProviderUnavailableError"; }
}
/** Devuelve el proveedor elegido o lanza: jamás cae a otro. */
export function requireProvider(id: string, env: Env = process.env): VisualProvider {
  const p = visualProviders(env).find((x) => x.id === id);
  if (!p) throw new ProviderUnavailableError(id, "proveedor desconocido.");
  if (!p.available) throw new ProviderUnavailableError(p.label, p.reason ?? "");
  return p;
}

export { INTENSITY_DB } from "./wizard";

/** Estado de labios por participante en cada tramo. «habla» = clip con lip-sync; «reposo» = fotograma fijo sin labios. */
export type LipSegment = { start: number; end: number; shot: Shot["kind"]; speaker: "A" | "B" | null; lips: { A: "habla" | "reposo" | "fuera"; B: "habla" | "reposo" | "fuera" } };
const visibleIn = (s: Shot): { A: boolean; B: boolean } =>
  s.kind === "two_shot" || s.kind === "over_shoulder" ? { A: true, B: true } : s.kind === "avatar_a" ? { A: true, B: false } : s.kind === "avatar_b" ? { A: false, B: true } : { A: false, B: false };
/** Deriva la línea de tiempo de labios a partir del plan (lo mismo que hace la composición: un solo clip con lip-sync por plano, el del hablante). */
export function lipTimeline(plan: EditorialPlan): LipSegment[] {
  return plan.shots.map((s) => {
    const v = visibleIn(s);
    const st = (id: "A" | "B") => (!v[id] ? "fuera" : s.speaker === id ? "habla" : "reposo") as "habla" | "reposo" | "fuera";
    return { start: s.start, end: s.end, shot: s.kind, speaker: s.speaker, lips: { A: st("A"), B: st("B") } };
  });
}
/** Violaciones: alguien mueve los labios fuera de su turno (según la línea de tiempo de voz), o un plano de avatar muestra a quien no habla en primer plano. */
export function lipViolations(segs: LipSegment[], voice: { speaker: "A" | "B"; start: number; end: number }[]): string[] {
  const out: string[] = [];
  for (const s of segs) for (const id of ["A", "B"] as const) {
    if (s.lips[id] !== "habla") continue;
    const mid = (s.start + s.end) / 2;
    const turn = voice.find((t) => mid >= t.start - 1e-6 && mid <= t.end + 1e-6);
    if (!turn || turn.speaker !== id) out.push(`${id} mueve los labios en ${s.start.toFixed(2)}–${s.end.toFixed(2)} s sin tener el turno (${turn ? `habla ${turn.speaker}` : "silencio"}).`);
    const other = id === "A" ? "B" : "A";
    if (s.lips[other] === "habla") out.push(`Dos personas con labios activos a la vez en ${s.start.toFixed(2)} s.`);
  }
  return out;
}
/** Cobertura de planos de una conversación: plano general de los dos + primeros planos individuales. */
export function shotCoverage(plan: EditorialPlan) {
  const k = new Set(plan.shots.map((s) => s.kind));
  return { general: k.has("two_shot"), primerPlanoA: k.has("avatar_a"), primerPlanoB: k.has("avatar_b"), sobreHombro: k.has("over_shoulder") };
}

/** Turnos sintéticos de una conversación de N minutos (~15 caracteres/s) para estimaciones sin red. */
export function syntheticTurns(minutes: number, two: boolean): Turn[] {
  const kinds = ["apertura", "pregunta", "respuesta", "desacuerdo", "comentario", "transicion", "pregunta", "respuesta", "reaccion", "cierre"] as const;
  const perTurn = 30; // s
  const n = Math.max(2, Math.round(minutes * 60 / perTurn));
  return Array.from({ length: n }, (_, i) => ({ id: `T${String(i + 1).padStart(3, "0")}`, speaker: two ? (i % 2 ? "B" : "A") : "A", kind: kinds[i % kinds.length], text: `turno ${i + 1} volcanes ` + "x".repeat(perTurn * 15 - 20) }));
}
export type ModeEstimate = { mode: StudioMode | "solo_audio"; label: string; estimate: CostEstimate; byProvider: Record<string, number>; avatarSeconds: number };
/** Estimación por modo para un episodio de `minutes` minutos (por defecto 10), con los parámetros por defecto del asistente. */
export function estimateByMode(minutes = 10, o: { avatarFrequency?: number; avatarMaxSeconds?: number } = {}): ModeEstimate[] {
  const assets: VisualAsset[] = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, query: "volcanes", kind: "foto", tags: ["volcanes", "turno"] }));
  const mk = (mode: StudioMode, two: boolean, hasAvatar: { A: boolean; B: boolean }) => planEpisode({ mode, turns: syntheticTurns(minutes, two), assets, avatarFrequency: mode === "narracion" ? 0 : o.avatarFrequency ?? 0.5, avatarMaxSeconds: o.avatarMaxSeconds ?? 20, recreations: false, hasAvatar, introSeconds: 4 });
  const rows: [ModeEstimate["mode"], string, EditorialPlan, boolean][] = [
    ["solo_audio", "Solo audio (2 voces + música, MP3)", mk("narracion", true, { A: false, B: false }), false],
    ["narracion", "Narración con imágenes (2 voces)", mk("narracion", true, { A: false, B: false }), true],
    ["avatar", "Presentador con avatar", mk("avatar", false, { A: true, B: false }), true],
    ["dialogo", "Conversación con dos avatares", mk("dialogo", true, { A: true, B: true }), true],
  ];
  return rows.map(([mode, label, plan, video]) => {
    const est = estimateEpisodeCost({ ttsChars: minutes * 60 * 15, plan, recreationImages: 0, episodeSeconds: minutes * 60 + 8, renderMinutesFactor: video ? 1.5 : 0.2 });
    const byProvider: Record<string, number> = {};
    for (const l of est.lines) byProvider[l.provider] = Math.round(((byProvider[l.provider] ?? 0) + l.usd) * 1e4) / 1e4;
    return { mode, label, estimate: est, byProvider, avatarSeconds: plan.avatarSeconds.A + plan.avatarSeconds.B };
  });
}
