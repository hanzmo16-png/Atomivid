/**
 * Identidad audiovisual de ATOMIVID — deliberadamente mínima esta fase:
 * un color de acento configurable, usado para el énfasis de palabras
 * clave en subtítulos (ver caption-emphasis.ts y VerticalReel.tsx), y un
 * badge de logo opcional en la esquina. El logo NUNCA se incrusta por
 * defecto — el usuario hace videos sobre sus propios temas/marcas, no
 * sobre Atomivid (ver Fase 8 del pedido de mejora de calidad: "no
 * incrustes permanentemente la marca ATOMIVID en todos los videos").
 * `BRAND_SHOW_LOGO` es opt-in explícito por render (usado hoy solo para
 * el contenido promocional propio de Atomivid). El color de acento, en
 * cambio, es solo un token visual (no es literalmente la marca) y sí
 * tiene un valor por defecto — violeta eléctrico (#8f7ff5, el mismo
 * `--color-accent-hover` del resto del producto en globals.css) en vez
 * del amarillo genérico anterior, que el usuario reportó que se veía
 * "muy genérico, muy hechizo" en los videos reales generados.
 */
export const DEFAULT_ACCENT_COLOR = "#8f7ff5";

export function getAccentColor(): string {
  const configured = process.env.BRAND_ACCENT_COLOR?.trim();
  return configured || DEFAULT_ACCENT_COLOR;
}

/** Opt-in explícito — nunca activo por defecto, ver comentario arriba. */
export function shouldShowLogo(): boolean {
  return process.env.BRAND_SHOW_LOGO?.trim().toLowerCase() === "true";
}
