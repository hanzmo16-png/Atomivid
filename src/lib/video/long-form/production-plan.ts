/**
 * ProductionPlan de Long Form — cálculo PURO (sin red, sin gastar) que se
 * muestra antes de la confirmación y cuyo snapshot el worker ejecuta.
 *
 * Plan = ejecución: la vista previa y el worker usan la MISMA función de
 * asignación (`allocateShotTypes`) — elegibilidad de video IA por
 * contenido, cost guard, topes de imagen/USD — sobre los mismos shots
 * (mismo `shotsForSpan` con las mismas intenciones visuales). La única
 * diferencia es la duración: aquí se estima por palabras (sin llamar a
 * ElevenLabs), en el worker es la real. Por eso el worker además limita
 * todo a la `allocation` confirmada: los conteos nunca la exceden.
 *
 * Tarifas: siempre las fuentes reales ya existentes — voz
 * (billing/pricing.ts), imagen (providers/image/openai.ts), Veo
 * (providers/video-gen/veo.ts, que factura clips de duración fija).
 */
import { createHash } from "node:crypto";
import { VIDEO_TAIL_SECONDS } from "../script-pacing";
import { LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";
import { getFeatureFlags, type FeatureFlags } from "../feature-flags";
import { shotsForSpan, type VisualStrategy } from "./shots";
import {
  assertAiVideoBudget,
  emptyAiVideoLedgerState,
  getAiVideoCostConfig,
  recordAiVideoSpend,
  type AiVideoCostConfig,
  type AiVideoCostPreset,
} from "./ai-video-cost-guard";
import { scoreAiVideoEligibility } from "./ai-video-eligibility";
import { getLongFormBudget, type LongFormBudget } from "./cost";
import { visualsForBeat } from "./visual-intents";
import { getPricingConfig } from "@/lib/billing/pricing";
import { ESTIMATED_COST_USD as OPENAI_IMAGE_ESTIMATED_COST_USD } from "@/lib/providers/image/openai";
import { VEO_DURATION_SECONDS_1080P, getVeoCostUsdPerSecond } from "@/lib/providers/video-gen/veo";
import type { BeatType, Shot, ShotType } from "./types";
import {
  PRODUCTION_PLAN_VERSION,
  isExecutablePlanVersion as isExecutablePlanVersionValue,
  isProductionPlan as isProductionPlanValue,
  type ProductionPlan,
  type ProductionPlanAllocation,
} from "./production-plan-types";

export * from "./production-plan-types";

/**
 * Nombres reales de los proveedores de una corrida "real" (ver mode.ts) —
 * informativos: nunca se llama a resolveLongFormProviders("real") aquí
 * porque exige LONG_FORM_REAL_RUN_CONFIRM solo para resolverlos.
 */
export const REAL_LONG_FORM_PROVIDER_NAMES = {
  voice: "elevenlabs",
  footage: "pexels-video-first",
  image: "openai",
  aiVideo: "veo",
  music: "curated-library",
} as const;

export function strategyToAiVideoCostPreset(strategy: VisualStrategy): AiVideoCostPreset {
  if (strategy === "economical") return "economic";
  if (strategy === "cinematic") return "premium";
  return "balanced";
}

export type ProductionPlanBeatInput = {
  id: string;
  type: BeatType;
  narration: string;
  /** `visuals` declarados por el guionista (ver documentary-script.ts) — opcional, se valida en visual-intents.ts. */
  visuals?: unknown;
};

export function estimateNarrationSeconds(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  // Ritmo CALIBRADO de Long Form (2.5 palabras/s, medido en producción) —
  // no el 2.8 de Reel, que subestimó ~10% la duración del Canal de Panamá.
  return Math.max(1, words / LONG_FORM_NARRATION_WORDS_PER_SECOND);
}

/** Hash estable del guion confirmado (id + narración + visuales por beat). */
export function computeScriptHash(beats: ProductionPlanBeatInput[]): string {
  const canonical = JSON.stringify(beats.map((b) => ({ id: b.id, narration: b.narration, visuals: b.visuals ?? null })));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export type GenerativeUnitCosts = {
  imageUsd: number;
  veoClipUsd: number;
  veoBilledSeconds: number;
};

export function getGenerativeUnitCosts(): GenerativeUnitCosts {
  return {
    imageUsd: OPENAI_IMAGE_ESTIMATED_COST_USD,
    veoClipUsd: round4(VEO_DURATION_SECONDS_1080P * getVeoCostUsdPerSecond()),
    veoBilledSeconds: VEO_DURATION_SECONDS_1080P,
  };
}

/** Video IA solo es alcanzable si los tres interruptores existentes están alineados (ver feature-flags.ts / video-gen/index.ts). */
export function isLongFormAiVideoConfigured(flags: FeatureFlags = getFeatureFlags()): boolean {
  return flags.longFormAiVideoEnabled && flags.premiumClipsEnabled && flags.videoProvider === "veo";
}

export type AllocationLimits = {
  maxAiImageGenerations: number;
  maxAiVideoClips: number;
  maxGenerativeUsd: number;
  aiVideoEnabled: boolean;
  aiVideoCostConfig: AiVideoCostConfig;
  units: GenerativeUnitCosts;
};

/** Topes por estrategia (antes de aplicar el snapshot confirmado). */
export function strategyLimits(
  strategy: VisualStrategy,
  voiceCostUsd: number,
  opts: { aiVideoEnabled?: boolean; budget?: LongFormBudget; units?: GenerativeUnitCosts } = {},
): AllocationLimits {
  const budget = opts.budget ?? getLongFormBudget();
  const units = opts.units ?? getGenerativeUnitCosts();
  const presetConfig = getAiVideoCostConfig(strategyToAiVideoCostPreset(strategy));
  // El cost guard compara contra la tarifa REAL de Veo (clip de duración fija), nunca contra la tarifa genérica del preset.
  const aiVideoCostConfig: AiVideoCostConfig = { ...presetConfig, aiVideoCostPerSecondUsd: units.veoClipUsd / units.veoBilledSeconds };
  const imagesByBudget = units.imageUsd > 0 ? Math.floor(budget.maxImageUsd / units.imageUsd) : 0;
  const aiVideoEnabled = strategy === "cinematic" && (opts.aiVideoEnabled ?? isLongFormAiVideoConfigured());
  return {
    maxAiImageGenerations: strategy === "economical" ? 0 : imagesByBudget,
    maxAiVideoClips: aiVideoEnabled ? presetConfig.maxClips : 0,
    maxGenerativeUsd: Math.max(0, round4(budget.maxTotalUsd - voiceCostUsd)),
    aiVideoEnabled,
    aiVideoCostConfig,
    units,
  };
}

/** Aplica el snapshot confirmado sobre los topes del entorno — el mínimo de ambos, nunca más que lo confirmado. */
export function limitsWithinAllocation(limits: AllocationLimits, allocation: ProductionPlanAllocation): AllocationLimits {
  return {
    ...limits,
    maxAiImageGenerations: Math.min(limits.maxAiImageGenerations, allocation.maxAiImageGenerations),
    maxAiVideoClips: Math.min(limits.maxAiVideoClips, allocation.maxAiVideoClips),
    maxGenerativeUsd: Math.min(limits.maxGenerativeUsd, allocation.maxGenerativeUsd),
    aiVideoEnabled: limits.aiVideoEnabled && allocation.maxAiVideoClips > 0,
  };
}

export type AllocatedShot = Shot & { plannedType: ShotType; degradeReason?: string };

export type AllocationResult = {
  shots: AllocatedShot[];
  stockVideoCount: number;
  stockImageCount: number;
  aiImageCount: number;
  aiVideoClipCount: number;
  aiVideoSeconds: number;
  textCount: number;
  aiImageGenerations: number;
  imageUsd: number;
  aiVideoUsd: number;
};

/**
 * Decide el tipo EJECUTADO de cada shot, en orden (determinístico):
 * - ranura "ai_video": solo si el contenido lo justifica (eligibility por
 *   intención visual + movimiento), cabe en el cost guard del preset, en
 *   el tope de clips/USD y hay imagen de referencia disponible; si no →
 *   imagen IA con movimiento si el tope de imágenes lo permite, si no →
 *   archivo con Ken Burns.
 * - "generated_placeholder": imagen IA solo si cabe en los topes; si no →
 *   archivo con Ken Burns.
 * Nunca asciende un shot a un tipo más caro.
 */
export function allocateShotTypes(shots: Shot[], totalDurationSec: number, limits: AllocationLimits): AllocationResult {
  let ledger = emptyAiVideoLedgerState();
  let aiImageGenerations = 0;
  let imageUsd = 0;
  let aiVideoUsd = 0;
  const out: AllocatedShot[] = [];

  const canAffordImage = () =>
    aiImageGenerations + 1 <= limits.maxAiImageGenerations &&
    imageUsd + aiVideoUsd + limits.units.imageUsd <= limits.maxGenerativeUsd + 1e-9;

  for (const shot of shots) {
    if (shot.type === "ai_video") {
      let reason: string | undefined;
      if (!limits.aiVideoEnabled || limits.maxAiVideoClips <= 0) {
        reason = "video IA no habilitado para esta estrategia/entorno";
      } else {
        const eligibility = scoreAiVideoEligibility(
          { id: shot.id, visualIntent: shot.visualIntent, durationSec: shot.durationSec, type: "ai_video", motionRequired: shot.motionRequired },
          limits.aiVideoCostConfig,
        );
        const clipCost = limits.units.veoClipUsd;
        if (eligibility.recommendedAssetType !== "ai_video") {
          reason = `el contenido no justifica video IA (${eligibility.reason})`;
        } else if (ledger.usedClips + 1 > limits.maxAiVideoClips) {
          reason = "tope de clips de video IA alcanzado";
        } else if (aiImageGenerations + 1 > limits.maxAiImageGenerations) {
          reason = "sin imagen de referencia disponible dentro del tope de imágenes";
        } else if (imageUsd + aiVideoUsd + limits.units.imageUsd + clipCost > limits.maxGenerativeUsd + 1e-9) {
          reason = "excedería el tope de costo generativo";
        } else {
          const decision = assertAiVideoBudget(ledger, shot.durationSec, clipCost, totalDurationSec, limits.aiVideoCostConfig);
          if (!decision.allowed) reason = decision.reason;
        }
        if (!reason) {
          ledger = recordAiVideoSpend(ledger, shot.durationSec, clipCost);
          aiImageGenerations += 1;
          imageUsd += limits.units.imageUsd;
          aiVideoUsd += clipCost;
          out.push({ ...shot, plannedType: "ai_video" });
          continue;
        }
      }
      if (canAffordImage()) {
        aiImageGenerations += 1;
        imageUsd += limits.units.imageUsd;
        out.push({ ...shot, type: "generated_placeholder", motion: "ken_burns", plannedType: "ai_video", degradeReason: reason });
      } else {
        out.push({ ...shot, type: "ken_burns_image", motion: "ken_burns", source: "stock", plannedType: "ai_video", degradeReason: reason });
      }
      continue;
    }
    if (shot.type === "generated_placeholder") {
      if (canAffordImage()) {
        aiImageGenerations += 1;
        imageUsd += limits.units.imageUsd;
        out.push({ ...shot, plannedType: shot.type });
      } else {
        out.push({ ...shot, type: "ken_burns_image", motion: "ken_burns", source: "stock", plannedType: shot.type, degradeReason: "tope de imágenes IA alcanzado" });
      }
      continue;
    }
    out.push({ ...shot, plannedType: shot.type });
  }

  const count = (types: ShotType[]) => out.filter((s) => types.includes(s.type)).length;
  return {
    shots: out,
    stockVideoCount: count(["stock_video"]),
    stockImageCount: count(["stock_image", "ken_burns_image"]),
    aiImageCount: count(["generated_placeholder"]),
    aiVideoClipCount: ledger.usedClips,
    aiVideoSeconds: round4(ledger.usedSeconds),
    textCount: count(["text", "diagram", "map"]),
    aiImageGenerations,
    imageUsd: round4(imageUsd),
    aiVideoUsd: round4(aiVideoUsd),
  };
}

/** Shots de producto de un guion con duraciones ESTIMADAS (misma forma que produce timeline.ts con duraciones reales). */
export function planShotsFromScript(
  beats: ProductionPlanBeatInput[],
  topic: string,
  strategy: VisualStrategy,
  /** true (planes v3+) = escenas ancladas a su pasaje narrado; false = reparto histórico (v1/v2). */
  anchored = true,
): { shots: Shot[]; narrationSeconds: number } {
  let cursor = 0;
  const shots: Shot[] = [];
  beats.forEach((beat, i) => {
    const startSec = cursor;
    const endSec = cursor + estimateNarrationSeconds(beat.narration);
    cursor = endSec;
    shots.push(
      ...shotsForSpan({
        beatId: beat.id,
        beatType: beat.type,
        startSec,
        endSec,
        narration: beat.narration,
        typeOffset: i * 2,
        strategy,
        visuals: visualsForBeat(beat, topic),
        anchoring: anchored ? {} : undefined,
      }),
    );
  });
  return { shots, narrationSeconds: cursor };
}

export function computeProductionPlan(input: {
  beats: ProductionPlanBeatInput[];
  topic?: string;
  strategy: VisualStrategy;
  providers: { voice: string; footage: string; image: string; aiVideo: string; music: string };
  /** Solo para pruebas/demo: fuerza la disponibilidad de video IA en vez de leer las flags del entorno. */
  aiVideoEnabled?: boolean;
  /** Duración pedida por el usuario (video_requests.duration_seconds). */
  requestedDurationSeconds?: number;
}): ProductionPlan {
  const topic = input.topic ?? "";
  const { shots, narrationSeconds } = planShotsFromScript(input.beats, topic, input.strategy);
  const voiceCharacters = input.beats.reduce((sum, b) => sum + b.narration.length, 0);
  const voiceCostUsd = round4((voiceCharacters / 1000) * getPricingConfig().elevenLabsUsdPer1kChars);
  const aiVideoAvailable = input.aiVideoEnabled ?? isLongFormAiVideoConfigured();
  const limits = strategyLimits(input.strategy, voiceCostUsd, { aiVideoEnabled: aiVideoAvailable });
  const allocation = allocateShotTypes(shots, narrationSeconds, limits);
  const generativeUsd = round4(allocation.imageUsd + allocation.aiVideoUsd);

  return {
    version: PRODUCTION_PLAN_VERSION,
    strategy: input.strategy,
    durationSeconds: Math.round(narrationSeconds + VIDEO_TAIL_SECONDS),
    shotCount: allocation.shots.length,
    stockVideoCount: allocation.stockVideoCount,
    stockImageCount: allocation.stockImageCount,
    aiImageCount: allocation.aiImageCount,
    aiVideoClipCount: allocation.aiVideoClipCount,
    aiVideoSeconds: allocation.aiVideoSeconds,
    aiVideoBilledSeconds: allocation.aiVideoClipCount * limits.units.veoBilledSeconds,
    deterministicCount: allocation.textCount,
    voiceCharacters,
    scriptHash: computeScriptHash(input.beats),
    beatShotCounts: allocation.shots.reduce<Record<string, number>>((acc, shot) => {
      acc[shot.beatId] = (acc[shot.beatId] ?? 0) + 1;
      return acc;
    }, {}),
    requestedDurationSeconds: input.requestedDurationSeconds,
    aiVideoAvailable: input.strategy === "cinematic" ? aiVideoAvailable : undefined,
    providers: input.providers,
    estimatedVoiceCostUsd: voiceCostUsd,
    estimatedImageCostUsd: allocation.imageUsd,
    estimatedAiVideoCostUsd: allocation.aiVideoUsd,
    estimatedProviderCostUsd: round4(voiceCostUsd + generativeUsd),
    allocation: {
      maxAiImageGenerations: allocation.aiImageGenerations,
      maxAiVideoClips: allocation.aiVideoClipCount,
      maxGenerativeUsd: generativeUsd,
    },
    estimatedCredits: null,
    confirmedAt: null,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class LongFormPlanNotExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongFormPlanNotExecutableError";
  }
}

/**
 * Valida el snapshot confirmado ANTES de cualquier llamada pagada — nunca
 * cae a una estrategia por defecto ni recalcula otro plan en silencio.
 */
export function resolveExecutablePlan(input: {
  confirmedAt: string | null;
  plan: unknown;
  beats: ProductionPlanBeatInput[];
}): ProductionPlan {
  if (!input.confirmedAt) {
    throw new LongFormPlanNotExecutableError("Esta producción de Long Form no tiene una confirmación humana registrada. No se ejecutará.");
  }
  if (!isProductionPlanValue(input.plan)) {
    throw new LongFormPlanNotExecutableError("El plan de producción confirmado falta o es inválido — no se ejecuta un plan por defecto.");
  }
  const plan = input.plan;
  if (!isExecutablePlanVersionValue(plan.version)) {
    throw new LongFormPlanNotExecutableError(`El plan de producción usa una versión (${plan.version}) que este worker no sabe ejecutar de forma segura.`);
  }
  const chars = input.beats.reduce((sum, b) => sum + b.narration.length, 0);
  const scriptChanged = plan.scriptHash ? plan.scriptHash !== computeScriptHash(input.beats) : plan.voiceCharacters !== chars;
  if (scriptChanged) {
    throw new LongFormPlanNotExecutableError("El guion cambió después de confirmar el plan de producción — no se ejecuta un plan distinto al confirmado.");
  }
  return plan;
}
