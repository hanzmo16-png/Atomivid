import type { MusicTone } from "../types";
import type { MusicTrackEntry } from "./manifest";

export type MusicSelectionResult =
  | { status: "matched"; track: MusicTrackEntry; matchedTones: MusicTone[] }
  | { status: "fallback"; track: MusicTrackEntry }
  | { status: "empty" };

/**
 * Elige una pista del manifest según los tonos inferidos (ver tone.ts),
 * con desempate determinístico por `seed` (usa el requestId) — misma
 * semilla + mismo manifest ⇒ misma pista siempre (repetible para
 * depuración), pero distintas solicitudes normalmente caen en pistas
 * distintas. Si ninguna pista coincide en tono, cae a cualquier pista del
 * manifest (`fallback`) en vez de fallar — variedad por sobre precisión
 * cuando el banco es chico. Si el manifest está vacío, `empty` (el
 * llamador decide si eso es un error o si prueba la lista plana de URLs).
 */
export function selectMusicTrack({
  manifest,
  tones,
  seed,
}: {
  manifest: MusicTrackEntry[];
  tones: MusicTone[];
  seed: string;
}): MusicSelectionResult {
  if (manifest.length === 0) return { status: "empty" };

  const scored = manifest.map((track) => ({
    track,
    score: track.tones.filter((tone) => tones.includes(tone)).length,
  }));
  const bestScore = Math.max(...scored.map((s) => s.score));
  const pool = bestScore > 0 ? scored.filter((s) => s.score === bestScore) : scored;

  const index = seededIndex(seed, pool.length);
  const chosen = pool[index].track;

  return bestScore > 0
    ? { status: "matched", track: chosen, matchedTones: chosen.tones.filter((t) => tones.includes(t)) }
    : { status: "fallback", track: chosen };
}

/**
 * Elige un índice determinístico en [0, length) a partir de un string
 * arbitrario, usando FNV-1a (buen "avalanche": un solo carácter distinto
 * cambia el hash entero, no solo su valor en ±1) y módulo entero en vez de
 * normalizar a float — un hash polinomial simple normalizado a [0,1) y
 * truncado tiende a agrupar semillas con el mismo prefijo (p. ej.
 * "req-1".."req-9") en el mismo índice, justo el patrón típico de un
 * requestId secuencial de prueba; verificado empíricamente antes de
 * elegir este algoritmo (ver select.test.ts).
 */
export function seededIndex(seed: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0) % length;
}
