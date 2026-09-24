/**
 * AI Video Pipeline P2A — Benchmark Suite (Göbekli Tepe).
 *
 * Cinco shots diseñados ESPECÍFICAMENTE para probar movimiento con un
 * futuro proveedor real de video-IA — SEPARADOS del storyboard de
 * producción real de VIDEO #001 (gobekli-storyboard-003.json, 45 shots,
 * deliberadamente estático/documental). Nunca se modifican los 45 shots
 * originales para forzarlos a pedir video (instrucción explícita de P2A).
 *
 * Estructurado y versionable (`benchmarkId` + `version`) para poder repetir
 * EXACTAMENTE el mismo benchmark contra distintos proveedores/modelos más
 * adelante — todo el contenido vive aquí, nunca disperso en scripts o
 * prompts sueltos (ver VideoPromptBuilder, ai-video-prompt-builder.ts, que
 * consume `visualIntent`/`motionDescription`/`negativeConstraints` de este
 * manifest sin reinterpretarlos).
 *
 * Cada shot es una RECONSTRUCCIÓN VISUAL (nunca material de archivo real) —
 * `historicalClassification` (ver types.ts) marca explícitamente si lo
 * mostrado es plausible-pero-no-observado ("reconstruction") o
 * abiertamente hipotético ("speculative_reconstruction"); ninguno de los 5
 * shots de este benchmark es "real_documented" por diseño (todos son
 * recreaciones IA de escenas que nadie fotografió).
 */
import type { HistoricalClassification, VisualAssetTier } from "./types";
import type { AiVideoEligibilityInput } from "./ai-video-eligibility";

export const GOBEKLI_TEPE_BENCHMARK_ID = "gobekli-tepe-ai-video-benchmark-v1";

export type BenchmarkEvaluationCriterion =
  | "historicalPlausibility"
  | "promptAdherence"
  | "motionQuality"
  | "temporalConsistency"
  | "humanAnatomyQuality"
  | "physicalPlausibility"
  | "visualArtifacts"
  | "referenceConsistency"
  | "usableInFinalEdit";

export type BenchmarkExpectedEligibility = {
  /** Tier que el Eligibility Engine (ai-video-eligibility.ts, sin modificar para este benchmark) debería recomendar para este shot. */
  recommendedAssetType: VisualAssetTier;
  /** Score mínimo esperado — un test falla si el motor real cae por debajo, señal de que el texto dejó de leerse como "alto movimiento". */
  minScore: number;
};

export type BenchmarkShotSpec = {
  benchmarkId: string;
  shotId: string;
  title: string;
  /** Contexto/narración de referencia — qué diría el guion mientras se ve este clip (nunca se mete tal cual en el prompt visual, ver ai-video-prompt-builder.ts). */
  narrationContext: string;
  /** Intención visual — mismo campo que Shot.visualIntent, consumido directamente por el Eligibility Engine y el Prompt Builder. */
  visualIntent: string;
  motionDescription: string;
  historicalClassification: HistoricalClassification;
  durationSec: number;
  aspectRatio: "16:9" | "9:16";
  /** Referencia a una imagen ya aprobada para animación image-to-video, si existe — ninguno de los 5 shots la tiene todavía (ver informe final, sección "primera generación"). */
  referenceAsset?: string;
  /** Elementos a evitar explícitamente — anacronismos, principalmente (ver VideoPromptBuilder.negativeSignals). */
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
];

const CORE_CRITERIA: BenchmarkEvaluationCriterion[] = [
  "promptAdherence",
  "motionQuality",
  "temporalConsistency",
  "physicalPlausibility",
  "visualArtifacts",
  "usableInFinalEdit",
];

