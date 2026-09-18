/**
 * Verifica la duración REAL de la narración (medida por ElevenLabs, no
 * estimada por conteo de palabras) contra la duración objetivo de la
 * solicitud — la única forma confiable de saber si el guion quedó bien
 * dimensionado, ya que `WORDS_PER_SECOND` (script-pacing.ts) es una
 * aproximación que puede desviarse por voz, idioma o estilo del guion.
 *
 * Deliberadamente NO estira ni recorta nada — eso produciría silencios o
 * cortes artificiales (prohibido explícitamente: el video debe sonar
 * natural). Su única función es advertir con una señal clara y accionable
 * cuando el guion se salió de tolerancia, para poder corregir
 * WORDS_PER_SECOND con datos reales en vez de "no consumas más videos
 * hasta que alguien lo note".
 */
const TOLERANCE_RATIO = 0.1;

export type DurationCheckResult = {
  targetSeconds: number;
  actualSeconds: number;
  ratio: number;
  withinTolerance: boolean;
  /** Positivo = quedó más corto de lo pedido; negativo = más largo. */
  deviationPercent: number;
};

export function checkDuration(targetSeconds: number, actualSeconds: number): DurationCheckResult {
  const ratio = targetSeconds > 0 ? actualSeconds / targetSeconds : 1;
  const deviationPercent = Math.round((1 - ratio) * 1000) / 10;

  return {
    targetSeconds,
    actualSeconds,
    ratio,
    withinTolerance: ratio >= 1 - TOLERANCE_RATIO && ratio <= 1 + TOLERANCE_RATIO,
    deviationPercent,
  };
}

export function formatDurationWarning(result: DurationCheckResult): string {
  const direction = result.deviationPercent > 0 ? "más corto" : "más largo";
  return (
    `Duración fuera de tolerancia (±10%): se pidieron ${result.targetSeconds}s, ` +
    `la narración real dura ${result.actualSeconds.toFixed(2)}s ` +
    `(${Math.abs(result.deviationPercent)}% ${direction} de lo pedido). ` +
    `Revisa WORDS_PER_SECOND en script-pacing.ts con datos reales acumulados.`
  );
}

/** Stops before footage/render; never stretches audio or silently regenerates TTS. */
export function assertNarrationDuration(targetSeconds: number, actualSeconds: number): void {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0 || !Number.isFinite(actualSeconds) || actualSeconds <= 0) throw new Error("Duración de narración inválida.");
  const result = checkDuration(targetSeconds, actualSeconds);
  if (!result.withinTolerance) throw new Error(`La narración dura ${actualSeconds.toFixed(2)} s para un objetivo de ${targetSeconds} s. Ajusta el guion antes de otro intento; no se exportó un video fuera de duración.`);
}
