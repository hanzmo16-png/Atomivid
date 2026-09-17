/**
 * Política de selección de recurso visual por escena — decide, SIN hacer
 * ninguna llamada de red ni gastar nada, si una escena es candidata a
 * imagen generada (OpenAI) o debe usar stock (Pexels/Pixabay, el flujo ya
 * existente en footage-select.ts). Separado deliberadamente de
 * visual-resource-resolver.ts (que sí hace I/O) para poder probar la
 * política — y para poder correr el modo dry-run (scripts/dry-run-visual-plan.ts)
 * — sin tocar ningún proveedor ni Supabase.
 *
 * Política CONSERVADORA pedida explícitamente: la generación pagada
 * NUNCA es el default. Solo se considera para una escena cuando TODAS
 * estas condiciones se cumplen:
 *  1. VISUAL_DIRECTOR_ENABLED=true (si no, no hay clasificación semántica
 *     por escena en absoluto — sin eso, jamás se genera nada).
 *  2. OPENAI_IMAGE_GENERATION_ENABLED=true (interruptor global explícito,
 *     independiente del anterior — ver feature-flags.ts).
 *  3. El Visual Director marcó esa escena como "generated_image" o
 *     "abstract" (conceptos difíciles de encontrar en stock — nunca
 *     "stock_video"/"generated_video"/"motion_graphic", que siguen su
 *     propio camino o caen a stock).
 *  4. La confianza del Visual Director en esa escena alcanza el mínimo
 *     (MIN_GENERATION_CONFIDENCE) — una interpretación dudosa no debe
 *     gastar dinero.
 *  5. No se superó el tope de imágenes por video (MAX_GENERATED_IMAGES_PER_VIDEO).
 *  6. No se superaría el presupuesto visual total (MAX_VISUAL_COST_USD) —
 *     ver checkImageBudget() en cost-estimator.ts, ya existente.
 *
 * Si CUALQUIERA de estas falla, la escena usa stock — nunca otro
 * proveedor de pago como sustituto silencioso (ver visual-resource-resolver.ts).
 */
import type { StoryboardScene } from "./storyboard/types";
import { getFeatureFlags } from "./feature-flags";
import { checkImageBudget } from "./cost-estimator";

/** Por debajo de esto, la interpretación del Visual Director es demasiado dudosa para gastar dinero en ella. */
export const MIN_GENERATION_CONFIDENCE = 0.6;

/**
 * "generated_video"/"motion_graphic" NO están aquí: el primero es
 * dominio de VideoProvider (Runway, ya implementado aparte), y todavía no
 * existe un renderizador propio de motion graphics — tratarlo como
 * candidato de imagen generada inventaría una capacidad no implementada,
 * así que cae a stock como cualquier otro tipo no elegible (documentado,
 * no oculto).
 */
const GENERATION_ELIGIBLE_RESOURCE_TYPES = new Set(["generated_image", "abstract"]);

export type ResourceDecision =
  | { useGeneration: true; scene: StoryboardScene; estimatedCostUsd: number }
  | { useGeneration: false; reason: string };