export const GOBEKLI_TEPE_BENCHMARK_SHOTS: BenchmarkShotSpec[] = [
  {
    benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
    shotId: "bench-a-stone-carving",
    title: "Stone Carving",
    narrationContext:
      "Somewhere nearby, other hands were shaping stone — not with metal, but with harder stone and raw persistence.",
    visualIntent:
      "Neolithic workers cooperating as they shape a large limestone pillar with period-plausible stone and antler tools, striking and working the surface together, hands moving in coordinated rhythm",
    motionDescription:
      "Slow handheld-style drift circling the workers; close framing on tool strikes and hand movement; continuous take, no cuts",
    historicalClassification: "reconstruction",
    durationSec: 5,
    aspectRatio: "16:9",
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "metal chisels", "sparks"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: [...CORE_CRITERIA, "humanAnatomyQuality", "historicalPlausibility"],
  },
  {
    benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
    shotId: "bench-b-pillar-transport",
    title: "Pillar Transport",
    narrationContext:
      "Moving a single pillar could take dozens of people, working in rhythm, for days.",
    visualIntent:
      "A large group of Neolithic people cooperating as they pull and carry a massive stone pillar on wooden sledges and ropes, working together across open ground, coordinated group effort and physical strain visible",
    motionDescription:
      "Wide tracking shot moving alongside the group at walking pace, low camera height to emphasize the pillar's weight and scale",
    historicalClassification: "reconstruction",
    durationSec: 5,
    aspectRatio: "16:9",
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "wheeled carts", "draft animals"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: [...CORE_CRITERIA, "humanAnatomyQuality", "historicalPlausibility"],
  },
  {
    benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
    shotId: "bench-c-monument-dawn",
    title: "Monument at Dawn",
    narrationContext:
      "At dawn, the enclosure would have felt less like a ruin and more like a place people actually moved through.",
    visualIntent:
      "People walking through a monumental Göbekli-Tepe-inspired stone enclosure at dawn, moving between the T-shaped pillars as golden light rises, slow procession-like movement and depth of layered figures",
    motionDescription:
      "Slow forward dolly-like camera move through the enclosure, gentle parallax between foreground and background pillars, warm low-angle dawn light",
    historicalClassification: "speculative_reconstruction",
    durationSec: 5,
    aspectRatio: "16:9",
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "modern signage", "fences", "tourists"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: [...CORE_CRITERIA, "referenceConsistency", "historicalPlausibility"],
  },
  {
    benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
    shotId: "bench-d-construction",
    title: "Construction",
    narrationContext:
      "None of this happened all at once. It was built, and rebuilt, in phases — a long-running project, not a single event.",
    visualIntent:
      "A plausible reconstruction of Neolithic people working around T-shaped pillars during a construction phase, some digging and leveling ground, others lifting and positioning stone with ropes, a busy cooperative work site",
    motionDescription:
      "Wide establishing shot with subtle handheld drift, multiple simultaneous actions visible across the frame, natural overlapping movement",
    historicalClassification: "speculative_reconstruction",
    durationSec: 5,
    aspectRatio: "16:9",
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "scaffolding", "pulleys with metal hardware"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: [...CORE_CRITERIA, "humanAnatomyQuality", "historicalPlausibility"],
  },
  {
    benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
    shotId: "bench-e-hero-shot",
    title: "Hero Shot",
    narrationContext:
      "Reconstructed like this, it starts to look less like a ruin, and more like it was built to be walked into.",
    visualIntent:
      "A cinematic hero shot of a plausible full reconstruction of the Göbekli Tepe enclosure, T-shaped pillars arranged in a circle, a small crowd gathering and walking between the pillars near the center at dawn, slow controlled camera movement revealing scale and depth",
    motionDescription:
      "Slow, controlled crane-like camera move rising and orbiting slightly, revealing full architectural scale; smooth, cinematic, minimal cuts",
    historicalClassification: "speculative_reconstruction",
    durationSec: 5,
    aspectRatio: "16:9",
    negativeConstraints: [...COMMON_ANACHRONISM_CONSTRAINTS, "camera shake", "lens flare overuse"],
    expectedEligibility: { recommendedAssetType: "ai_video", minScore: 0.7 },
    evaluationCriteria: [...CORE_CRITERIA, "referenceConsistency", "historicalPlausibility"],
  },
];

export type GobekliTepeBenchmarkManifest = {
  benchmarkId: string;
  version: 1;
  createdForVideoId: "gobekli-tepe-001";
  shots: BenchmarkShotSpec[];
};

export const GOBEKLI_TEPE_BENCHMARK_MANIFEST: GobekliTepeBenchmarkManifest = {
  benchmarkId: GOBEKLI_TEPE_BENCHMARK_ID,
  version: 1,
  createdForVideoId: "gobekli-tepe-001",
  shots: GOBEKLI_TEPE_BENCHMARK_SHOTS,
};

/** Adapta un shot del benchmark al input que ya consume el Eligibility Engine (ai-video-eligibility.ts) — sin modificar ese motor. */
export function benchmarkShotToEligibilityInput(shot: BenchmarkShotSpec): AiVideoEligibilityInput {
  return {
    id: shot.shotId,
    visualIntent: shot.visualIntent,
    durationSec: shot.durationSec,
    motionDescription: shot.motionDescription,
    motionRequired: true,
  };
}
