/**
 * ¿Se puede producir esta dirección SIN contradicciones ni gasto
 * inesperado? Combina música (catálogo) e imágenes (flags, proveedor y
 * presupuesto). Se usa en la revisión del guion (para mostrar el estado y
 * la ruta de recuperación), al aprobar (bloquea con 409 antes de gastar) y
 * en el worker antes de la primera llamada de pago.
 */
import { MUSIC_MANIFEST, type MusicTrackEntry } from "@/lib/providers/music/manifest";
import { isProductionRuntime } from "@/lib/providers/production";
import { openaiImageProvider, ESTIMATED_COST_USD } from "@/lib/providers/image/openai";
import { getFeatureFlags, type FeatureFlags } from "../feature-flags";
import { MUSIC_DIRECTIONS, type MusicChoice, type ProfileId } from "./catalog";
import { compatibleTrackCount } from "./music";
import { checkVisualAvailability, type VisualAvailability } from "./visuals";

export type ReadinessIssue = { area: "visual" | "music"; code: string; message: string; recovery: string };

export type DirectionReadiness = {
  ok: boolean;
  issues: ReadinessIssue[];
  visual: VisualAvailability;
  music: { choice: MusicChoice; compatibleTracks: number; source: "catalog" | "fixture" | "none" };
};

/** Proveedor de imágenes que se usaría de verdad, o null. El fixture solo cuenta fuera de producción. */
export function usableImageProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  const requested = (env.IMAGE_PROVIDER || "fixture").trim();
  if (requested === "openai" && openaiImageProvider.isAvailable()) return "openai";
  return isProductionRuntime() ? null : "fixture";
}

export function evaluateDirectionReadiness(input: {
  profile: ProfileId;
  music: MusicChoice;
  sceneCount: number;
  flags?: FeatureFlags;
  manifest?: MusicTrackEntry[];
  imageProvider?: string | null;
  musicProviderSetting?: string;
}): DirectionReadiness {
  const flags = input.flags ?? getFeatureFlags();
  const manifest = input.manifest ?? MUSIC_MANIFEST;
  const issues: ReadinessIssue[] = [];

  const visual = checkVisualAvailability({
    profile: input.profile,
    sceneCount: input.sceneCount,
    imageGenerationEnabled: flags.imageGenerationEnabled,
    imageProvider: input.imageProvider === undefined ? usableImageProvider() : input.imageProvider,
    estimatedCostPerImageUsd: ESTIMATED_COST_USD,
    maxVisualCostUsd: flags.maxVisualCostUsd,
    maxStyledImages: flags.maxStyledImagesPerVideo,
  });
  if (!visual.ok) issues.push({ area: "visual", code: visual.code, message: visual.message, recovery: visual.recovery });

  const fixtureMusic = (input.musicProviderSetting ?? process.env.MUSIC_PROVIDER) === "fixture" && !isProductionRuntime();
  let music: DirectionReadiness["music"];
  if (input.music === "none") {
    music = { choice: "none", compatibleTracks: 0, source: "none" };
  } else if (fixtureMusic) {
    music = { choice: input.music, compatibleTracks: 1, source: "fixture" };
  } else {
    const compatibleTracks = compatibleTrackCount(manifest, input.music);
    music = { choice: input.music, compatibleTracks, source: "catalog" };
    if (compatibleTracks === 0) {
      issues.push({
        area: "music",
        code: "no_compatible_track",
        message: `No hay pistas en el catálogo compatibles con «${MUSIC_DIRECTIONS[input.music].label}».`,
        recovery: "Cambia la música en «Ajustes» (otra dirección o «Sin música»). No se elige otra pista al azar ni se genera música de pago.",
      });
    }
  }
  return { ok: issues.length === 0, issues, visual, music };
}

export function readinessErrorMessage(readiness: DirectionReadiness): string {
  return readiness.issues.map((i) => `${i.message} ${i.recovery}`).join(" ");
}
