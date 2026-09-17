import type { GenerativeAsset, ImageGenerationRequest, ImageProvider } from "../types";

/**
 * Generador de imágenes determinístico (sin red): un rectángulo de color
 * sólido 1080x1920 con el prompt superpuesto, igual filosofía que
 * footage/fixture.ts — permite probar el pipeline del Visual Director sin
 * OPENAI_API_KEY ni gasto real.
 */
function svgDataUri(prompt: string, seed: number): string {
  const colors = ["1e293b", "312e81", "581c87", "7c2d12", "134e4a"];
  const color = colors[seed % colors.length];
  const safePrompt = prompt.replace(/[<>&]/g, "").slice(0, 80);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'>` +
    `<rect width='100%' height='100%' fill='#${color}'/>` +
    `<text x='50%' y='50%' font-size='36' fill='white' text-anchor='middle' ` +
    `font-family='sans-serif'>${safePrompt}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

let counter = 0;

export const fixtureImageProvider: ImageProvider = {
  name: "fixture",
  capabilities: {
    id: "fixture",
    models: ["fixture-solid-color"],
    formats: ["image/svg+xml"],
    aspectRatios: ["9:16"],
    timeoutMs: 0,
    maxRetries: 0,
  },
  isAvailable() {
    return true;
  },
  async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
    counter += 1;
    const uri = svgDataUri(request.prompt, counter);
    const base64 = uri.split(",")[1] ?? "";
    return {
      buffer: Buffer.from(decodeURIComponent(base64), "utf8"),
      mimeType: "image/svg+xml",
      extension: "svg",
      width: 1080,
      height: 1920,
      model: "fixture-solid-color",
      costUsd: 0,
    };
  },
};
