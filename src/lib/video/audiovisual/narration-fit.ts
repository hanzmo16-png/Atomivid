/**
 * «Animación IA»: ¿cabe cada escena de la narración REAL en un clip?
 *
 * Es el mismo cálculo que hace directed-reel.ts después de la voz (tramos
 * alineados a las palabras, cola final, fundido con la escena siguiente y
 * planAnimatedShots), expuesto para poder hacerlo ANTES de pagar imágenes y
 * clips: con la voz ya sintetizada (y cacheada) se decide si hace falta
 * ajustar su velocidad, dentro de un rango acotado, o detenerse.
 */
import type { WordTiming } from "@/lib/providers/types";
import { alignScenesToWords } from "@/lib/video/reel-shared";
import { VIDEO_TAIL_SECONDS } from "@/lib/video/script-pacing";
import { REEL_ANIMATION, planAnimatedShots } from "./animation";
import type { IntentId } from "./catalog";
import type { SceneEnergy } from "./direction";
import { REEL_FPS, TRANSITION_FRAMES, coverScenes } from "./montage";

/** Rango de velocidad de voz para ajustar la duración: al desacelerar no baja de 0,9 (voz natural); si hace falta acelerar más de 1,15, se detiene. */
export const FIT_SPEED_RANGE = { min: 0.9, max: 1.15 };
/** Margen bajo el largo del clip al ajustar: la velocidad no cambia los tiempos de forma exactamente lineal. */
export const FIT_SAFETY_SECONDS = 0.3;

export type NarrationFit = {
  totalSeconds: number;
  /** Segundos que cada escena necesita del clip (su tramo + el fundido con la siguiente). */
  neededSeconds: number[];
  tooLong: number[];
  tooShort: number[];
  fits: boolean;
};

export function animatedNarrationFit(input: {
  segments: { text: string }[];
  words: WordTiming[];
  narrationSeconds: number;
  intent: IntentId;
  sceneEnergy: SceneEnergy[];
  clipSeconds?: number;
}): NarrationFit {
  const totalSeconds = input.narrationSeconds + VIDEO_TAIL_SECONDS;
  const plan = planAnimatedShots({
    sceneSpans: coverScenes(alignScenesToWords(input.segments, input.words), totalSeconds),
    transitionInFrames: TRANSITION_FRAMES[input.intent],
    fps: REEL_FPS,
    sceneEnergy: input.sceneEnergy,
    clipSeconds: input.clipSeconds ?? REEL_ANIMATION.clipSeconds,
  });
  const neededSeconds = plan.shots.map((s, i) => Math.round((s.endSeconds - s.startSeconds + (plan.shots[i + 1]?.transitionInFrames ?? 0) / REEL_FPS) * 1000) / 1000);
  const tooLong = plan.tooLong.map((t) => t.sceneIndex);
  const tooShort = plan.tooShort.map((t) => t.sceneIndex);
  return { totalSeconds: Math.round(totalSeconds * 1000) / 1000, neededSeconds, tooLong, tooShort, fits: tooLong.length === 0 && tooShort.length === 0 };
}

/**
 * Velocidad de voz para una segunda síntesis, o null si no hace falta.
 *  - Si alguna escena no cabe: acelerar lo justo para que la más larga quede
 *    FIT_SAFETY_SECONDS bajo el clip.
 *  - Si todo cabe pero el total queda por debajo de `minTotalSeconds`:
 *    desacelerar hacia `targetTotalSeconds`, sin que ninguna escena deje de
 *    caber.
 * Lanza si el ajuste necesario sale del rango FIT_SPEED_RANGE (se detiene
 * antes de pagar imágenes y clips).
 */
export function fitSpeedAdjustment(
  fit: NarrationFit,
  options: { clipSeconds?: number; minTotalSeconds: number; targetTotalSeconds: number },
): number | null {
  const clip = options.clipSeconds ?? REEL_ANIMATION.clipSeconds;
  const worst = Math.max(...fit.neededSeconds);
  const limit = clip - FIT_SAFETY_SECONDS;
  if (fit.tooShort.length > 0) throw new Error(`Escenas demasiado cortas para su acción: ${fit.tooShort.map((i) => i + 1).join(", ")}. Detenido antes de pagar imágenes y clips.`);
  if (fit.tooLong.length > 0 || worst > clip) {
    const speed = Math.ceil((worst / limit) * 100) / 100;
    if (speed > FIT_SPEED_RANGE.max) {
      throw new Error(`La escena más larga necesita ${worst.toFixed(2)} s (clip de ${clip} s); acelerar la voz ×${speed} supera el máximo ×${FIT_SPEED_RANGE.max}. Detenido antes de pagar imágenes y clips.`);
    }
    return speed;
  }
  if (fit.totalSeconds < options.minTotalSeconds) {
    const wanted = Math.max(FIT_SPEED_RANGE.min, fit.totalSeconds / options.targetTotalSeconds);
    // Desacelerar alarga cada escena por 1/speed: la más larga debe seguir cabiendo.
    const floor = worst / limit;
    const speed = Math.ceil(Math.max(wanted, floor) * 100) / 100;
    return speed < 1 ? speed : null;
  }
  return null;
}
