/**
 * RC mission "LONG FORM RC FINAL HARDENING" — el hueco de producto central
 * que reportó Hans: antes de esta pieza, un usuario nunca podía elegir
 * cuánto contenido generativo quería (eso cambia el costo radicalmente) ni
 * ver una estimación antes de que arrancara la producción real. Este
 * módulo computa ese ProductionPlan de forma PURA — sin red, sin gastar un
 * centavo — para poder mostrarlo antes del paso de confirmación (ver
 * actions.ts) y para que el worker, una vez confirmado, ejecute EXACTAMENTE
 * lo que el usuario vio (snapshot inmutable, nunca un recálculo distinto
 * en silencio).
 *
 * Deliberadamente NO llama a buildLongFormTimeline() (ese sí hace una
 * llamada real y pagada a ElevenLabs para medir la duración narrada) — la
 * duración de cada beat se ESTIMA aquí a partir del conteo de palabras
 * (mismo WORDS_PER_SECOND ya calibrado y usado en toda la app,
 * script-pacing.ts), igual que Reel ya estima antes de narrar de verdad.
 * Los shots resultantes SÍ usan el generador real (shotsForSpan) — mismo
 * código, solo con duraciones estimadas en vez de medidas — así que la
 * mezcla de tipos de shot que se muestra en la preview es representativa,
 * no inventada.
 */
import { WORDS_PER_SECOND, VIDEO_TAIL_SECONDS } from "../script-pacing";
import { shotsForSpan, VISUAL_STRATEGIES, type VisualStrategy } from "./shots";
import { getAiVideoCostConfig, type AiVideoCostPreset } from "./ai-video-cost-guard";
import { getPricingConfig } from "@/lib/billing/pricing";
import { ESTIMATED_COST_USD as OPENAI_IMAGE_ESTIMATED_COST_USD } from "@/lib/providers/image/openai";
import type { BeatType, ShotType } from "./types";

export { VISUAL_STRATEGIES };
export type { VisualStrategy };

export const PRODUCTION_PLAN_VERSION = 1;

/**
 * Nombres REALES de los proveedores que usa una corrida "real" de Long
 * Form (ver mode.ts: `pexels-video-first`/`curated-library` son los
 * nombres que esos providers YA reportan, `elevenlabs`/`openai`/`veo` los
 * de voice/image/ai-video reales) — nunca se llama a
 * resolveLongFormProviders("real") aquí porque esa función exige
 * LONG_FORM_REAL_RUN_CONFIRM (gasto real) solo para RESOLVER el objeto,
 * incluso para previsualizar sin llamar a nada. La preview/confirmación
 * son puramente informativas: identifican qué proveedor se usará, no lo
 * invocan.
 */
export const REAL_LONG_FORM_PROVIDER_NAMES = {
  voice: "elevenlabs",
  footage: "pexels-video-first",
  image: "openai",
  aiVideo: "veo",
  music: "curated-library",
} as const;

export const VISUAL_STRATEGY_LABEL: Record<VisualStrategy, string> = {
  economical: "Económico / archivo",
  balanced: "Equilibrado",
  cinematic: "Cinemático / IA",
};

export const VISUAL_STRATEGY_DESCRIPTION: Record<VisualStrategy, string> = {
  economical:
    "Solo material de archivo real (video/imagen), mapas, diagramas y motion graphics — cero llamadas pagadas de imagen o video generado por IA.",
  balanced:
    "Mezcla de archivo real con algunas imágenes generadas por IA donde el archivo no alcanza — sin clips de video IA.",
  cinematic:
    "Mayor proporción de imágenes generadas por IA, más clips de video IA genuino donde el movimiento aporta valor narrativo — nunca 100% del tiempo con video IA.",
};

/** economical/balanced/cinematic → el preset real de ai-video-cost-guard.ts que fija tarifas/topes — nunca un preset inventado aparte. */
export function strategyToAiVideoCostPreset(strategy: VisualStrategy): AiVideoCostPreset {
  if (strategy === "economical") return "economic";
  if (strategy === "cinematic") return "premium";
  return "balanced";
}

export type ProductionPlanBeatInput = {
  id: string;
  type: BeatType;
  narration: string;
};

export type ProductionPlan = {
  version: number;
  strategy: VisualStrategy;
  durationSeconds: number;
  shotCount: number;
  stockVideoCount: number;
  stockImageCount: number;
  aiImageCount: number;
  aiVideoClipCount: number;
  aiVideoSeconds: number;
  deterministicCount: number;
  voiceCharacters: number;
  providers: { voice: string; footage: string; image: string; aiVideo: string; music: string };
  estimatedProviderCostUsd: number;
  /**
   * Todavía no existe un sistema de créditos comercial real (ver Stripe/
   * plans.ts) — nunca se inventa un saldo. `null` es el valor honesto
   * hasta que exista una tarifa créditos↔USD real que confirmar.
   */
  estimatedCredits: number | null;
  confirmedAt: string | null;
};

