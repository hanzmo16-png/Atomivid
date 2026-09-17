/**
 * Identidad audiovisual de ATOMIVID — deliberadamente mínima esta fase:
 * un color de acento configurable, usado para el énfasis de palabras
 * clave en subtítulos (ver caption-emphasis.ts y VerticalReel.tsx). No
 * incrusta ningún logo, marca de agua ni tratamiento de apertura/cierre
 * de marca — el usuario debe poder activar/sustituir branding más
 * adelante, nunca imponérselo (ver Fase 8 del pedido de mejora de
 * calidad: "no incrustes permanentemente la marca ATOMIVID en todos los
 * videos"). Ampliar esto a un sistema de marca completo (tipografía
 * incrustada, firma visual, plantillas de apertura/cierre) es trabajo de
 * una fase posterior, fuera del alcance de esta iteración.
 */
export const DEFAULT_ACCENT_COLOR = "#FFC94D";

export function getAccentColor(): string {
  const configured = process.env.BRAND_ACCENT_COLOR?.trim();
  return configured || DEFAULT_ACCENT_COLOR;
}
