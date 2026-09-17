import type { FootageCandidate, FootageProvider } from "../types";

const COLORS = ["334155", "7c3aed", "b91c1c", "0f766e", "b45309", "1d4ed8"];

function wrapLabel(label: string, maxCharsPerLine: number): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, 3);
}

function svgDataUri(label: string, colorIndex: number): string {
  const color = COLORS[colorIndex % COLORS.length];
  const safeLabel = label.replace(/[<>&]/g, "").slice(0, 60);
  const lines = wrapLabel(safeLabel, 18);
  const fontSize = 52;
  const lineHeight = fontSize * 1.2;
  const startY = 960 - ((lines.length - 1) * lineHeight) / 2;

  const tspans = lines
    .map((line, i) => `<tspan x='50%' y='${startY + i * lineHeight}'>${line}</tspan>`)
    .join("");

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'>` +
    `<rect width='100%' height='100%' fill='#${color}'/>` +
    `<text font-size='${fontSize}' fill='white' text-anchor='middle' ` +
    `font-family='sans-serif'>${tspans}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

let counter = 0;

// Proveedor determinístico (sin red): genera imágenes de color sólido con
// el texto de búsqueda superpuesto, en vez de fotos reales de Pexels — sirve
// para probar el pipeline completo sin PEXELS_API_KEY.
export const fixtureFootageProvider: FootageProvider = {
  name: "fixture",
  async fetchFootage(query) {
    counter += 1;
    return {
      url: svgDataUri(query, counter),
      mediaType: "image",
      photographer: "fixture",
      mimeType: "image/svg+xml",
      extension: "svg",
    };
  },
  async downloadFootage(url) {
    const match = /^data:image\/svg\+xml;utf8,(.*)$/.exec(url);
    if (!match) {
      throw new Error("downloadFootage del fixture solo acepta data URIs propias");
    }
    return Buffer.from(decodeURIComponent(match[1]), "utf8");
  },
  // El fixture nunca tiene video real disponible — devolver vacío (en vez
  // de simular un candidato "video" que en realidad sería una imagen SVG)
  // deja que footage-select.ts recorra su propio camino de fallback a
  // imagen, ejercitando esa ruta en pruebas/desarrollo sin Pexels.
  async searchVideoCandidates(): Promise<FootageCandidate[]> {
    return [];
  },
  async searchImageCandidates(query): Promise<FootageCandidate[]> {
    // Varios candidatos SINTÉTICOS PERO DISTINTOS por consulta — así
    // footage-select.ts tiene entre qué elegir/deduplicar de verdad en
    // vez de recibir siempre un único resultado. `photographer` también
    // varía por candidato (antes era siempre "fixture" para todos — la
    // penalización por diversidad de footage-score.ts escalaba sin límite
    // en videos largos, dando scores muy negativos que no representan lo
    // que pasaría con Pexels real, donde cada foto trae su propio autor).
    return Array.from({ length: 3 }, (_, i) => {
      counter += 1;
      const label = `${query} #${i + 1}`;
      return {
        url: svgDataUri(label, counter),
        sourceId: `fixture-${counter}`,
        mediaType: "image" as const,
        photographer: `fixture-photographer-${counter}`,
        mimeType: "image/svg+xml",
        extension: "svg",
        width: 1080,
        height: 1920,
      };
    });
  },
};
