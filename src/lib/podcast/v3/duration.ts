/**
 * Duración prometida frente a duración producible (incidente 8f05fc37, 2026-11-01): se pidieron 27 min y se entregó un
 * MP4 de 5:33 marcado «ready». La duración del episodio la decide SOLO el guion (la voz no se acelera ni se rellena):
 * 43 turnos y 4.480 caracteres dan ~5,5 min por mucho que el objetivo diga 27. Aquí, una sola regla para la API, el
 * asistente y el generador:
 *  - antes de producir: duración estimada del guion (mismo cálculo que el estudio: voz + pausas + cortinas) y, en un
 *    episodio LARGO muy por debajo de lo pedido, la persona debe aceptar la duración real (no se promete lo que no cabe);
 *  - al terminar: la duración MEDIDA (ffprobe) del MP4 debe coincidir con la del audio montado (si no, el render se
 *    truncó: error, no «ready»), y la desviación frente a lo pedido queda registrada y visible.
 */
import type { StudioSpec } from "./spec";
import { episodeSeconds } from "./script";
import { turnsFor } from "./pipeline";

/**
 * Criterios (justificados con datos medidos):
 *  - ESTIMATE_ACCURACY: el cálculo por caracteres (13,5 car/s, calibrado en b9c6784d) se desvió −6 % en 8f05fc37
 *    (354,6 s estimados, 332,7 s reales) y +2 % en ba27b6f7; ±15 % cubre la variación de las voces sin falsos avisos.
 *  - LONG_EPISODE_MIN: desde 10 min la diferencia deja de ser un matiz (en 5 min, un guion de 4 es un aviso; en 27, uno
 *    de 5 es otro producto). Los episodios cortos conservan el aviso no bloqueante (shortScriptNotice).
 *  - MIN_COVERAGE: por debajo del 75 % del objetivo (más allá de la imprecisión del cálculo) la promesa no se cumple.
 */
export const ESTIMATE_ACCURACY = 0.15, LONG_EPISODE_MIN = 10, MIN_COVERAGE = 0.75;
/** Diferencia máxima entre el MP4 y su audio montado: más que un fotograma de cortina es un render incompleto. */
export const MUX_TOLERANCE_SECONDS = 1.5;

export type DurationCheck = {
  targetMinutes: number; estimatedSeconds: number; estimatedMinutes: number; coverage: number;
  /** Episodio largo cuyo guion no alcanza el objetivo: requiere aceptar la duración real antes de producir. */
  needsAcceptance: boolean; short: boolean; message: string | null;
};

const fmt = (min: number) => (min < 10 ? min.toFixed(1) : String(Math.round(min))).replace(".", ",");

export function scriptDuration(spec: Pick<StudioSpec, "mode" | "script" | "participants" | "target_minutes">): DurationCheck {
  let seconds = 0;
  try { seconds = episodeSeconds(turnsFor(spec as StudioSpec).turns); } catch { seconds = 0; }
  const targetMinutes = spec.target_minutes;
  const estimatedMinutes = Math.round((seconds / 60) * 10) / 10;
  const coverage = targetMinutes > 0 ? seconds / (targetMinutes * 60) : 1;
  const short = coverage < 1 - ESTIMATE_ACCURACY;
  const needsAcceptance = targetMinutes >= LONG_EPISODE_MIN && coverage < MIN_COVERAGE;
  const message = short
    ? `Tu guion da para unos ${fmt(estimatedMinutes)} min y elegiste ${targetMinutes} min. El episodio durará unos ${fmt(estimatedMinutes)} min: no se rellena ni se ralentiza la voz.`
    : null;
  return { targetMinutes, estimatedSeconds: Math.round(seconds), estimatedMinutes, coverage: Math.round(coverage * 100) / 100, needsAcceptance, short, message };
}

/** Minutos que se prometen cuando la persona acepta la duración real (redondeo hacia arriba, mínimo 1). */
export const acceptedMinutes = (c: DurationCheck) => Math.max(1, Math.ceil(c.estimatedSeconds / 60));

export class RenderTruncatedError extends Error {
  constructor(public videoSeconds: number, public audioSeconds: number) {
    super(`El video montado dura ${videoSeconds.toFixed(1)} s y su audio ${audioSeconds.toFixed(1)} s: el montaje quedó incompleto. No se entrega como listo; lo pagado se reutiliza al reintentar.`);
    this.name = "RenderTruncatedError";
  }
}

/** Integridad del montaje: el MP4 debe durar lo mismo que el audio montado (si no, se truncó). */
export function assertMuxComplete(videoSeconds: number, audioSeconds: number) {
  if (!(Math.abs(videoSeconds - audioSeconds) <= MUX_TOLERANCE_SECONDS)) throw new RenderTruncatedError(videoSeconds, audioSeconds);
}

/** Resultado guardado con el episodio: duración pedida, estimada y MEDIDA, y si se cumple lo prometido. */
export type DeliveredDuration = { target_minutes: number; estimated_seconds: number; measured_seconds: number; ok: boolean; note: string | null };
export function deliveredDuration(spec: Pick<StudioSpec, "mode" | "script" | "participants" | "target_minutes">, measuredSeconds: number): DeliveredDuration {
  const c = scriptDuration(spec);
  const ratio = measuredSeconds / (spec.target_minutes * 60);
  const ok = ratio >= 1 - ESTIMATE_ACCURACY && ratio <= 1 + 2 * ESTIMATE_ACCURACY;
  const mm = `${Math.floor(measuredSeconds / 60)}:${String(Math.round(measuredSeconds % 60)).padStart(2, "0")}`;
  return { target_minutes: spec.target_minutes, estimated_seconds: c.estimatedSeconds, measured_seconds: Math.round(measuredSeconds * 100) / 100, ok,
    note: ok ? null : `Duración real ${mm} frente a ${spec.target_minutes} min pedidos: el guion no daba para más (se entregó completo, sin relleno).` };
}
