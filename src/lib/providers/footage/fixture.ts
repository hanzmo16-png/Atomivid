import type { FootageCandidate, FootageProvider } from "../types";
import { fixturePatternSvg, seedFrom } from "../fixture-pattern";

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

// Color from the label, not from the global call counter: each scene consumes a fixed number of
// candidates, so a counter-based color repeated on consecutive scenes and hid every cut locally.
// A continuous hue (instead of a 6-color palette) keeps different searches visibly distinct.
function colorFor(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360},65%,38%)`;
}

function svgDataUri(label: string): string {
  const color = colorFor(label);
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
    `<rect width='100%' height='100%' fill='${color}'/>` +
    fixturePatternSvg(seedFrom(label), 1080, 1920) +
    `<rect x='60' y='${startY - fontSize * 1.4}' width='960' height='${lines.length * lineHeight + fontSize}' fill='${color}' fill-opacity='0.85'/>` +
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
      url: svgDataUri(query),
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
        url: svgDataUri(label),
        sourceId: `fixture-${counter}`,
        mediaType: "image" as const,
        photographer: `fixture-photographer-${counter}`,
        mimeType: "image/svg+xml",
        extension: "svg",
        width: 1080,
        height: 1920,
        // The synthetic image literally shows the search text, so that text is its honest provider
        // description. Without it the opening relevance gate (opening-relevance.ts) rejects every
        // fixture candidate and no local Reel can render.
        description: query,
      };
    });
  },
};