const AI_VIDEO_SHOT_TYPES = new Set<ShotType>(["ai_video"]);
const AI_IMAGE_SHOT_TYPES = new Set<ShotType>(["generated_placeholder"]);
const STOCK_VIDEO_SHOT_TYPES = new Set<ShotType>(["stock_video"]);
const STOCK_IMAGE_SHOT_TYPES = new Set<ShotType>(["stock_image", "ken_burns_image"]);
const DETERMINISTIC_SHOT_TYPES = new Set<ShotType>(["text", "diagram", "map"]);

/** Estimación de duración narrada — mismo WORDS_PER_SECOND ya calibrado con datos reales, nunca una llamada real a voz. */
export function estimateNarrationSeconds(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, words / WORDS_PER_SECOND);
}

/**
 * Calcula el ProductionPlan completo para un guion ya aprobado + una
 * estrategia visual — determinístico, sin red, sin costo. El worker real
 * (produce.ts) recibe la MISMA estrategia desde el snapshot ya confirmado,
 * nunca recalcula esto por su cuenta.
 */
export function computeProductionPlan(input: {
  beats: ProductionPlanBeatInput[];
  strategy: VisualStrategy;
  providers: { voice: string; footage: string; image: string; aiVideo: string; music: string };
}): ProductionPlan {
  let cursor = 0;
  const shotTypeCounts = new Map<ShotType, { count: number; durationSec: number }>();
  let voiceChars = 0;

  input.beats.forEach((beat, i) => {
    voiceChars += beat.narration.length;
    const beatDurationSec = estimateNarrationSeconds(beat.narration);
    const startSec = cursor;
    const endSec = cursor + beatDurationSec;
    cursor = endSec;

    const shots = shotsForSpan({
      beatId: beat.id,
      beatType: beat.type,
      startSec,
      endSec,
      narration: beat.narration,
      typeOffset: i * 2,
      strategy: input.strategy,
    });
    for (const shot of shots) {
      const bucket = shotTypeCounts.get(shot.type) ?? { count: 0, durationSec: 0 };
      bucket.count += 1;
      bucket.durationSec += shot.durationSec;
      shotTypeCounts.set(shot.type, bucket);
    }
  });

  let shotCount = 0;
  let stockVideoCount = 0;
  let stockImageCount = 0;
  let aiImageCount = 0;
  let aiVideoClipCount = 0;
  let aiVideoSeconds = 0;
  let deterministicCount = 0;
  for (const [type, { count, durationSec }] of shotTypeCounts) {
    shotCount += count;
    if (AI_VIDEO_SHOT_TYPES.has(type)) {
      aiVideoClipCount += count;
      aiVideoSeconds += durationSec;
    } else if (AI_IMAGE_SHOT_TYPES.has(type)) {
      aiImageCount += count;
    } else if (STOCK_VIDEO_SHOT_TYPES.has(type)) {
      stockVideoCount += count;
    } else if (STOCK_IMAGE_SHOT_TYPES.has(type)) {
      stockImageCount += count;
    } else if (DETERMINISTIC_SHOT_TYPES.has(type)) {
      deterministicCount += count;
    }
  }

  const durationSeconds = Math.round(cursor + VIDEO_TAIL_SECONDS);
  const pricing = getPricingConfig();
  const aiVideoCostConfig = getAiVideoCostConfig(strategyToAiVideoCostPreset(input.strategy));

  const voiceCostUsd = (voiceChars / 1000) * pricing.elevenLabsUsdPer1kChars;
  const imageCostUsd = aiImageCount * OPENAI_IMAGE_ESTIMATED_COST_USD;
  const aiVideoCostUsd = aiVideoSeconds * aiVideoCostConfig.aiVideoCostPerSecondUsd;
  const estimatedProviderCostUsd = round4(voiceCostUsd + imageCostUsd + aiVideoCostUsd);

  return {
    version: PRODUCTION_PLAN_VERSION,
    strategy: input.strategy,
    durationSeconds,
    shotCount,
    stockVideoCount,
    stockImageCount,
    aiImageCount,
    aiVideoClipCount,
    aiVideoSeconds: round4(aiVideoSeconds),
    deterministicCount,
    voiceCharacters: voiceChars,
    providers: input.providers,
    estimatedProviderCostUsd,
    estimatedCredits: null,
    confirmedAt: null,
  };
}

export function isProductionPlan(value: unknown): value is ProductionPlan {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ProductionPlan>;
  return (
    typeof v.version === "number" &&
    typeof v.strategy === "string" &&
    (VISUAL_STRATEGIES as readonly string[]).includes(v.strategy) &&
    typeof v.durationSeconds === "number" &&
    typeof v.shotCount === "number" &&
    typeof v.estimatedProviderCostUsd === "number"
  );
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
