/**
 * Guarda de costo PREVENTIVA para la capa creativa nueva (imagen/video
 * generado/música premium) — distinta de src/lib/billing/usage.ts, que
 * registra el costo REAL/estimado DESPUÉS de que un video ya se generó.
 * Este módulo decide, ANTES de pedir nada a un proveedor pago, si esa
 * petición cabe dentro de los límites configurados (ver feature-flags.ts)
 * — el mecanismo con el que "el sistema debe proteger los márgenes" sin
 * depender de que cada adaptador individual recuerde revisar el límite.
 */
import { getFeatureFlags } from "./feature-flags";
import type { StoryboardScene } from "./storyboard/types";

export type CostDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/** ¿Cabe generar una imagen para esta escena dentro del presupuesto visual total ya gastado? */
export function checkImageBudget(scene: StoryboardScene, spentSoFarUsd: number): CostDecision {
  const flags = getFeatureFlags();
  const sceneLimit = scene.maxCostUsd > 0 ? scene.maxCostUsd : flags.maxVisualCostUsd;
  if (spentSoFarUsd + sceneLimit > flags.maxVisualCostUsd) {
    return {
      allowed: false,
      reason: `Generar imagen para "${scene.id}" excedería MAX_VISUAL_COST_USD ($${flags.maxVisualCostUsd}); gastado hasta ahora: $${spentSoFarUsd.toFixed(4)}`,
    };
  }
  return { allowed: true };
}

/** ¿Cabe un clip premium (Runway) dentro del tope de clips Y del presupuesto de video premium? */
export function checkPremiumVideoBudget(
  clipsUsedSoFar: number,
  spentSoFarUsd: number,
  estimatedClipCostUsd: number,
): CostDecision {
  const flags = getFeatureFlags();
  if (!flags.premiumClipsEnabled) {
    return { allowed: false, reason: "PREMIUM_CLIPS_ENABLED=false" };
  }
  if (clipsUsedSoFar >= flags.maxPremiumClips) {
    return { allowed: false, reason: `Ya se usó el máximo de clips premium (MAX_PREMIUM_CLIPS=${flags.maxPremiumClips})` };
  }
  if (spentSoFarUsd + estimatedClipCostUsd > flags.maxPremiumVideoCostUsd) {
    return {
      allowed: false,
      reason: `Excedería MAX_PREMIUM_VIDEO_COST_USD ($${flags.maxPremiumVideoCostUsd}); gastado hasta ahora: $${spentSoFarUsd.toFixed(4)}`,
    };
  }
  return { allowed: true };
}

export type StoryboardCostEstimate = {
  totalScenes: number;
  scenesRecommendingGeneratedImage: number;
  scenesRecommendingGeneratedVideo: number;
  estimatedImageCostUsd: number;
  estimatedPremiumVideoCostUsd: number;
  estimatedMusicCostUsd: number;
  estimatedTotalUsd: number;
  limitsApplied: ReturnType<typeof getFeatureFlags>;
};

/**
 * Estimación de costo de TODO el storyboard antes de generar nada —
 * usada por el modo dry-run (scripts/dry-run-storyboard.ts) para
 * inspeccionar la decisión creativa/económica sin gastar dinero real.
 * Usa las tarifas configuradas de cada adaptador (env vars documentadas
 * en cada proveedor) en vez de duplicar precios aquí.
 */
export function estimateStoryboardCost(
  scenes: StoryboardScene[],
  perImageCostUsd: number,
  perPremiumSecondCostUsd: number,
): StoryboardCostEstimate {
  const flags = getFeatureFlags();

  const scenesRecommendingGeneratedImage = scenes.filter((s) => s.resourceType === "generated_image").length;
  const scenesRecommendingGeneratedVideo = Math.min(
    scenes.filter((s) => s.resourceType === "generated_video").length,
    flags.premiumClipsEnabled ? flags.maxPremiumClips : 0,
  );

  const estimatedImageCostUsd = Math.min(
    scenesRecommendingGeneratedImage * perImageCostUsd,
    flags.maxVisualCostUsd,
  );
  const estimatedPremiumVideoCostUsd = Math.min(
    scenesRecommendingGeneratedVideo * flags.maxPremiumClipSeconds * perPremiumSecondCostUsd,
    flags.maxPremiumVideoCostUsd,
  );
  const estimatedMusicCostUsd = flags.musicProvider === "beatoven" ? flags.maxMusicCostUsd : 0;

  return {
    totalScenes: scenes.length,
    scenesRecommendingGeneratedImage,
    scenesRecommendingGeneratedVideo,
    estimatedImageCostUsd,
    estimatedPremiumVideoCostUsd,
    estimatedMusicCostUsd,
    estimatedTotalUsd: estimatedImageCostUsd + estimatedPremiumVideoCostUsd + estimatedMusicCostUsd,
    limitsApplied: flags,
  };
}
