/**
 * AI Video Pipeline P2A — corrección de rumbo: comparación Kling 3.0 vs
 * Veo 3.1 Fast sobre el benchmark activo (ai-video-benchmark-v2-active.ts,
 * 2 shots). Reutiliza SIN modificar: ai-video-prompt-builder.ts
 * (buildVideoGenerationRequest), ai-video-eligibility.ts,
 * ai-video-benchmark-cost.ts (estimateBenchmarkClipCost, primitiva
 * per-clip), ai-video-storage.ts (aiVideoClipStoragePath). No duplica
 * ninguna de esas piezas — solo las combina para la matriz 2 shots × 2
 * proveedores que pide P2A sección 4.
 *
 * Política de reintentos de ESTE benchmark comparativo: máximo 1 reintento
 * POR RESULTADO (P2A sección 4) — a diferencia de
 * ai-video-benchmark-cost.ts's `estimateBenchmarkSuiteCost` (que modela UN
 * solo reintento compartido para todo un lote de producción), aquí cada
 * una de las 4 generaciones puede reintentarse independientemente, así que
 * el peor caso duplica el costo de la matriz completa. Se implementa como
 * una función separada (no se modifica estimateBenchmarkSuiteCost) porque
 * el escenario es distinto: una comparación A/B controlada, no un lote de
 * producción.
 */
import { buildVideoGenerationRequest, type VideoPromptBuilderInput } from "./ai-video-prompt-builder";
import { scoreAiVideoEligibility } from "./ai-video-eligibility";
import { estimateBenchmarkClipCost, getMaxBenchmarkBudgetUsd, type BenchmarkCostModel } from "./ai-video-benchmark-cost";
import { aiVideoClipStoragePath } from "./ai-video-storage";
import {
  ACTIVE_BENCHMARK_ID,
  ACTIVE_BENCHMARK_SHOTS,
  activeBenchmarkShotToEligibilityInput,
  type ActiveBenchmarkShotSpec,
} from "./ai-video-benchmark-v2-active";
import type { VideoGenerationRequest } from "@/lib/providers/types";

/**
 * Modelo de costo de Kling 3.0 — fuentes SECUNDARIAS (agregadores de
 * terceros, sep 2026) citan un rango de $0.18 a $1.70 por clip de 5s según
 * el tier del modelo, sin una cifra única confiable para "Kling 3.0"
 * específicamente (ver kling.ts). Se modela como RANGO, nunca como un
 * único número — usar el extremo alto para cualquier cálculo de "peor
 * caso".
 */
export const KLING_COST_MODEL_LOW: BenchmarkCostModel = {
  provider: "kling",
  model: "kling-3.0 (id exacto UNKNOWN, ver kling.ts)",
  costPerSecondUsd: 0.18 / 5, // $0.18 por clip de 5s citado como precio plano, no una tarifa/segundo confirmada — se deriva solo para poder reutilizar estimateBenchmarkClipCost().
  verifiedAgainstPrimaryDocs: false,
};
export const KLING_COST_MODEL_HIGH: BenchmarkCostModel = {
  provider: "kling",
  model: "kling-3.0 (id exacto UNKNOWN, ver kling.ts)",
  costPerSecondUsd: 1.7 / 5,
  verifiedAgainstPrimaryDocs: false,
};

/**
 * Modelo de costo de Veo 3.1 Fast — fuentes secundarias coinciden en
 * $0.15/s CON audio (Veo genera audio nativo; no se confirmó un switch
 * para desactivarlo, ver veo.ts) — mayor consenso entre fuentes que Kling,
 * pero SIGUE siendo secundario, nunca verificado contra ai.google.dev
 * directamente (bloqueado por política de red de este entorno).
 */
export const VEO_COST_MODEL: BenchmarkCostModel = {
  provider: "veo",
  model: "veo-3.1-fast (id exacto UNKNOWN, ver veo.ts)",
  costPerSecondUsd: 0.15,
  verifiedAgainstPrimaryDocs: false,
};

