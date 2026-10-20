import type { GeneratedScript } from "@/lib/providers/types";
import { targetWordsFor } from "./script-pacing";

/** A complete paid draft may be edited, but never narrated until its length fits. */
export function scriptLengthReview(script: GeneratedScript, seconds: number): string | null {
  const words = script.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const target = targetWordsFor(seconds), min = Math.ceil(target * 0.9), max = Math.floor(target * 1.1);
  return words < min || words > max
    ? `El guion tiene ${words} palabras; para ${seconds} segundos necesita entre ${min} y ${max}. Ajusta el texto y guarda los cambios antes de generar la voz.` : null;
}
