/**
 * P2A sección 10 — PREPARA (nunca ejecuta) la primera generación real
 * candidata del Benchmark Suite. Construye el paquete completo (shot,
 * prompt normalizado, proveedor/modelo candidato, duración, costo
 * estimado, retry policy, fallback, criterios de éxito) usando SOLO los
 * módulos puros ya existentes (eligibility, prompt builder, cost
 * estimation) — nunca importa ni llama a ningún VideoProvider real.
 */
import { buildVideoGenerationRequest, type VideoPromptBuilderInput } from "./ai-video-prompt-builder";
import { scoreAiVideoEligibility } from "./ai-video-eligibility";
import { estimateBenchmarkClipCost, type BenchmarkCostModel } from "./ai-video-benchmark-cost";
import { GOBEKLI_TEPE_BENCHMARK_SHOTS, benchmarkShotToEligibilityInput, type BenchmarkShotSpec } from "./ai-video-benchmark-manifest";
import { getAiVideoCostConfig } from "./ai-video-cost-guard";
import type { VideoGenerationRequest } from "@/lib/providers/types";

/**
 * Shot recomendado para la PRIMERA prueba real: "Stone Carving" (bench-a).
 * Razonamiento (P2A sección 10 — ni trivial ni tan complejo que un fallo
 * sea inútil):
 *   - Acotado a 2-3 figuras y UNA acción focal (interacción mano/herramienta
 *     contra piedra) — a diferencia de B/D (grupo grande, física de peso,
 *     múltiples acciones simultáneas), un fallo aquí señala algo concreto
 *     (fidelidad de manos/herramientas), no un cúmulo de variables.
 *   - Ya ejercita las señales más difíciles de un modelo de video-IA
 *     (anatomía humana en primer plano, contacto físico objeto-mano,
 *     consistencia temporal en movimiento repetitivo) sin la complejidad
 *     adicional de una escena de multitud (B/D/E) o una toma de cámara
 *     larga con reveal arquitectónico (E).
 *   - Si esta prueba falla, el motivo es interpretable (anatomía/artefactos
 *     en primer plano); si pasa, da señal razonable de que el resto del
 *     benchmark (menos exigente en anatomía en primer plano) es viable.
 */
export const RECOMMENDED_FIRST_BENCHMARK_SHOT_ID = "bench-a-stone-carving";

export const FIRST_GENERATION_RATIONALE: string[] = [
  "Acotado a 2-3 figuras y una acción focal (mano/herramienta contra piedra) — un fallo señala algo concreto, no un cúmulo de variables.",
  "Ejercita las señales más difíciles para un modelo de video-IA (anatomía humana en primer plano, contacto físico, consistencia temporal) sin la complejidad adicional de una escena de multitud.",
  "Resultado interpretable en ambos sentidos: si falla, se sabe qué revisar (anatomía/artefactos); si pasa, da señal razonable sobre el resto del benchmark.",
];

/** Candidato de proveedor/modelo para P2A — Runway (gen4_turbo), el único VideoProvider real ya implementado (ver runway.ts). UNVERIFICADO contra documentación primaria (ver informe P2A sección A): docs.dev.runwayml.com y todo el dominio runwayml.com están bloqueados por política de red de este entorno. */
export const CANDIDATE_PROVIDER_MODEL = {
  provider: "runway",
  model: "gen4_turbo",
  verifiedAgainstPrimaryDocs: false,
  verificationNote:
    "docs.dev.runwayml.com, dev.runwayml.com y runwayml.com están bloqueados por el proxy de red de este entorno (confirmado en P1 y de nuevo en P2A) — modelo/precio/duraciones vienen de runway.ts, ya marcados UNVERIFICADO ahí. No se cambia nada aquí basado en fuentes secundarias/blogs.",
};

export type FirstGenerationPrep = {
  shot: BenchmarkShotSpec;
  normalizedRequest: VideoGenerationRequest;
  eligibility: ReturnType<typeof scoreAiVideoEligibility>;
  candidateProvider: string;
  candidateModel: string;
  costEstimateUsd: number;
  costEstimateVerified: boolean;
  retryPolicy: string;
  fallbackChain: string[];
  successCriteria: string[];
  rationale: string[];
};

/** Construye el paquete completo de preparación — pura, sin red, sin llamar a ningún VideoProvider. */
export function buildFirstGenerationPrep(
  costModel: BenchmarkCostModel = {
    provider: CANDIDATE_PROVIDER_MODEL.provider,
    model: CANDIDATE_PROVIDER_MODEL.model,
    costPerSecondUsd: getAiVideoCostConfig("balanced").aiVideoCostPerSecondUsd,
    verifiedAgainstPrimaryDocs: false,
  },
): FirstGenerationPrep {
  const shot = GOBEKLI_TEPE_BENCHMARK_SHOTS.find((s) => s.shotId === RECOMMENDED_FIRST_BENCHMARK_SHOT_ID);
  if (!shot) throw new Error(`buildFirstGenerationPrep: shot "${RECOMMENDED_FIRST_BENCHMARK_SHOT_ID}" no está en el manifest.`);

  const eligibility = scoreAiVideoEligibility(benchmarkShotToEligibilityInput(shot));
  const costEstimate = estimateBenchmarkClipCost(shot, costModel);

  const promptInput: VideoPromptBuilderInput = {
    visualIntent: shot.visualIntent,
    motionDescription: shot.motionDescription,
    negativeSignals: shot.negativeConstraints,
    durationSeconds: shot.durationSec,
    aspectRatio: shot.aspectRatio,
    maxCostUsd: costEstimate.costUsd,
    metadata: { benchmarkId: shot.benchmarkId, shotId: shot.shotId, historicalClassification: shot.historicalClassification },
  };
  const normalizedRequest = buildVideoGenerationRequest(promptInput);

  return {
    shot,
    normalizedRequest,
    eligibility,
    candidateProvider: costModel.provider,
    candidateModel: costModel.model,
    costEstimateUsd: costEstimate.costUsd,
    costEstimateVerified: costModel.verifiedAgainstPrimaryDocs,
    retryPolicy: "intento 1 -> Runway; si falla, intento 2 (mismo proveedor, 1 reintento máximo); si vuelve a fallar -> fallback, nunca un tercer intento (ver ai-video-resolver.ts, maxRetries:0 a nivel adapter — el reintento vive en el llamador, no dentro de runway.ts, para no duplicar tareas pagas por error).",
    fallbackChain: eligibility.fallback,
    successCriteria: [
      "generationSuccess=true (el proveedor devuelve un asset, sin excepción)",
      "validateVideoAssetBuffer() -> valid=true (formato mp4/webm real, no el placeholder del fixture)",
      "durationSeconds declarada dentro de rango razonable (ver ai-video-validation.ts, 0.5-60s) y cercana a los 5s pedidos",
      "aspectRatio efectivamente 16:9",
      "costUsd real <= costEstimateUsd (o, si lo excede, documentado por qué)",
      "revisión humana: promptAdherence>=3/5 y humanAnatomyQuality>=3/5 (ver ai-video-evaluation.ts) — sin esto el clip no se considera 'usable'",
    ],
    rationale: FIRST_GENERATION_RATIONALE,
  };
}
