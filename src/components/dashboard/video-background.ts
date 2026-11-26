/**
 * Fondo en video del inicio del panel (COSMOS 2 v4). Solo visual: no llama a ningún API ni toca datos.
 * Material propio generado con IA (USD 0); dos orientaciones, cada archivo ≤ 2.5 MB, con póster del primer cuadro.
 */
export type Orientation = "portrait" | "landscape";

export const VIDEO_BACKGROUND_ORIENTATIONS: readonly Orientation[] = ["portrait", "landscape"];

export function backgroundSources(orientation: Orientation) {
  const base = `/cinematic/cosmos2-${orientation}`;
  return { webm: `${base}.webm`, mp4: `${base}.mp4`, poster: `${base}-poster.jpg` };
}

/**
 * ¿Se reproduce el video o se queda el póster? Movimiento reducido, ahorro de datos o red 2G → póster fijo.
 */
export function shouldPlayVideo(env: { reducedMotion: boolean; saveData?: boolean; effectiveType?: string }): boolean {
  if (env.reducedMotion) return false;
  if (env.saveData) return false;
  if (env.effectiveType && /(^|-)2g$/.test(env.effectiveType)) return false;
  return true;
}
