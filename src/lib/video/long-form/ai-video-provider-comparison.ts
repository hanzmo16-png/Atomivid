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
import { evaluateBenchmarkExecutionGate, type BenchmarkExecutionGateDecision } from "./ai-video-benchmark-execution-gate";
import { getFeatureFlags } from "../feature-flags";
import { veoVideoProvider, VEO_MODEL, getVeoCostUsdPerSecond, VEO_DURATION_SECONDS_1080P } from "@/lib/providers/video-gen/veo";
import { klingVideoProvider } from "@/lib/providers/video-gen/kling";
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
 * Modelo de costo de Veo 3.1 Fast — ACTUALIZADO en P2A.5 con el precio
 * OFICIAL citado por Hans contra ai.google.dev/gemini-api/docs/pricing
 * ($0.12/s a 1080p): $0.12 × 8s = $0.96/clip. `costPerSecondUsd`/modelo se
 * IMPORTAN de veo.ts (fuente única, ver P2A.5 sección 9 "debe quedar
 * centralizado") — nunca se duplica el número aquí. Claude no pudo
 * re-verificar esto de forma independiente en este entorno (ai.google.dev
 * sigue bloqueado, EGRESS_BLOCKED) — se trata como confirmado por Hans,
 * no como una suposición propia; ver comentario de cabecera de veo.ts.
 */
export const VEO_COST_MODEL: BenchmarkCostModel = {
  provider: "veo",
  model: VEO_MODEL,
  costPerSecondUsd: getVeoCostUsdPerSecond(),
  verifiedAgainstPrimaryDocs: true,
  sourceNote:
    "Confirmado por Hans (P2A.5) contra https://ai.google.dev/gemini-api/docs/pricing — Claude no pudo re-verificar " +
    "directamente en este entorno (ai.google.dev bloqueado por política de red, EGRESS_BLOCKED). Si la doc en vivo " +
    "difiere, corregir aquí y en veo.ts, nunca sobrescribir en silencio.",
};

/** Duración de planeación asumida por proveedor — NUNCA se fuerza a coincidir artificialmente (P2A sección 7). Kling: 5s (unidad más citada en fuentes secundarias, UNVERIFICADO). Veo: 8s (OFICIAL para 1080p, ver veo.ts — VEO_DURATION_SECONDS_1080P es la fuente única). */
export const KLING_PLANNING_DURATION_SEC = 5;
export const VEO_PLANNING_DURATION_SEC = VEO_DURATION_SECONDS_1080P;

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
  /** Decisión REAL del gate de ejecución (ai-video-benchmark-execution-gate.ts) evaluada con el estado actual del repo — siempre `allowed:false` en P2A.5 (ninguna imagen de referencia aprobada todavía, LONG_FORM_AI_VIDEO_ENABLED=false, sin proveedor real configurado). Confirma que el gate funciona sin tener que ejecutarlo de verdad. */
  executionGate: BenchmarkExecutionGateDecision;
};

/** Override opcional del prompt — para P2A.5 sección 13, donde el texto EXACTO del prompt final (Pillar Transport x Veo) viene dado, no derivado de visualIntent/motionDescription genéricos. */
export type PromptOverride = { prompt: string; negativeSignals: string[] };

function currentProviderConfigured(provider: "kling" | "veo"): boolean {
  return provider === "kling" ? klingVideoProvider.isAvailable() : veoVideoProvider.isAvailable();
}

