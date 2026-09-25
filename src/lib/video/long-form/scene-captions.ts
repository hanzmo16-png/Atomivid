/**
 * Subtítulos que respetan los cortes de escena (calidad M2): el agrupado
 * compartido (captions.ts, también de Shorts) se aplica POR ESCENA, de modo
 * que ningún subtítulo queda en pantalla a través de un corte (p. ej.
 * «palas, rodeado de…» entre la escena del pico y la del mosquito).
 */
import type { WordTiming } from "@/lib/providers/types";
import type { Caption } from "../../../../remotion/VerticalReel";

export function captionsWithinScenes(
  words: WordTiming[],
  scenes: { startSeconds: number; endSeconds: number }[],
  build: (words: WordTiming[]) => Caption[],
): Caption[] {
  const out: Caption[] = [];
  for (const scene of scenes) {
    const inScene = words.filter((w) => {
      const mid = (w.startSeconds + w.endSeconds) / 2;
      return mid >= scene.startSeconds && mid < scene.endSeconds;
    });
    for (const c of build(inScene)) {
      out.push({ ...c, startSeconds: Math.max(c.startSeconds, scene.startSeconds), endSeconds: Math.min(c.endSeconds, scene.endSeconds) });
    }
  }
  return out;
}
