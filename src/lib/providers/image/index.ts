import type { ImageProvider } from "../types";
import { fixtureImageProvider } from "./fixture";
import { openaiImageProvider } from "./openai";

/**
 * Mismo patrón que getFootageProvider()/getMusicProvider(): si se pide
 * "openai" pero falta OPENAI_API_KEY, cae a fixture en vez de fallar al
 * arrancar — una integración opcional desactivada nunca debe tumbar el
 * pipeline (ver feature-flags.ts).
 */
export function getImageProvider(): ImageProvider {
  const requested = (process.env.IMAGE_PROVIDER || "fixture").trim();
  if (requested === "openai" && openaiImageProvider.isAvailable()) {
    return openaiImageProvider;
  }
  return fixtureImageProvider;
}

export type { ImageProvider, ImageGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
