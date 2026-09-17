/**
 * Ritmo de narración compartido entre el proveedor real (src/lib/ai/script.ts),
 * el fixture (src/lib/providers/script/fixture.ts) y el control de calidad
 * (script-quality.ts) — una sola fuente de verdad para que los tres calculen
 * el mismo objetivo de palabras/escenas para una duración dada, en vez de
 * declarar la misma constante por separado y arriesgar que diverjan.
 *
 * CAUSA RAÍZ CONFIRMADA del defecto "duración real ~28% menor que la
 * pedida" (video auditado fc7534a0-f02e-4789-b1b7-d958f1ea3fa6: 30s
 * solicitados, 21.589s reales): el guion se dimensiona en PALABRAS a
 * partir de este valor, pero nunca se corrigió tras cambiar la voz de
 * producción a Mateo/eleven_multilingual_v2 (commit "feat(voice): Mateo
 * como voz de producción") — 2.6 palabras/seg. era una estimación previa
 * a ese cambio. El propio dato auditado permite despejar la tasa real:
 * checkScriptQuality solo rechaza un guion si su total de palabras está
 * fuera de [0.4x, 2x] del objetivo — una tolerancia deliberadamente ancha
 * para no bloquear guiones válidos por variación natural, así que el
 * guion de ese video pasó el filtro con ~78 palabras (30s × 2.6) que
 * Mateo narra en 21.589s ⇒ 78 / 21.589 ≈ 3.61 palabras/seg reales, un
 * 39% más rápido que el valor usado para dimensionar el guion. No es
 * "una limitación de la IA": es una constante desactualizada.
 *
 * Recalibrado a partir de ese único dato real disponible — deliberadamente
 * un poco por debajo de la tasa medida (3.61) para dejar margen: un guion
 * ligeramente MÁS LARGO en palabras que se narra un poco más rápido de lo
 * esperado cae dentro de tolerancia; uno corto que se narra más lento se
 * sale por abajo igual de fácil. Debe recalibrarse con el promedio real
 * una vez existan varias muestras (ver duration-check.ts, que mide y
 * advierte si el render real cae fuera de ±10% del objetivo — la señal
 * para saber cuándo y hacia dónde ajustar esta constante).
 */
export const WORDS_PER_SECOND = 3.5;

export function targetWordsFor(durationSeconds: number): number {
  return Math.round(durationSeconds * WORDS_PER_SECOND);
}
