/**
 * Manifest técnico del VISUAL TEST V2 — las 3 imágenes AI_RECREATION que
 * se generan PRIMERO para validar el estilo visual del VIDEO #001 antes
 * de producir el resto (ver HANDOFF-PRODUCTION-V1.md sección 14).
 *
 * Cada entrada trae una `idempotencyKey` derivada determinísticamente de
 * (shotId, modelo, tamaño, calidad, prompt, prompt negativo) y un
 * `outputPath` que INCLUYE esa clave — así, si algo cambia en el prompt o
 * los parámetros, el path cambia y se regenera; si nada cambia y el
 * archivo ya existe en ese path, una ejecución posterior lo detecta
 * (shouldGenerate() ve el archivo y devuelve false) y NUNCA vuelve a
 * llamar a la API paga por el mismo shot con los mismos parámetros. Esto
 * es lo que hace imposible el doble gasto accidental por reintento que
 * pidió el usuario para este checkpoint.
 *
 * Este módulo NO llama a ninguna API — solo construye datos y decide,
 * dado el estado del disco, si generar algo sería necesario.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { VISUAL_TEST_V2_MAX_USD } from "./video-cost-guard";

export { VISUAL_TEST_V2_MAX_USD };

export const VISUAL_TEST_V2_MODEL = "gpt-image-2";
export const VISUAL_TEST_V2_SIZE = "1536x1024"; // landscape 16:9 — mismo tamaño que ya usa openaiImageProvider para Long Form
export const VISUAL_TEST_V2_QUALITY = "medium";
export const VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD = 0.05; // ESTIMATED_COST_USD por defecto en src/lib/providers/image/openai.ts

/**
 * Identidad visual COMPARTIDA de VIDEO #001 (Göbekli Tepe) — extraída de
 * atomivid-long-form-visual-bible-v1.md sección 3, pero acotada a este
 * video concreto (no es una plantilla universal para todo Long Form
 * futuro; el próximo documental puede necesitar otra paleta/época/lente y
 * debe definir la suya). Un solo lugar para editar consistencia entre las
 * 3 pruebas — nunca se duplica el texto en cada prompt.
 */
export const VIDEO_001_VISUAL_STYLE = {
  cinematography: "Photographic documentary realism, never painterly or generic-AI-looking",
  lighting: "Natural light only (dawn/dusk/diffuse) — never artificial studio lighting",
  colorTreatment: "Warm earth-tone grading (ochre, sienna, dusty gold) with desaturated cool shadows — premium documentary look",
  texture: "Subtle film grain",
  era: "Pre-Pottery Neolithic, ~11,000 years ago — absolutely no modern elements (roads, power lines, contemporary clothing, modern metal, writing)",
  composition: "Anamorphic widescreen composition",
  framing: "16:9, size 1536x1024, model gpt-image-2, quality medium (ver visual-test-v2 sección 9 costo)",
  sharedNegative:
    "no modern buildings, no roads, no power lines, no contemporary clothing, no text overlays, no watermark, no fantasy elements, no aliens, no futuristic technology",
} as const;

export type VisualTestV2ShotSpec = {
  shotId: string;
  beatId: string;
  rationale: string;
  /** Prompt específico de LA ESCENA — sin el bloque de estilo compartido, que se compone aparte (ver buildVisualTestV2Manifest). */
  scenePrompt: string;
  /** Negativos específicos de la escena, además de VIDEO_001_VISUAL_STYLE.sharedNegative (que se agrega siempre). */
  sceneNegativePrompt: string;
};

export type VisualTestV2ManifestEntry = VisualTestV2ShotSpec & {
  /** Prompt FINAL ya compuesto (escena + VIDEO_001_VISUAL_STYLE) — el que de verdad se le pasa al proveedor. */
  prompt: string;
  /** Negativo FINAL ya compuesto (escena + VIDEO_001_VISUAL_STYLE.sharedNegative). */
  negativePrompt: string;
  model: string;
  size: string;
  quality: string;
  aspectRatio: "16:9";
  estimatedCostUsd: number;
  idempotencyKey: string;
  outputPath: string;
};

export type VisualTestV2Manifest = {
  videoId: string;
  maxTotalUsd: number;
  estimatedTotalUsd: number;
  shots: VisualTestV2ManifestEntry[];
};

/** Determinístico: la misma combinación de campos SIEMPRE produce la misma clave, en cualquier proceso/máquina. */
export function computeIdempotencyKey(input: {
  shotId: string;
  model: string;
  size: string;
  quality: string;
  prompt: string;
  negativePrompt: string;
}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(input));
  return hash.digest("hex").slice(0, 16);
}

// --- Las 3 tomas seleccionadas (ver HANDOFF-PRODUCTION-V1.md sección 14 y
// gobekli-storyboard-003.json para el shot completo) ------------------------

