/**
 * AI Video Pipeline P2A — corrección de rumbo (Kling 3.0 + Veo 3.1 Fast).
 *
 * Los 5 shots de ai-video-benchmark-manifest.ts (v1) se CONSERVAN como
 * biblioteca de pruebas — no se borran ni se modifican. Este módulo define
 * el BENCHMARK ACTIVO de P2A: solo 2 de esos shots (Pillar Transport y
 * Monument/Architecture at Dawn), reformulados para el patrón
 * IMAGE-TO-VIDEO (una imagen de referencia históricamente controlada, no
 * texto puro) y comparados entre dos proveedores (Kling 3.0 primary, Veo
 * 3.1 Fast control).
 *
 * NINGUNA imagen de referencia se genera todavía en este archivo —
 * `referenceImageSpec` describe los REQUISITOS que esa imagen deberá
 * cumplir (arquitectura, vestuario, herramientas, composición, ausencia de
 * objetos modernos, plausibilidad histórica) para que un humano la revise
 * antes de generarla, nunca el resultado en sí.
 */
import type { HistoricalClassification } from "./types";
import type { AiVideoEligibilityInput } from "./ai-video-eligibility";
import type { BenchmarkEvaluationCriterion, BenchmarkExpectedEligibility } from "./ai-video-benchmark-manifest";

export const ACTIVE_BENCHMARK_ID = "gobekli-tepe-ai-video-benchmark-v2-active";

export type ReferenceImageSpec = {
  description: string;
  compositionNotes: string;
  /** Controles que un humano debe verificar en la imagen ANTES de usarla como referencia image-to-video — ninguno se auto-verifica todavía. */
  requiredControls: string[];
  aspectRatio: "16:9";
  /** Siempre "not_generated" en P2A — generar esta imagen implica costo (proveedor de imagen IA) y no está autorizado en esta fase. */
  status: "not_generated";
};

export type ActiveBenchmarkShotSpec = {
  benchmarkId: string;
  shotId: string;
  title: string;
  narrationContext: string;
  visualIntent: string;
  motionDescription: string;
  historicalClassification: HistoricalClassification;
  /** Duración objetivo de PLANEACIÓN — cada proveedor puede requerir una duración distinta y soportada (ver ai-video-provider-comparison.ts, nunca se fuerza a coincidir artificialmente). */
  targetDurationSec: number;
  aspectRatio: "16:9";
  referenceImageSpec: ReferenceImageSpec;
  negativeConstraints: string[];
  expectedEligibility: BenchmarkExpectedEligibility;
  evaluationCriteria: BenchmarkEvaluationCriterion[];
};

const COMMON_ANACHRONISM_CONSTRAINTS = [
  "modern machinery",
  "modern metal tools",
  "modern clothing",
  "anachronistic architecture",
  "vehicles",
  "wheels",
  "text or writing overlays",
  "modern people in the background",
  "tourists",
  "signage",
];

export const ACTIVE_BENCHMARK_SHOTS: ActiveBenchmarkShotSpec[] = [
  {
    benchmarkId: ACTIVE_BENCHMARK_ID,
    shotId: "bench-v2-a-pillar-transport",
    title: "Pillar Transport",
    narrationContext: "Moving a single pillar could take dozens of people, working in rhythm, for days.",
    visualIntent:
      "A large group of Neolithic people cooperating as they pull and carry a massive stone pillar on wooden sledges and ropes, working together across open ground, coordinated group effort and visible physical strain",
    motionDescription:
      "Wide tracking shot moving alongside the group at walking pace, low camera height to emphasize the pillar's weight and scale",
    historicalClassification: "reconstruction",
    targetDurationSec: 5,
    aspectRatio: "16:9",
    referenceImageSpec: {
      description:
        "A single, historically-controlled still image of a large group of Neolithic people transporting a massive stone pillar via ropes and coordinated effort, wide shot, dawn/daytime natural light",
      compositionNotes:
        "Wide/eye-level framing, pillar occupies a clear diagonal or horizontal line across the frame, group spread naturally (not a symmetrical crowd), open ground with no modern reference points",
      requiredControls: [
        "architecture: no visible modern structures or anachronistic monuments in background",
        "vestuario: period-plausible clothing only, no modern fabrics/footwear",
        "herramientas: ropes/sledges/wood only, no metal hardware or modern rigging",
        "composición: pillar's scale relative to people must read as physically plausible (multi-ton stone)",
        "ausencia de objetos modernos: no wheels, vehicles, signage, or people in modern dress",
        "plausibilidad histórica: consistent with a Neolithic (pre-metal, pre-wheel) technological context",
      ],
      aspectRatio: "16:9",
      status: "not_generated",
    },
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "draft animals", "metal rigging"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: ["humanAnatomyQuality", "physicalPlausibility", "temporalConsistency", "promptAdherence", "motionQuality", "visualArtifacts", "usableInFinalEdit"],
  },
  {
    benchmarkId: ACTIVE_BENCHMARK_ID,
    shotId: "bench-v2-b-monument-architecture-dawn",
    title: "Monument / Architecture at Dawn",
    narrationContext:
      "Reconstructed like this, it starts to look less like a ruin, and more like it was built to be walked into.",
    visualIntent:
      "A plausible full reconstruction of the Göbekli Tepe enclosure at dawn, T-shaped pillars arranged in a circle, a small group gathering and walking near the center as warm low-angle light rises, architecturally coherent and spatially grounded",
    motionDescription:
      "Slow, controlled camera move (gentle push-in or minimal orbit), no handheld shake, revealing scale while preserving the pillar arrangement's geometry throughout the take",
    historicalClassification: "speculative_reconstruction",
    targetDurationSec: 5,
    aspectRatio: "16:9",
    referenceImageSpec: {
      description:
        "A single, historically-controlled still image of a plausible full architectural reconstruction of the Göbekli Tepe enclosure at dawn, wide establishing composition, T-shaped pillars in a circular arrangement",
      compositionNotes:
        "Wide establishing framing with clear depth (foreground pillar, mid-ground circle, background horizon), symmetrical or near-symmetrical arrangement, warm dawn lighting from a low angle",
      requiredControls: [
        "architecture: pillar count/arrangement/proportions consistent with the approved production storyboard's Göbekli Tepe reference material",
        "vestuario: no people, or period-plausible only if present",
        "herramientas: none visible (pure architecture shot)",
        "composición: geometry must read as physically stable/buildable, no impossible cantilevers",
        "ausencia de objetos modernos: no fences, signage, tourists, or modern infrastructure",
        "plausibilidad histórica: explicitly a plausible reconstruction, never presented as an excavation photograph",
      ],
      aspectRatio: "16:9",
      status: "not_generated",
    },
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "camera shake", "lens flare overuse"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: ["referenceConsistency", "motionQuality", "promptAdherence", "visualArtifacts", "usableInFinalEdit", "historicalPlausibility"],
  },
];

export function activeBenchmarkShotToEligibilityInput(shot: ActiveBenchmarkShotSpec): AiVideoEligibilityInput {
  return {
    id: shot.shotId,
    visualIntent: shot.visualIntent,
    durationSec: shot.targetDurationSec,
    motionDescription: shot.motionDescription,
    motionRequired: true,
  };
}
