/**
 * Motor de elegibilidad para video-IA — determinístico, testeable, SIN
 * red. Responde: "¿este shot es candidato a un tratamiento de video/motion
 * generado, y cuánto valdría la pena?" — nunca "genéralo" (eso lo decide
 * el cost guard + el resolver). Video-IA NUNCA debe ser el método por
 * defecto: un shot que ya es texto/diagrama/mapa (determinístico) nunca es
 * candidato, y cualquier otro shot arranca de una puntuación baja que solo
 * sube si el texto describe movimiento narrativamente significativo.
 *
 * Pensado para que un LLM pueda, en el futuro, PROPONER motionDescription/
 * motionRequired (ver Shot en types.ts) — pero la puntuación final y la
 * recomendación de asset siguen siendo reglas explícitas y auditable aquí,
 * nunca una decisión opaca del LLM. El cost guard conserva la última
 * palabra sobre si algo elegible realmente se genera.
 */
import type { Shot, ShotType, VisualAssetTier } from "./types";
import { getAiVideoCostConfig, type AiVideoCostConfig } from "./ai-video-cost-guard";

/** Shots determinísticos (texto/diagrama/mapa) — nunca candidatos, sin excepción. */
const NEVER_ELIGIBLE_SHOT_TYPES = new Set<ShotType>(["text", "diagram", "map"]);

/**
 * Señales de BAJA necesidad de movimiento (sección 6A del encargo):
 * mapas, documentos, inscripciones, estatuas, fotografías históricas,
 * arquitectura estática, gráficos, cifras, objetos mostrables con una
 * imagen fija. En inglés — mismo idioma que `visualIntent`/`queryOrPrompt`
 * en todos los storyboards existentes.
 */
export const LOW_MOTION_SIGNALS = [
  "map",
  "document",
  "inscription",
  "statue",
  "photograph",
  "archival photo",
  "architecture",
  "ruins",
  "carving",
  "relief",
  "manuscript",
  "artifact",
  "figurine",
  "diagram",
  "chart",
  "graph",
  "portrait",
  "still life",
  "close-up of an object",
  "aerial view",
] as const;

/**
 * Señales de ALTA necesidad de movimiento (sección 6B): acción humana,
 * construcción, desplazamiento, transformación, interacción, movimiento
 * físicamente significativo, reconstrucciones donde una imagen fija
 * pierde información narrativa.
 */
export const HIGH_MOTION_SIGNALS = [
  "walking",
  "running",
  "building",
  "construction",
  "digging",
  "carrying",
  "working",
  "gesture",
  "gesturing",
  "reaching",
  "lifting",
  "pulling",
  "pushing",
  "cooperating",
  "interacting",
  "transforming",
  "transformation",
  "gathering",
  "procession",
  "ritual",
  "ceremony",
  "dancing",
  "crowd",
  "moving through",
  "traveling",
] as const;

const BASE_SCORE = 0.15;
const HIGH_SIGNAL_WEIGHT = 0.22;
const LOW_SIGNAL_WEIGHT = 0.18;
const MOTION_REQUIRED_BOOST = 0.25;

/** Umbral desde el cual se recomienda un clip de video-IA completo. */
export const AI_VIDEO_SCORE_THRESHOLD = 0.7;
/** Umbral desde el cual, sin llegar al anterior, se recomienda imagen fija + tratamiento de cámara/motion (más barato). */
export const AI_IMAGE_MOTION_SCORE_THRESHOLD = 0.4;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function countSignalHits(text: string, signals: readonly string[]): number {
  const lower = text.toLowerCase();
  return signals.reduce((count, signal) => (lower.includes(signal) ? count + 1 : count), 0);
}

export type AiVideoEligibilityInput = Pick<Shot, "id" | "visualIntent" | "durationSec"> &
  Partial<Pick<Shot, "type" | "motionRequired" | "motionDescription" | "preferredAssetType">>;

export type AiVideoEligibilityResult = {
  shotId: string;
  /** 0 (sin necesidad de movimiento) a 1 (necesidad narrativa máxima) — nunca decide por sí sola, ver cost guard. */
  eligibilityScore: number;
  reason: string;
  recommendedAssetType: VisualAssetTier;
  /**
   * Valor narrativo estimado (0-1) de tratar este shot con movimiento —
   * en esta v1 es directamente el `eligibilityScore` (ambos derivan de la
   * misma heurística de significancia del movimiento); queda como campo
   * separado para que un estimador futuro (p. ej. basado en LLM o en
   * datos de retención) lo pueda calcular de forma independiente sin
   * romper la interfaz.
   */
  estimatedValue: number;
  estimatedCostUsd: number;
  /** Orden de degradación si `recommendedAssetType` no está disponible o excede presupuesto — nunca vacío para un tier que no sea ya el más barato. */
  fallback: VisualAssetTier[];
};