const SHOTS: VisualTestV2ShotSpec[] = [
  {
    shotId: "b1-s4",
    beatId: "beat-1",
    rationale:
      "Establishing shot atmosférico del hook — valida el look base de todo el documental (se ecoa además en b13-s3, el cierre).",
    scenePrompt:
      "Wide cinematic establishing shot of the Anatolian highlands (Germuş mountains) at dawn. Rolling semi-arid " +
      "hills under a vast pale gold sky, dry grasses and scattered stone outcrops, atmospheric haze suggesting deep " +
      "time and vast scale. No people, no text.",
    sceneNegativePrompt: "no present-day vegetation patterns",
  },
  {
    shotId: "b4-s2",
    beatId: "beat-4",
    rationale:
      "Escena humana en silueta — valida la regla más delicada de la Visual Bible: cooperación humana sin rostro/técnica/herramienta específica identificable.",
    scenePrompt:
      "Cinematic wide shot at dusk: distant silhouettes of a small group of people working together on a hillside " +
      "near massive half-buried stone shapes, scale emphasized by distance and low warm light. Figures are anonymous " +
      "silhouettes — no visible clothing detail, tools, or specific activity that could be mistaken for a documented " +
      "technique. Mood of quiet, effortful cooperation, not action.",
    sceneNegativePrompt:
      "no visible tools, no specific construction technique, no visible clothing details, no ropes or pulleys shown explicitly, no close-up faces",
  },
  {
    shotId: "b8-s5",
    beatId: "beat-8",
    rationale:
      "Recreación condicional del hallazgo 2026 — el shot de mayor sensibilidad factual entre los AI_RECREATION: valida que una hipótesis con hedge se pueda ilustrar sin sugerir más certeza visual de la que hay. Regla de montaje: nunca se muestra sin la tarjeta de texto del hedge (b8-s4) en el mismo tramo.",
    scenePrompt:
      "Cinematic wide shot: a domestic scene in silhouette/middle distance — anonymous figures near small " +
      "rectangular structures — with massive monumental stone enclosures visible in the background under warm " +
      "light. Composition should read as speculative and atmospheric, not as documentary proof: soft focus on the " +
      "rectangular structures, no specific architectural detail claimed. Contemplative mood.",
    sceneNegativePrompt:
      "no close-up architectural detail on the rectangular structures (evita implicar una planta confirmada), no visible faces, no text overlays implying certainty",
  },
];

/** Compone el prompt final: escena + bloque de estilo compartido (VIDEO_001_VISUAL_STYLE) — nunca se manda solo el texto de escena, para que las 3 imágenes se sientan una misma serie. */
function composePrompt(scenePrompt: string): string {
  const s = VIDEO_001_VISUAL_STYLE;
  return (
    `${scenePrompt} ${s.cinematography}, ${s.lighting}, ${s.colorTreatment}, ${s.texture}, ${s.composition}. ` +
    `Setting: ${s.era}. No watermark.`
  );
}

function composeNegativePrompt(sceneNegativePrompt: string): string {
  return `${sceneNegativePrompt}, ${VIDEO_001_VISUAL_STYLE.sharedNegative}`;
}

export function buildVisualTestV2Manifest(outputDir = "content/long-form/gobekli-tepe-001/visual-test-v2"): VisualTestV2Manifest {
  const shots: VisualTestV2ManifestEntry[] = SHOTS.map((s) => {
    const prompt = composePrompt(s.scenePrompt);
    const negativePrompt = composeNegativePrompt(s.sceneNegativePrompt);
    const idempotencyKey = computeIdempotencyKey({
      shotId: s.shotId,
      model: VISUAL_TEST_V2_MODEL,
      size: VISUAL_TEST_V2_SIZE,
      quality: VISUAL_TEST_V2_QUALITY,
      prompt,
      negativePrompt,
    });
    return {
      ...s,
      prompt,
      negativePrompt,
      model: VISUAL_TEST_V2_MODEL,
      size: VISUAL_TEST_V2_SIZE,
      quality: VISUAL_TEST_V2_QUALITY,
      aspectRatio: "16:9",
      estimatedCostUsd: VISUAL_TEST_V2_ESTIMATED_COST_PER_IMAGE_USD,
      idempotencyKey,
      outputPath: `${outputDir}/${s.shotId}-${idempotencyKey}.png`,
    };
  });
  const estimatedTotalUsd = round4(shots.reduce((sum, s) => sum + s.estimatedCostUsd, 0));
  return { videoId: "gobekli-tepe-001", maxTotalUsd: VISUAL_TEST_V2_MAX_USD, estimatedTotalUsd, shots };
}

/** true si el archivo del shot NO existe todavía en disco (hay que generarlo); false si ya existe (nunca se regenera/re-cobra por el mismo shot+parámetros). Pura decisión — no genera nada. */
export function shouldGenerate(entry: VisualTestV2ManifestEntry): boolean {
  return !existsSync(entry.outputPath);
}

/** Convierte una entrada del manifest en el ImageGenerationRequest exacto que se le pasaría a ImageProvider.generateImage() (ver src/lib/providers/types.ts) — el "preflight" de section 4 del handoff verifica el resto (rechazo sin OPENAI_API_KEY, sin fallback silencioso, etc.) sobre este mismo tipo de request. */
export function toImageGenerationRequest(
  entry: VisualTestV2ManifestEntry,
): { prompt: string; negativePrompt: string; aspectRatio: "16:9"; maxCostUsd: number } {
  return {
    prompt: entry.prompt,
    negativePrompt: entry.negativePrompt,
    aspectRatio: entry.aspectRatio,
    maxCostUsd: VISUAL_TEST_V2_MAX_USD,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
