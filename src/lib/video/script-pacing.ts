/**
 * Ritmo de narración compartido entre el proveedor real (src/lib/ai/script.ts),
 * el fixture (src/lib/providers/script/fixture.ts) y el control de calidad
 * (script-quality.ts) — una sola fuente de verdad para que los tres calculen
 * el mismo objetivo de palabras/escenas para una duración dada, en vez de
 * declarar la misma constante por separado y arriesgar que diverjan.
 */
export const WORDS_PER_SECOND = 2.6;

export function targetWordsFor(durationSeconds: number): number {
  return Math.round(durationSeconds * WORDS_PER_SECOND);
}
