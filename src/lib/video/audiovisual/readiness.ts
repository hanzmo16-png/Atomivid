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
import { MUSIC_DIRECTIONS, PROFILES, motionModeOf, type MotionMode, type MusicChoice, type ProfileId } from "./catalog";
import { veoVideoProvider } from "@/lib/providers/video-gen/veo";
import { fixtureAnimationProvider } from "@/lib/providers/video-gen/fixture-animation";
import type { VideoProvider } from "@/lib/providers/types";
import { MIN_ACTION_SECONDS, REEL_ANIMATION, animationClipCostUsd, scenesMissingAction, scenesTooLongForClip, scenesTooShortForAction } from "./animation";
import type { SceneEnergy } from "./direction";
import { compatibleTrackCount } from "./music";
import { checkVisualAvailability, type VisualAvailability } from "./visuals";

export type ReadinessIssue = { area: "visual" | "music" | "animation"; code: string; message: string; recovery: string };

export type DirectionReadiness = {
  ok: boolean;
  issues: ReadinessIssue[];
  visual: VisualAvailability;
  music: { choice: MusicChoice; compatibleTracks: number; source: "catalog" | "fixture" | "none" };
  /** Solo en «Animación IA». */
  animation?: AnimationAvailability;
};

/** Proveedor de animación que se usaría de verdad, o null. El fixture solo cuenta fuera de producción y si se pide explícitamente. */
export function usableAnimationProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  const requested = (env.REEL_ANIMATION_PROVIDER || "veo").trim();
  if (requested === "veo" && veoVideoProvider.isAvailable()) return "veo";
  if (requested === "fixture" && !isProductionRuntime()) return "fixture";
  return null;
}

export type AnimationAvailability =
  | { ok: true; clips: number; clipSeconds: number; clipCostUsd: number; estimatedUsd: number; maxCostUsd: number; provider: string; model: string }
  | { ok: false; code: "animation_disabled" | "provider_unavailable" | "no_budget" | "over_budget" | "scene_too_long" | "scene_too_short" | "action_missing"; message: string; recovery: string; estimatedUsd?: number };

/**
 * ¿Se puede animar este Reel? Se evalúa en el formulario (estimación),
 * al aprobar el guion (bloquea con 409 antes de gastar) y en el worker. La
 * duración exacta de cada escena se comprueba otra vez con la voz real.
 */