/** Duración de planeación asumida por proveedor — NUNCA se fuerza a coincidir artificialmente (P2A sección 7). Kling: 5s (unidad más citada en fuentes secundarias, UNVERIFICADO). Veo: 8s (consistente entre fuentes secundarias para la familia Veo 3.x, UNVERIFICADO pero con mayor consenso). */
export const KLING_PLANNING_DURATION_SEC = 5;
export const VEO_PLANNING_DURATION_SEC = 8;

export type ComparisonCellCost = {
  shotId: string;
  provider: "kling" | "veo";
  durationSec: number;
  costUsdLow: number;
  costUsdHigh: number;
};

export type ComparisonMatrixCost = {
  benchmarkId: string;
  cells: ComparisonCellCost[];
  totalCostUsdLow: number;
  totalCostUsdHigh: number;
  /** Costo total + 1 reintento POR CADA una de las 4 generaciones (peor caso: 8 intentos totales) — política distinta a la de ai-video-benchmark-cost.ts, ver comentario de cabecera. */
  worstCaseWithOneRetryEachUsdLow: number;
  worstCaseWithOneRetryEachUsdHigh: number;
  ceilingUsd: number;
  withinCeiling: boolean;
};

/** Calcula el costo (rango bajo/alto) de las 4 generaciones iniciales (2 shots x 2 proveedores) y el peor caso con 1 reintento por resultado — nunca gasta, nunca hace red. */
export function estimateComparisonMatrixCost(
  shots: ActiveBenchmarkShotSpec[] = ACTIVE_BENCHMARK_SHOTS,
  ceilingUsd: number = getMaxBenchmarkBudgetUsd(),
): ComparisonMatrixCost {
  const cells: ComparisonCellCost[] = [];
  for (const shot of shots) {
    const klingLow = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec: KLING_PLANNING_DURATION_SEC }, KLING_COST_MODEL_LOW);
    const klingHigh = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec: KLING_PLANNING_DURATION_SEC }, KLING_COST_MODEL_HIGH);
    cells.push({ shotId: shot.shotId, provider: "kling", durationSec: KLING_PLANNING_DURATION_SEC, costUsdLow: klingLow.costUsd, costUsdHigh: klingHigh.costUsd });

    const veo = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec: VEO_PLANNING_DURATION_SEC }, VEO_COST_MODEL);
    cells.push({ shotId: shot.shotId, provider: "veo", durationSec: VEO_PLANNING_DURATION_SEC, costUsdLow: veo.costUsd, costUsdHigh: veo.costUsd });
  }

  const totalCostUsdLow = round4(cells.reduce((sum, c) => sum + c.costUsdLow, 0));
  const totalCostUsdHigh = round4(cells.reduce((sum, c) => sum + c.costUsdHigh, 0));
  // 1 reintento POR CADA resultado -> en el peor caso cada celda se paga hasta 2 veces.
  const worstCaseWithOneRetryEachUsdLow = round4(totalCostUsdLow * 2);
  const worstCaseWithOneRetryEachUsdHigh = round4(totalCostUsdHigh * 2);

  return {
    benchmarkId: ACTIVE_BENCHMARK_ID,
    cells,
    totalCostUsdLow,
    totalCostUsdHigh,
    worstCaseWithOneRetryEachUsdLow,
    worstCaseWithOneRetryEachUsdHigh,
    ceilingUsd,
    withinCeiling: worstCaseWithOneRetryEachUsdHigh <= ceilingUsd,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export type ProviderShotPrep = {
  shot: ActiveBenchmarkShotSpec;
  provider: "kling" | "veo";
  candidateModel: string;
  durationSec: number;
  targetResolution: string;
  audioNote: string;
  normalizedRequest: VideoGenerationRequest;
  /** El request EXACTO del proveedor (endpoint/headers/payload JSON) NO se incluye — no está verificado contra doc primaria (ver kling.ts/veo.ts). Se expone solo el VideoGenerationRequest normalizado, provider-agnóstico. */
  exactProviderRequestStatus: "not_available_contract_unverified";
  eligibility: ReturnType<typeof scoreAiVideoEligibility>;
  costEstimateUsdLow: number;
  costEstimateUsdHigh: number;
  costVerifiedAgainstPrimaryDocs: boolean;
  timeoutMs: number;
  retryPolicy: string;
  storagePathIfGenerated: string;
  validationNote: string;
  successCriteria: string[];
};

/** Prepara (nunca ejecuta) la generación de un shot del benchmark activo contra un proveedor dado. */
export function buildProviderShotPrep(shot: ActiveBenchmarkShotSpec, provider: "kling" | "veo"): ProviderShotPrep {
  const durationSec = provider === "kling" ? KLING_PLANNING_DURATION_SEC : VEO_PLANNING_DURATION_SEC;
  const costModel = provider === "kling" ? KLING_COST_MODEL_HIGH : VEO_COST_MODEL;
  const costLow = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec }, provider === "kling" ? KLING_COST_MODEL_LOW : VEO_COST_MODEL);
  const costHigh = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec }, costModel);

  const eligibility = scoreAiVideoEligibility(activeBenchmarkShotToEligibilityInput(shot));

  const promptInput: VideoPromptBuilderInput = {
    visualIntent: shot.visualIntent,
    motionDescription: shot.motionDescription,
    negativeSignals: shot.negativeConstraints,
    // NO se genera todavía — ver shot.referenceImageSpec.status==="not_generated". Se deja explícitamente undefined, nunca un valor inventado.
    referenceImageUrl: undefined,
    durationSeconds: durationSec,
    aspectRatio: shot.aspectRatio,
    maxCostUsd: costHigh.costUsd,
    metadata: {
      benchmarkId: shot.benchmarkId,
      shotId: shot.shotId,
      provider,
      historicalClassification: shot.historicalClassification,
      targetResolution: "1080p",
      mode: "image-to-video",
    },
  };
  const normalizedRequest = buildVideoGenerationRequest(promptInput);

  return {
    shot,
    provider,
    candidateModel: costModel.model,
    durationSec,
    targetResolution: "1080p",
    audioNote:
      provider === "veo"
        ? "Veo genera audio nativo; no se confirmó un parámetro para desactivarlo (UNKNOWN) — ATOMIVID descarta/reemplaza ese audio en montaje, nunca se inventa un switch."
        : "preferentemente sin audio, si la API de Kling lo soporta explícitamente (UNVERIFICADO) — si no, se trata igual que Veo (descartar/reemplazar en montaje).",
    normalizedRequest,
    exactProviderRequestStatus: "not_available_contract_unverified",
    eligibility,
    costEstimateUsdLow: costLow.costUsd,
    costEstimateUsdHigh: costHigh.costUsd,
    costVerifiedAgainstPrimaryDocs: false,
    timeoutMs: 180000,
    retryPolicy:
      "intento 1 -> proveedor; si falla, máximo 1 reintento (mismo proveedor); si vuelve a fallar -> se reporta como fallo de ESTE benchmark comparativo (no hay fallback automático a otro tier, a diferencia del pipeline de producción — un fallo aquí es un resultado de la comparación en sí).",
    storagePathIfGenerated: aiVideoClipStoragePath(shot.benchmarkId, shot.shotId, `${provider}-<idempotencyKey>`, "mp4"),
    validationNote:
      "validateVideoAssetBuffer() (ai-video-validation.ts, sin modificar) aplicaría igual que en producción: formato mp4/webm real, tamaño no vacío, duración/dimensiones declaradas dentro de rango razonable.",
    successCriteria: [
      "generationSuccess=true (el proveedor devuelve un asset)",
      "validateVideoAssetBuffer() -> valid=true",
      `duración cercana a los ${durationSec}s soportados por ${provider} (UNVERIFICADO, ver ${provider}.ts)`,
      "resolución efectiva 1080p si el proveedor lo confirma en la respuesta",
      "revisión humana: promptAdherence>=3/5 y (para bench-v2-a) humanAnatomyQuality>=3/5, o (para bench-v2-b) referenceConsistency>=3/5",
      "costo real <= costEstimateUsdHigh, o documentado por qué lo excede",
    ],
  };
}
