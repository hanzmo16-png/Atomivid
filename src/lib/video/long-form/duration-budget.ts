/**
 * Presupuesto de duración de Long Form (P0 2026-09-25, "180 s pedidos →
 * ~4m33 planeados → ~300 s reales").
 *
 * Causa raíz demostrada con la solicitud real del Canal de Panamá:
 * - El guionista exigía "~150-250 palabras" por beat con un MÍNIMO de 5
 *   beats → ≥ 750 palabras sin importar la duración pedida. El guion salió
 *   con 763 palabras para un objetivo de 180 s (~450 palabras).
 * - El plan estimaba la duración con 2.8 palabras/s (el valor de Reel);
 *   ElevenLabs narró esas 763 palabras en 299.8 s = 2.545 palabras/s. Por
 *   eso el plan dijo ~4m33 y el render tuvo 9010 fotogramas (~300 s).
 *
 * Puro y sin dependencias de servidor (lo usan el guionista, el plan y la
 * pantalla de configuración).
 */

/**
 * Ritmo de narración CALIBRADO para Long Form (voz documental de
 * ElevenLabs en español): 763 palabras / 299.8 s = 2.545 medidos en
 * producción; se usa 2.5 (redondeo conservador: nunca subestimar la
 * duración). El 2.8 de script-pacing.ts sigue siendo el de Reel.
 */
export const LONG_FORM_NARRATION_WORDS_PER_SECOND = 2.5;

/** Desviación aceptada sin corregir (±15%). */
export const LONG_FORM_DURATION_TOLERANCE = 0.15;
/** Más allá de esto (±25%) el guion no se acepta aunque se haya corregido una vez. */
export const LONG_FORM_DURATION_HARD_TOLERANCE = 0.25;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type NarrationWordBudget = {
  targetSeconds: number;
  totalWords: number;
  minWords: number;
  maxWords: number;
  beats: number;
  wordsPerBeat: number;
};

/** Palabras de narración para `targetSeconds` y su reparto en beats (5-10). */
export function narrationWordBudget(targetSeconds: number): NarrationWordBudget {
  const totalWords = Math.round(targetSeconds * LONG_FORM_NARRATION_WORDS_PER_SECOND);
  const beats = Math.max(5, Math.min(10, Math.round(targetSeconds / 90)));
  return {
    targetSeconds,
    totalWords,
    minWords: Math.round(totalWords * (1 - LONG_FORM_DURATION_TOLERANCE)),
    maxWords: Math.round(totalWords * (1 + LONG_FORM_DURATION_TOLERANCE)),
    beats,
    wordsPerBeat: Math.round(totalWords / beats),
  };
}

export type DurationEvaluation = {
  words: number;
  estimatedSeconds: number;
  /** estimado / objetivo (1 = exacto). */
  ratio: number;
  withinTolerance: boolean;
  withinHardTolerance: boolean;
};

export function evaluateNarrationDuration(words: number, targetSeconds: number): DurationEvaluation {
  const estimatedSeconds = words / LONG_FORM_NARRATION_WORDS_PER_SECOND;
  const ratio = targetSeconds > 0 ? estimatedSeconds / targetSeconds : 1;
  return {
    words,
    estimatedSeconds,
    ratio,
    withinTolerance: Math.abs(ratio - 1) <= LONG_FORM_DURATION_TOLERANCE,
    withinHardTolerance: Math.abs(ratio - 1) <= LONG_FORM_DURATION_HARD_TOLERANCE,
  };
}