export function checkAnimationAvailability(input: {
  sceneCount: number;
  sceneTexts?: string[];
  /** Acción visible declarada por escena (obligatoria para animar). */
  sceneActions?: (string | undefined)[];
  /** Energía por escena: fija los segundos mínimos para completar su acción. */
  sceneEnergy?: (SceneEnergy | undefined)[];
  enabled: boolean;
  provider: string | null;
  maxCostUsd: number;
  clipCostUsd?: number;
}): AnimationAvailability {
  const clipCostUsd = input.clipCostUsd ?? animationClipCostUsd();
  const estimatedUsd = Math.round(input.sceneCount * clipCostUsd * 100) / 100;
  const recovery = "Elige «Imágenes» (ilustraciones con movimiento de cámara) o pide que se habilite la animación IA.";
  if (!input.enabled) return { ok: false, code: "animation_disabled", message: "La animación IA todavía no está habilitada.", recovery, estimatedUsd };
  if (!input.provider) return { ok: false, code: "provider_unavailable", message: "La animación IA necesita el proveedor de video configurado.", recovery, estimatedUsd };
  if (input.maxCostUsd <= 0) return { ok: false, code: "no_budget", message: "No hay un tope de gasto de animación autorizado para este entorno.", recovery, estimatedUsd };
  if (estimatedUsd > input.maxCostUsd + 1e-9) {
    return {
      ok: false,
      code: "over_budget",
      message: `Animar ${input.sceneCount} escenas cuesta ~US$${estimatedUsd.toFixed(2)} y el tope de animación por video es US$${input.maxCostUsd.toFixed(2)}.`,
      recovery: "Une escenas, elige una duración menor o usa «Imágenes».",
      estimatedUsd,
    };
  }
  const long = input.sceneTexts ? scenesTooLongForClip(input.sceneTexts) : [];
  if (long.length > 0) {
    return {
      ok: false,
      code: "scene_too_long",
      message: `La narración de la escena ${long.map((i) => i + 1).join(", ")} dura más que un clip animado (${REEL_ANIMATION.clipSeconds} s).`,
      recovery: "Divide esa escena en la revisión del guion. Un clip nunca se congela ni se ralentiza para rellenar.",
      estimatedUsd,
    };
  }
  const short = input.sceneTexts ? scenesTooShortForAction(input.sceneTexts.map((text) => ({ text })), input.sceneEnergy) : [];
  if (short.length > 0) {
    return {
      ok: false,
      code: "scene_too_short",
      message: `La escena ${short.map((i) => `${i + 1} (necesita ~${MIN_ACTION_SECONDS[input.sceneEnergy?.[i] ?? "medium"].toFixed(1)} s)`).join(", ")} es demasiado corta para completar su acción animada.`,
      recovery: "Alarga o une esa escena en la revisión del guion. Un clip nunca se acelera ni se congela para disimularlo.",
      estimatedUsd,
    };
  }
  const missing = input.sceneActions ? scenesMissingAction(input.sceneActions.map((visibleAction) => ({ visibleAction }))) : [];
  if (missing.length > 0) {
    return {
      ok: false,
      code: "action_missing",
      message: `La escena ${missing.map((i) => i + 1).join(", ")} no declara la acción visible que debe animarse.`,
      recovery: "Escribe en la revisión del guion una acción concreta y breve por escena (qué se mueve y cómo), o elige «Imágenes».",
      estimatedUsd,
    };
  }
  return { ok: true, clips: input.sceneCount, clipSeconds: REEL_ANIMATION.clipSeconds, clipCostUsd, estimatedUsd, maxCostUsd: input.maxCostUsd, provider: input.provider, model: REEL_ANIMATION.model };
}

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
  /** Modo de movimiento (ausente = imágenes, como siempre). */
  motion?: MotionMode;
  /** Narración de cada escena (duración estimada de los clips animados). */
  sceneTexts?: string[];
  /** Acción visible declarada por escena (solo «Animación IA»). */
  sceneActions?: (string | undefined)[];
  sceneEnergy?: (SceneEnergy | undefined)[];
  animationProvider?: string | null;
}): DirectionReadiness {
  const flags = input.flags ?? getFeatureFlags();
  const manifest = input.manifest ?? MUSIC_MANIFEST;
  const issues: ReadinessIssue[] = [];
  const animated = input.motion === "ai_animation";

  const visual = checkVisualAvailability({
    needsBaseImages: animated,
    profile: input.profile,
    sceneCount: input.sceneCount,
    imageGenerationEnabled: flags.imageGenerationEnabled,
    imageProvider: input.imageProvider === undefined ? usableImageProvider() : input.imageProvider,
    estimatedCostPerImageUsd: ESTIMATED_COST_USD,
    maxVisualCostUsd: flags.maxVisualCostUsd,
    maxStyledImages: flags.maxStyledImagesPerVideo,
  });
  if (!visual.ok) issues.push({ area: "visual", code: visual.code, message: visual.message, recovery: visual.recovery });

  let animation: AnimationAvailability | undefined;
  if (animated) {
    animation = checkAnimationAvailability({
      sceneCount: input.sceneCount,
      sceneTexts: input.sceneTexts,
      sceneActions: input.sceneActions,
      sceneEnergy: input.sceneEnergy,
      enabled: flags.reelAiAnimationEnabled,
      provider: input.animationProvider === undefined ? usableAnimationProvider() : input.animationProvider,
      maxCostUsd: flags.maxAiAnimationCostUsd,
    });
    if (!animation.ok) issues.push({ area: "animation", code: animation.code, message: animation.message, recovery: animation.recovery });
  }

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
  return { ok: issues.length === 0, issues, visual, music, ...(animation ? { animation } : {}) };
}

export function readinessErrorMessage(readiness: DirectionReadiness): string {
  return readiness.issues.map((i) => `${i.message} ${i.recovery}`).join(" ");
}

/** Escenas que pedirá el guion para cada duración (mismo cálculo que src/lib/ai/script.ts). */
export function expectedSceneCount(durationSeconds: number): number {
  return Math.max(3, Math.min(10, Math.round(durationSeconds / 5)));
}

/**
 * Disponibilidad por perfil para el formulario (antes de que exista el
 * guion), con el número de escenas esperado para cada duración. La
 * comprobación definitiva ocurre al aprobar el guion con sus escenas reales.
 */
