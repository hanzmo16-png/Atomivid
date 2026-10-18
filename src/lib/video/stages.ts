/**
 * Etapas del render, en un módulo aparte (sin importar Remotion) para que
 * páginas que solo necesitan las etiquetas —como el historial— no arrastren
 * @remotion/bundler ni @remotion/renderer a su bundle de servidor.
 */
export const RENDER_STAGES = ["queued", "voice", "footage", "music", "render", "uploading"] as const;
export type RenderStage = (typeof RENDER_STAGES)[number];

export const RENDER_STAGE_LABEL: Record<RenderStage, string> = {
  queued: "En cola, esperando un espacio para procesar",
  voice: "Generando voz narrada",
  footage: "Buscando imágenes por escena",
  music: "Agregando música de fondo",
  render: "Ensamblando el video",
  uploading: "Subiendo el video final",
};

/** Hitos visibles para Reel/Avatar. Son aproximados por ETAPA, no porcentaje real de fotogramas ni ETA. */
const STAGE_MILESTONE: Readonly<Record<RenderStage, number>> = {
  queued: 5, voice: 20, footage: 45, music: 65, render: 80, uploading: 95,
};

/** Nunca informa 100% mientras status sigue processing ni inventa cifras para una etapa desconocida. */
export function approximateRenderProgress(stage: string | null | undefined): number | null {
  if (!stage || !Object.prototype.hasOwnProperty.call(STAGE_MILESTONE, stage)) return null;
  return STAGE_MILESTONE[stage as RenderStage];
}
