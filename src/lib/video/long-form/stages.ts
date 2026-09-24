/**
 * Etapas de progreso propias de Long Form (columna video_requests.long_form_stage,
 * migración 0016) — en un módulo aparte de produce.ts, mismo motivo que
 * src/lib/video/stages.ts está separado de generate-video.ts: páginas que
 * solo necesitan las etiquetas (el historial) no deben arrastrar
 * @remotion/bundler/@remotion/renderer a su bundle de servidor solo por
 * importar un Record<string, string>.
 */
export const LONG_FORM_STAGES = ["scripting", "storyboard", "assets", "ai_video", "rendering"] as const;
export type LongFormStage = (typeof LONG_FORM_STAGES)[number];

export const LONG_FORM_STAGE_LABEL: Record<LongFormStage, string> = {
  scripting: "Preparando el guion",
  storyboard: "Sintetizando narración y calculando los planos",
  assets: "Resolviendo imágenes y video por plano",
  ai_video: "Generando clips con IA (Veo)",
  rendering: "Ensamblando el documental",
};
