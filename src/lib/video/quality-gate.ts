/**
 * Puntuación interna de calidad, calculada DESPUÉS de seleccionar todo el
 * footage pero ANTES del render de Remotion (el paso de cómputo más
 * pesado del pipeline) — puerta técnica preventiva, no una garantía
 * objetiva de que el video "se verá bien". Cubre lo que sí se puede medir
 * con los datos que ya existen en este punto: diversidad real de clips,
 * cuánto tuvo que recurrir el selector a conceptos alternativos o
 * reformulaciones (proxy de qué tan bien encajó el material encontrado
 * con el plan), y que el ritmo de los planos quedó dentro de los límites
 * de la Fase 4 (1.8-3.8s).
 *
 * LÍMITE HONESTO: no puede evitar el costo YA gastado en la síntesis de
 * voz (ocurre antes, en el paso 1, y es la única forma de conocer la
 * duración real) — cubre el render/música/subida, que son los pasos
 * restantes más caros en tiempo de cómputo. Tampoco mide "relevancia
 * semántica" real (ver footage-score.ts: Pexels no expone descripciones
 * de contenido) — mide señales indirectas disponibles.
 *
 * Deliberadamente NO bloquea el pipeline todavía (advierte con detalle,
 * no lanza): el umbral de "score mínimo aceptable" necesita calibrarse
 * con datos de renders reales antes de poder usarse como bloqueo seguro
 * — bloquear sin calibrar arriesga rechazar un video que en la práctica
 * está bien, sin ninguna forma de reintentar sin gastar de nuevo (ver
 * restricción de "un solo render real" de esta fase). Ver el reporte de
 * esta fase para el plan de convertirlo en bloqueo una vez calibrado.
 */

export type QualityGateInput = {
  totalBeats: number;
  uniqueSourceIds: number;
  /** Selecciones que necesitaron reformular la consulta o caer a imagen. */
  fallbackCount: number;
  /** Promedio del "tier" de concepto usado (0 = siempre el concepto principal). */
  averageConceptTier: number;
  /** Duración de cada beat, en segundos. */
  beatDurations: number[];
  durationWithinTolerance: boolean;
};

export type QualityGateResult = {
  score: number;
  diversityScore: number;
  planAdherenceScore: number;
  pacingScore: number;
  passed: boolean;
  reasons: string[];
};

export const QUALITY_GATE_MIN_SCORE = 55;
const MIN_BEAT_SECONDS = 1.8;
const MAX_BEAT_SECONDS = 3.8;

export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const reasons: string[] = [];

  // Diversidad: fracción de beats con un clip verdaderamente distinto —
  // debería ser siempre 1.0 (footage-select.ts nunca reutiliza un
  // sourceId), así que un valor menor indicaría un bug en esa garantía,
  // no una elección de calidad — se mide igual, como red de seguridad.
  const diversityScore =
    input.totalBeats > 0 ? (input.uniqueSourceIds / input.totalBeats) * 100 : 100;
  if (diversityScore < 100) {
    reasons.push(
      `diversidad ${diversityScore.toFixed(0)}% — debería ser 100% (revisar footage-select.ts)`,
    );
  }

  // Adherencia al plan: cuánto se usó el concepto PRINCIPAL (tier 0) vs.
  // alternativas/reformulaciones — un promedio alto sugiere que el
  // material disponible no encajaba bien con lo planeado.
  const fallbackRatio = input.totalBeats > 0 ? input.fallbackCount / input.totalBeats : 0;
  const tierPenalty = Math.min(60, input.averageConceptTier * 20);
  const fallbackPenalty = Math.min(40, fallbackRatio * 100 * 0.4);
  const planAdherenceScore = Math.max(0, 100 - tierPenalty - fallbackPenalty);
  if (fallbackRatio > 0.3) {
    reasons.push(
      `${(fallbackRatio * 100).toFixed(0)}% de los planos necesitó reformular la búsqueda o caer a imagen`,
    );
  }

  // Ritmo: fracción de beats dentro de [1.8s, 3.8s] + que no todos duren
  // exactamente lo mismo (variedad real, no una duración pareja).
  const inBoundsCount = input.beatDurations.filter(
    (d) => d >= MIN_BEAT_SECONDS - 0.05 && d <= MAX_BEAT_SECONDS + 0.05,
  ).length;
  const inBoundsRatio = input.beatDurations.length > 0 ? inBoundsCount / input.beatDurations.length : 1;
  const uniqueDurations = new Set(input.beatDurations.map((d) => Math.round(d * 10))).size;
  const hasVariety = input.beatDurations.length <= 1 || uniqueDurations > 1;
  const pacingScore = inBoundsRatio * 80 + (hasVariety ? 20 : 0);
  if (inBoundsRatio < 1) {
    reasons.push(`${((1 - inBoundsRatio) * 100).toFixed(0)}% de los planos fuera de 1.8-3.8s`);
  }
  if (!hasVariety) {
    reasons.push("todos los planos duran exactamente lo mismo (sin variación de ritmo)");
  }

  if (!input.durationWithinTolerance) {
    reasons.push("duración total fuera de la tolerancia ±10% (ver duration-check.ts)");
  }

  const score =
    diversityScore * 0.3 +
    planAdherenceScore * 0.4 +
    pacingScore * 0.3 -
    (input.durationWithinTolerance ? 0 : 10);

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    diversityScore: Math.round(diversityScore),
    planAdherenceScore: Math.round(planAdherenceScore),
    pacingScore: Math.round(pacingScore),
    passed: score >= QUALITY_GATE_MIN_SCORE,
    reasons,
  };
}
