/**
 * Etapas del render, en un módulo aparte (sin importar Remotion) para que
 * páginas que solo necesitan las etiquetas —como el historial— no arrastren
 * @remotion/bundler ni @remotion/renderer a su bundle de servidor.
 */
export const RENDER_STAGES = ["voice", "footage", "music", "render", "uploading"] as const;
export type RenderStage = (typeof RENDER_STAGES)[number];

export const RENDER_STAGE_LABEL: Record<RenderStage, string> = {
  voice: "Generando voz narrada",
  footage: "Buscando imágenes por escena",
  music: "Agregando música de fondo",
  render: "Ensamblando el video",
  uploading: "Subiendo el video final",
};