export function profileAvailabilityByDuration(
  durations: number[],
  opts: { flags?: FeatureFlags; imageProvider?: string | null } = {},
): Record<number, Partial<Record<ProfileId, { ok: boolean; note?: string }>>> {
  const flags = opts.flags ?? getFeatureFlags();
  const imageProvider = opts.imageProvider === undefined ? usableImageProvider() : opts.imageProvider;
  const out: Record<number, Partial<Record<ProfileId, { ok: boolean; note?: string }>>> = {};
  for (const duration of durations) {
    const entry: Partial<Record<ProfileId, { ok: boolean; note?: string }>> = {};
    for (const profile of ["illustration_3d", "anime", "comic"] as const) {
      const v = checkVisualAvailability({
        profile,
        sceneCount: expectedSceneCount(duration),
        imageGenerationEnabled: flags.imageGenerationEnabled,
        imageProvider,
        estimatedCostPerImageUsd: ESTIMATED_COST_USD,
        maxVisualCostUsd: flags.maxVisualCostUsd,
        maxStyledImages: flags.maxStyledImagesPerVideo,
      });
      entry[profile] = v.ok ? { ok: true } : { ok: false, note: v.code === "generation_disabled" || v.code === "provider_unavailable" ? "Aún no disponible" : "Supera el tope de este video" };
    }
    out[duration] = entry;
  }
  return out;
}

/**
 * Disponibilidad y costo estimado de «Animación IA» por duración, para el
 * formulario (antes del guion). Incluye las ilustraciones base (una por
 * escena, también en perfiles de stock). La comprobación definitiva ocurre
 * al aprobar el guion con sus escenas reales.
 */
export function animationAvailabilityByDuration(
  durations: number[],
  opts: { flags?: FeatureFlags; imageProvider?: string | null; animationProvider?: string | null } = {},
): Record<number, { ok: boolean; note?: string; estimatedUsd: number; clips: number }> {
  const flags = opts.flags ?? getFeatureFlags();
  const imageProvider = opts.imageProvider === undefined ? usableImageProvider() : opts.imageProvider;
  const provider = opts.animationProvider === undefined ? usableAnimationProvider() : opts.animationProvider;
  const out: Record<number, { ok: boolean; note?: string; estimatedUsd: number; clips: number }> = {};
  for (const duration of durations) {
    const clips = expectedSceneCount(duration);
    const images = checkVisualAvailability({
      profile: "comic",
      sceneCount: clips,
      imageGenerationEnabled: flags.imageGenerationEnabled,
      imageProvider,
      estimatedCostPerImageUsd: ESTIMATED_COST_USD,
      maxVisualCostUsd: flags.maxVisualCostUsd,
      maxStyledImages: flags.maxStyledImagesPerVideo,
      needsBaseImages: true,
    });
    const anim = checkAnimationAvailability({ sceneCount: clips, enabled: flags.reelAiAnimationEnabled, provider, maxCostUsd: flags.maxAiAnimationCostUsd });
    const estimatedUsd = Math.round(((anim.ok ? anim.estimatedUsd : (anim.estimatedUsd ?? 0)) + clips * ESTIMATED_COST_USD) * 100) / 100;
    const note = !anim.ok
      ? anim.code === "over_budget"
        ? "Supera el tope de animación de este video"
        : "Aún no disponible"
      : !images.ok
        ? "Las ilustraciones base no están disponibles"
        : undefined;
    out[duration] = { ok: anim.ok && images.ok, ...(note ? { note } : {}), estimatedUsd, clips };
  }
  return out;
}

/** Perfiles con los que se puede pedir animación: todos (los de stock parten de una ilustración base con su estilo). */
export const ANIMATABLE_PROFILES = Object.keys(PROFILES) as ProfileId[];

/** Proveedor de animación de Reels. Nunca el de clips premium de otros flujos (getVideoProvider): no cambia Avatar ni Long Form. */
export function getReelAnimationProvider(): VideoProvider | null {
  const name = usableAnimationProvider();
  if (name === "veo") return veoVideoProvider;
  if (name === "fixture") return fixtureAnimationProvider;
  return null;
}

/** Disponibilidad de una dirección resuelta con las escenas reales del guion (incluye «Animación IA» si se eligió). */
export function readinessForScript(
  direction: { profile: ProfileId; music: { id: MusicChoice }; selection: { motion?: "ai_animation" }; sceneEnergy?: SceneEnergy[] },
  segments: { text: string; visibleAction?: string }[],
): DirectionReadiness {
  return evaluateDirectionReadiness({
    profile: direction.profile,
    music: direction.music.id,
    sceneCount: segments.length,
    motion: motionModeOf(direction.selection),
    sceneTexts: segments.map((s) => s.text),
    sceneActions: segments.map((s) => s.visibleAction),
    sceneEnergy: direction.sceneEnergy,
  });
}