export function decideResourceStrategy(
  scene: StoryboardScene | undefined,
  imagesGeneratedOrRequestedSoFar: number,
  visualCostSpentSoFarUsd: number,
): ResourceDecision {
  const flags = getFeatureFlags();

  if (!flags.visualDirectorEnabled) {
    return {
      useGeneration: false,
      reason: "VISUAL_DIRECTOR_ENABLED=false — sin clasificación semántica por escena, se usa stock",
    };
  }
  if (!flags.imageGenerationEnabled) {
    return {
      useGeneration: false,
      reason: "OPENAI_IMAGE_GENERATION_ENABLED=false — generación pagada apagada globalmente",
    };
  }
  if (!scene) {
    return { useGeneration: false, reason: "sin escena de storyboard para este beat — se usa stock" };
  }
  if (!GENERATION_ELIGIBLE_RESOURCE_TYPES.has(scene.resourceType)) {
    return {
      useGeneration: false,
      reason: `resourceType "${scene.resourceType}" no es candidato a generación — se usa stock`,
    };
  }
  if (scene.confidence < MIN_GENERATION_CONFIDENCE) {
    return {
      useGeneration: false,
      reason: `confianza del Visual Director (${scene.confidence}) por debajo del mínimo (${MIN_GENERATION_CONFIDENCE}) — se usa stock`,
    };
  }
  if (imagesGeneratedOrRequestedSoFar >= flags.maxImagesPerVideo) {
    return {
      useGeneration: false,
      reason: `ya se alcanzó el máximo de imágenes generadas por video (MAX_GENERATED_IMAGES_PER_VIDEO=${flags.maxImagesPerVideo}) — se usa stock`,
    };
  }
  const budget = checkImageBudget(scene, visualCostSpentSoFarUsd);
  if (!budget.allowed) {
    return { useGeneration: false, reason: `${budget.reason} — se usa stock` };
  }

  const estimatedCostUsd = scene.maxCostUsd > 0 ? scene.maxCostUsd : flags.maxVisualCostUsd;
  return { useGeneration: true, scene, estimatedCostUsd };
}

export type ScenePlanEntry = {
  sceneId: string;
  sceneIndex: number;
  beatIndex: number;
  durationSeconds: number;
  narrationText: string;
  resourceType: "stock" | "generated_image";
  /** "pending" aquí (solo decisión, sin I/O) — el llamador con acceso al resultado real (generate-video.ts) lo sobreescribe con "pexels"/"pixabay"/"openai"/"fixture" tras resolver. */
  provider: string;
  queryOrPrompt: string;
  aspectRatio: "9:16";
  motionTreatment: string;
  status: "planned_stock" | "planned_generated";
  estimatedCostUsd: number;
  reason: string;
};

/**
 * Construye la especificación estructurada de la escena (pedida
 * explícitamente: id, duración, intención narrativa, tipo de recurso,
 * proveedor, consulta/prompt, formato, tratamiento de movimiento, estado,
 * costo estimado) SIN llamar a ningún proveedor — usada por el modo
 * dry-run y por los logs de auditoría del render real.
 */
export function buildScenePlanEntry(
  sceneIndex: number,
  beatIndex: number,
  beatDurationSeconds: number,
  narrationText: string,
  fallbackQuery: string,
  decision: ResourceDecision,
): ScenePlanEntry {
  const useGeneration = decision.useGeneration;
  return {
    sceneId: `scene-${sceneIndex}-${beatIndex}`,
    sceneIndex,
    beatIndex,
    durationSeconds: beatDurationSeconds,
    narrationText,
    resourceType: useGeneration ? "generated_image" : "stock",
    provider: "pending",
    queryOrPrompt: useGeneration ? decision.scene.imagePrompt : fallbackQuery,
    aspectRatio: "9:16",
    // Remotion aplica Ken Burns (zoom lento + paneo) y crossfade a
    // CUALQUIER Scene (imagen o video) de forma genérica — ver
    // remotion/VerticalReel.tsx SceneMedia() — así que el tratamiento es
    // el mismo sin importar el proveedor del recurso.
    motionTreatment: "ken-burns-zoom-pan + crossfade (remotion/VerticalReel.tsx, sin cambios por proveedor)",
    status: useGeneration ? "planned_generated" : "planned_stock",
    estimatedCostUsd: useGeneration ? decision.estimatedCostUsd : 0,
    reason: useGeneration ? `elegible: resourceType="${decision.scene.resourceType}", confianza=${decision.scene.confidence}` : decision.reason,
  };
}

/**
 * Prefijo determinístico en Storage para el recurso generado de una
 * escena — el MISMO en cada reintento del mismo requestId/escena. La
 * extensión real (png para OpenAI, svg para el fixture) no se conoce
 * hasta después de generar, así que la idempotencia se verifica listando
 * por este prefijo (ver findExistingGeneratedImage en
 * visual-resource-resolver.ts) en vez de adivinar la extensión.
 */
export function generatedImageObjectPrefix(sceneIndex: number): string {
  return `scene-${sceneIndex}-generated`;
}
