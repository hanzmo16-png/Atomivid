import type { FootageProvider } from "../types";

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
  async fetchImage(query) {
    counter += 1;
    return {
      url: svgDataUri(query, counter),
      photographer: "fixture",
      mimeType: "image/svg+xml",
      extension: "svg",
    };
  },
  async downloadImage(url) {
    const match = /^data:image\/svg\+xml;utf8,(.*)$/.exec(url);
    if (!match) {
      throw new Error("downloadImage del fixture solo acepta data URIs propias");
    }
    return Buffer.from(decodeURIComponent(match[1]), "utf8");
  },
};
