/**
 * Tarjetas de texto legibles (calidad M2): tamaños mínimos y comprobación
 * de desbordamiento ANTES de renderizar. Puro (sin React/Remotion) para
 * probarlo con node:test y usarlo desde la composición y el preflight.
 *
 * La estimación de ancho es conservadora (Arial/Helvetica en negrita
 * ~0.58 em por carácter de media en español); si no cabe, se rechaza —
 * nunca se encoge por debajo del mínimo legible en un teléfono.
 */
export const LARGE_CARD = {
  TITLE_PX: 72,
  BODY_PX: 44,
  TITLE_LINE_HEIGHT: 1.15,
  BODY_LINE_HEIGHT: 1.35,
  GAP_PX: 28,
  MAX_WIDTH_PX: 1500,
  /** Alto útil: 1080 menos márgenes y la franja inferior reservada a los subtítulos. */
  MAX_HEIGHT_PX: 1080 - 96 - 300,
  CHAR_EM: 0.58,
} as const;

function linesFor(text: string, fontPx: number, maxWidth: number, charEm: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontPx * charEm)));
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const len = word.length;
    if (len > maxChars) return Number.POSITIVE_INFINITY; // una palabra que no cabe en una línea
    if (current === 0) current = len;
    else if (current + 1 + len <= maxChars) current += 1 + len;
    else {
      lines += 1;
      current = len;
    }
  }
  return lines;
}

export type CardFit = { fits: boolean; titleLines: number; bodyLines: number; heightPx: number };

export function fitLargeCard(title: string, body: string): CardFit {
  const c = LARGE_CARD;
  const titleLines = linesFor(title, c.TITLE_PX, c.MAX_WIDTH_PX, c.CHAR_EM);
  const bodyLines = linesFor(body, c.BODY_PX, c.MAX_WIDTH_PX, c.CHAR_EM);
  const heightPx =
    titleLines * c.TITLE_PX * c.TITLE_LINE_HEIGHT + (bodyLines > 0 ? c.GAP_PX + bodyLines * c.BODY_PX * c.BODY_LINE_HEIGHT : 0);
  return { fits: Number.isFinite(heightPx) && heightPx <= c.MAX_HEIGHT_PX && titleLines <= 3, titleLines, bodyLines, heightPx };
}

export type SceneProvenance = "stock_illustrative" | "ai_recreation" | "archival_documentary" | "data_graphic";

/** Rótulo obligatorio por procedencia (nunca se presenta una recreación como imagen auténtica). */
export function provenanceLabel(provenance: SceneProvenance | undefined): string | null {
  return provenance === "ai_recreation" ? "Recreación IA" : null;
}