/** Prepara (nunca ejecuta) la generación de un shot del benchmark activo contra un proveedor dado. */
export function buildProviderShotPrep(shot: ActiveBenchmarkShotSpec, provider: "kling" | "veo", promptOverride?: PromptOverride): ProviderShotPrep {
  const durationSec = provider === "kling" ? KLING_PLANNING_DURATION_SEC : VEO_PLANNING_DURATION_SEC;
  const costModel = provider === "kling" ? KLING_COST_MODEL_HIGH : VEO_COST_MODEL;
  const costLow = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec }, provider === "kling" ? KLING_COST_MODEL_LOW : VEO_COST_MODEL);
  const costHigh = estimateBenchmarkClipCost({ shotId: shot.shotId, durationSec }, costModel);

  const eligibility = scoreAiVideoEligibility(activeBenchmarkShotToEligibilityInput(shot));

  const promptInput: VideoPromptBuilderInput = {
    visualIntent: promptOverride?.prompt ?? shot.visualIntent,
    motionDescription: promptOverride ? undefined : shot.motionDescription,
    negativeSignals: promptOverride?.negativeSignals ?? shot.negativeConstraints,
    // NO se genera todavía — ver shot.referenceImageSpec.status. Se deja explícitamente undefined, nunca un valor inventado.
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

  const executionGate = evaluateBenchmarkExecutionGate({
    referenceImageStatus: shot.referenceImageSpec.status,
    longFormAiVideoEnabled: getFeatureFlags().longFormAiVideoEnabled,
    explicitBenchmarkExecutionMode: false, // esta función NUNCA ejecuta — siempre false aquí, por diseño (P2A.5 sección 12).
    costGuardAllowed: costHigh.costUsd <= getMaxBenchmarkBudgetUsd(),
    providerConfigured: currentProviderConfigured(provider),
  });

  return {
    shot,
    provider,
    candidateModel: costModel.model,
    durationSec,
    targetResolution: "1080p",
    audioNote:
      provider === "veo"
        ? "Veo genera audio SIEMPRE (confirmado por Hans, P2A.5) — no existe parámetro documentado para desactivarlo. GenerativeAsset.sourceHasGeneratedAudio=true deja constancia; ATOMIVID descarta/reemplaza ese audio en montaje, nunca se inventa un switch de la API."
        : "preferentemente sin audio, si la API de Kling lo soporta explícitamente (UNVERIFICADO) — si no, se trata igual que Veo (descartar/reemplazar en montaje).",
    normalizedRequest,
    // Incluso para Veo (contrato ya implementado en veo.ts) esto se deja en
    // "not_available_contract_unverified": el request EXACTO que enviaría
    // veo.ts es reconstruible leyendo ese archivo, pero sus nombres de
    // campo JSON no están confirmados letra por letra contra la doc en
    // vivo en este entorno (ver comentario de cabecera de veo.ts) — nunca
    // se presenta como "el payload confirmado".
    exactProviderRequestStatus: "not_available_contract_unverified",
    eligibility,
    costEstimateUsdLow: costLow.costUsd,
    costEstimateUsdHigh: costHigh.costUsd,
    costVerifiedAgainstPrimaryDocs: provider === "veo" ? true : false,
    timeoutMs: 180000,
    retryPolicy:
      "intento 1 -> proveedor; si falla, máximo 1 reintento (mismo proveedor); si vuelve a fallar -> se reporta como fallo de ESTE benchmark comparativo (no hay fallback automático a otro tier, a diferencia del pipeline de producción — un fallo aquí es un resultado de la comparación en sí).",
    storagePathIfGenerated: aiVideoClipStoragePath(shot.benchmarkId, shot.shotId, `${provider}-<idempotencyKey>`, "mp4"),
    validationNote:
      "validateVideoAssetBuffer() (ai-video-validation.ts, sin modificar) aplicaría igual que en producción: formato mp4/webm real, tamaño no vacío, duración/dimensiones declaradas dentro de rango razonable.",
    successCriteria: [
      "generationSuccess=true (el proveedor devuelve un asset)",
      "validateVideoAssetBuffer() -> valid=true",
      `duración = ${durationSec}s`,
      "aspectRatio efectivamente 16:9",
      "resolución efectiva 1080p si el proveedor lo confirma en la respuesta",
      "descarga exitosa y almacenamiento en Atomivid Storage (ai-video-storage.ts) con canonical asset reference",
      "Remotion puede consumir el asset almacenado",
      "revisión humana: manos/anatomía, física, contacto con el pilar/objeto, sensación de peso, object permanence, estabilidad del pilar/entorno, estabilidad de las personas, anacronismos, artifacts, reference fidelity, usableInFinalEdit — sin scoring automático (P2A.5 sección 14)",
      "costo real <= costEstimateUsdHigh, o documentado por qué lo excede",
    ],
    executionGate,
  };
}

/**
 * P2A.5 sección 13 — texto EXACTO del prompt final para Pillar Transport
 * x Veo, dado por Hans, no derivado del `visualIntent`/`motionDescription`
 * genéricos del shot (esos siguen usándose para el Eligibility Engine —
 * ver ai-video-benchmark-v2-active.ts, ya validado en P2A). Las
 * restricciones se integran al negativePrompt normalizado (nunca un campo
 * API separado no confirmado, ver P2A.5 sección 13 y veo.ts).
 */
export const PILLAR_TRANSPORT_VEO_FINAL_PROMPT =
  "A historically plausible Neolithic reconstruction near Göbekli Tepe. A coordinated group of Neolithic people " +
  "carefully moving a massive limestone pillar using ropes and collective human effort. Preserve the exact pillar " +
  "shape, scale, people, clothing, terrain and architectural elements from the approved reference image. Natural " +
  "body mechanics and visible sense of weight. Subtle dust and realistic environmental movement. Controlled camera " +
  "movement only. No cuts. No new people or objects should appear.";

export const PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS = [
  "modern machinery",
  "cranes",
  "vehicles",
  "modern wheels",
  "modern clothing",
  "modern metal tools",
  "sparks",
  "text",
  "logos",
  "fantasy architecture",
  "disappearing people",
  "morphing pillar",
  "changing pillar dimensions",
];

/** La especificación FINAL P2A.5 de Pillar Transport x Veo — prompt exacto de Hans, prep completa, gate evaluado. Nunca ejecuta. */
export function buildPillarTransportVeoFinalSpec(): ProviderShotPrep {
  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport");
  if (!shot) throw new Error("buildPillarTransportVeoFinalSpec: shot Pillar Transport no encontrado en el benchmark activo.");
  return buildProviderShotPrep(shot, "veo", { prompt: PILLAR_TRANSPORT_VEO_FINAL_PROMPT, negativeSignals: PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS });
}