function fallbackChainFor(tier: VisualAssetTier): VisualAssetTier[] {
  switch (tier) {
    case "ai_video":
      return ["ai_image_motion", "ai_image", "real_image"];
    case "ai_image_motion":
      return ["ai_image", "real_image"];
    case "ai_image":
      return ["real_image"];
    case "real_video":
    case "real_image":
      return [];
  }
}

/**
 * Puntúa UN shot. Determinístico: mismo input siempre produce el mismo
 * resultado (ningún componente aleatorio, ninguna llamada de red/LLM).
 */
export function scoreAiVideoEligibility(
  input: AiVideoEligibilityInput,
  costConfig: AiVideoCostConfig = getAiVideoCostConfig(),
): AiVideoEligibilityResult {
  if (input.type && NEVER_ELIGIBLE_SHOT_TYPES.has(input.type)) {
    return {
      shotId: input.id,
      eligibilityScore: 0,
      reason: `shot.type="${input.type}" es determinístico (texto/diagrama/mapa) — nunca candidato a video IA`,
      recommendedAssetType: "real_image",
      estimatedValue: 0,
      estimatedCostUsd: 0,
      fallback: [],
    };
  }

  // Una preferencia explícita de preproducción (decidida por un humano,
  // no por esta heurística) tiene prioridad sobre la puntuación — pero
  // igual se calcula el score/reason para que quede trazado el porqué.
  const text = `${input.visualIntent} ${input.motionDescription ?? ""}`.trim();
  const highHits = countSignalHits(text, HIGH_MOTION_SIGNALS);
  const lowHits = countSignalHits(text, LOW_MOTION_SIGNALS);
  const motionBoost = input.motionRequired ? MOTION_REQUIRED_BOOST : 0;
  const eligibilityScore = clamp01(BASE_SCORE + highHits * HIGH_SIGNAL_WEIGHT - lowHits * LOW_SIGNAL_WEIGHT + motionBoost);

  let recommendedAssetType: VisualAssetTier;
  let reason: string;
  if (input.preferredAssetType) {
    recommendedAssetType = input.preferredAssetType;
    reason = `preferencia explícita de preproducción ("${input.preferredAssetType}") — score calculado=${eligibilityScore.toFixed(2)} (${highHits} señales de movimiento, ${lowHits} señales estáticas) queda como referencia, no anula la preferencia`;
  } else if (eligibilityScore >= AI_VIDEO_SCORE_THRESHOLD) {
    recommendedAssetType = "ai_video";
    reason = `score=${eligibilityScore.toFixed(2)} >= ${AI_VIDEO_SCORE_THRESHOLD} (${highHits} señales de movimiento significativo, ${lowHits} señales estáticas) — candidato a clip de video IA completo`;
  } else if (eligibilityScore >= AI_IMAGE_MOTION_SCORE_THRESHOLD) {
    recommendedAssetType = "ai_image_motion";
    reason = `score=${eligibilityScore.toFixed(2)} entre ${AI_IMAGE_MOTION_SCORE_THRESHOLD} y ${AI_VIDEO_SCORE_THRESHOLD} — imagen fija con tratamiento de cámara/motion, no justifica el costo de un clip completo`;
  } else {
    recommendedAssetType = "ai_image";
    reason = `score=${eligibilityScore.toFixed(2)} < ${AI_IMAGE_MOTION_SCORE_THRESHOLD} (${lowHits} señales estáticas dominan) — imagen fija basta, el movimiento no aportaría valor narrativo suficiente`;
  }

  const perSecondRate =
    recommendedAssetType === "ai_video"
      ? costConfig.aiVideoCostPerSecondUsd
      : recommendedAssetType === "ai_image_motion"
        ? costConfig.aiImageMotionCostPerSecondUsd
        : 0;
  const estimatedCostUsd = Math.round(perSecondRate * input.durationSec * 10000) / 10000;

  return {
    shotId: input.id,
    eligibilityScore,
    reason,
    recommendedAssetType,
    estimatedValue: eligibilityScore,
    estimatedCostUsd,
    fallback: fallbackChainFor(recommendedAssetType),
  };
}

/** Puntúa un lote completo, en orden — conveniencia sobre `scoreAiVideoEligibility` para todo un beat/documental. */
export function scoreAiVideoEligibilityBatch(
  inputs: AiVideoEligibilityInput[],
  costConfig: AiVideoCostConfig = getAiVideoCostConfig(),
): AiVideoEligibilityResult[] {
  return inputs.map((input) => scoreAiVideoEligibility(input, costConfig));
}
