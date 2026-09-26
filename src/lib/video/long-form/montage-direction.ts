/**
 * Dirección de montaje por defecto para planes v3 (calidad M2), pura y
 * determinista. Reglas editoriales, no automatismos:
 *
 * - Corte por defecto. Fundido SOLO cuando cambia la naturaleza temporal
 *   del material (archivo histórico ↔ material actual/ilustrativo/IA): el
 *   fundido señala el salto de época. Dos escenas del mismo pasaje NO
 *   reciben fundido por serlo.
 * - Video: sin movimiento de cámara añadido (el movimiento es el del clip).
 *   Imagen fija: movimiento lento que alterna, para no repetir el mismo zoom.
 *   Tarjetas y mapas: quietos (legibilidad).
 * - Cortes alineados a la voz (snapBoundaryToSpeech), sin escenas de menos
 *   de MIN_SCENE_SEC.
 */
import type { SceneDirection } from "../../../../remotion/long-form-direction";
import type { SceneProvenance } from "../../../../remotion/long-form-card-fit";
import { snapBoundaryToSpeech } from "./scene-anchoring";

export const ERA_DISSOLVE_SEC = 0.6;
export const MIN_SCENE_SEC = 1.0;

export type MontageInput = {
  kind: "video" | "image" | "graphic";
  provenance?: SceneProvenance;
};

const era = (p?: SceneProvenance) => (p === "archival_documentary" ? "archive" : "present");
const IMAGE_MOVES: NonNullable<SceneDirection["camera"]>[] = ["push", "left", "pull", "right"];

export function defaultDirections(scenes: MontageInput[]): SceneDirection[] {
  let imageIndex = 0;
  return scenes.map((scene, i) => {
    const prev = scenes[i - 1];
    const transition: SceneDirection["transition"] =
      i > 0 && prev && era(prev.provenance) !== era(scene.provenance) ? { type: "dissolve", seconds: ERA_DISSOLVE_SEC } : { type: "cut" };
    const camera: SceneDirection["camera"] = scene.kind === "image" ? IMAGE_MOVES[imageIndex++ % IMAGE_MOVES.length] : "still";
    return { transition, camera };
  });
}

/** Límites internos llevados al silencio entre palabras más cercano, manteniendo el orden y una duración mínima. */
export function snapSceneBoundaries(
  boundaries: number[],
  words: { startSeconds: number; endSeconds: number }[],
  maxShift = 0.6,
): number[] {
  const out = [...boundaries];
  for (let i = 1; i < out.length - 1; i++) {
    const snapped = snapBoundaryToSpeech(out[i], words, { maxShift });
    if (snapped - out[i - 1] >= MIN_SCENE_SEC && boundaries[i + 1] - snapped >= MIN_SCENE_SEC) out[i] = snapped;
  }
  return out;
}
