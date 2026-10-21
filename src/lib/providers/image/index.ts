import { ProviderConfigurationError, requireRealProvider } from "../production";
import type { ImageProvider } from "../types";
import { fixtureImageProvider } from "./fixture";
import { openaiImageProvider } from "./openai";
import { recraftImageProvider } from "./recraft";

export function getImageProvider(): ImageProvider {
  const requested = (process.env.IMAGE_PROVIDER || "fixture").trim();
  if (requested === "openai" && openaiImageProvider.isAvailable()) {
    return openaiImageProvider;
  }
  requireRealProvider("imagen", false);
  return fixtureImageProvider;
}

/**
 * Recraft V4 Styles (fal.ai) is NEVER selected by IMAGE_PROVIDER: only a Reel whose creator chose
 * «Imágenes IA con Recraft» (video_requests.reel_image_source = 'recraft') gets it, in the worker. Without FAL_KEY this
 * throws a clear configuration error (never the fixture, never another provider).
 */
export function getRecraftImageProvider(): ImageProvider {
  if (!recraftImageProvider.isAvailable()) {
    throw new ProviderConfigurationError("imagen (Recraft vía fal.ai: falta FAL_KEY en el worker)", ["FAL_KEY"]);
  }
  return recraftImageProvider;
}

export type { ImageProvider, ImageGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
