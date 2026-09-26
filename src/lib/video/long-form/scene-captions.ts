/**
 * Subtítulos que respetan los cortes de escena (calidad M2): ningún
 * subtítulo queda en pantalla a través de un corte (p. ej. «palas, rodeado
 * de…» entre la escena del pico y la del mosquito), y dentro de cada escena
 * el texto se reparte en bloques EQUILIBRADOS para no dejar palabras
 * huérfanas («pudo.» solo en pantalla). El agrupado compartido
 * (captions.ts, también de Shorts) no se modifica: se aplica a cada bloque.
 */
import type { WordTiming } from "@/lib/providers/types";
import type { Caption } from "../../../../remotion/VerticalReel";

export const SCENE_CAPTION_MAX_CHARS = 52;
export const SCENE_CAPTION_MAX_WORDS = 7;

const chars = (ws: WordTiming[]) => ws.reduce((n, w, i) => n + w.text.length + (i > 0 ? 1 : 0), 0);

/** Reparte las palabras de una escena en el mínimo de bloques que respetan los límites, con longitudes parecidas. */
export function balancedGroups(words: WordTiming[]): WordTiming[][] {
  if (words.length === 0) return [];
  const n = Math.max(1, Math.ceil(chars(words) / SCENE_CAPTION_MAX_CHARS), Math.ceil(words.length / SCENE_CAPTION_MAX_WORDS));
  for (let groups = n; groups <= words.length; groups++) {
    const target = chars(words) / groups;
    const out: WordTiming[][] = [];
    let current: WordTiming[] = [];
    for (const [i, w] of words.entries()) {
      const remainingWords = words.length - i;
      const remainingGroups = groups - out.length;
      if (current.length > 0 && remainingGroups > 1 && (chars([...current, w]) > target + 4 || remainingWords < remainingGroups)) {
        out.push(current);
        current = [];
      }
      current.push(w);
    }
    if (current.length > 0) out.push(current);
    if (out.every((g) => chars(g) <= SCENE_CAPTION_MAX_CHARS && g.length <= SCENE_CAPTION_MAX_WORDS)) return out;
  }
  return words.map((w) => [w]);
}

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
    for (const group of balancedGroups(inScene)) {
      // Un bloque = un subtítulo (el agrupado compartido aporta el énfasis y el formato).
      const built = build(group);
      const merged: Caption = built.length === 1 ? built[0] : { ...built[0], text: group.map((w) => w.text).join(" "), endSeconds: group[group.length - 1].endSeconds, emphasisWords: built.flatMap((c) => c.emphasisWords ?? []) };
      out.push({ ...merged, startSeconds: Math.max(merged.startSeconds, scene.startSeconds), endSeconds: Math.min(merged.endSeconds, scene.endSeconds) });
    }
  }
  return out;
}
