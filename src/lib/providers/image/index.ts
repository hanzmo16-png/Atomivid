import { ProviderConfigurationError, requireRealProvider } from "../production";
import type { ImageProvider } from "../types";
import { fixtureImageProvider } from "./fixture";
import { openaiImageProvider } from "./openai";
import { recraftImageProvider } from "./recraft";
import { fluxImageProvider } from "./flux";

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

/**
 * FLUX.1 [dev] (fal.ai) — the SECOND selectable image provider (Recraft stays the first). Like Recraft it is never
 * selected by IMAGE_PROVIDER: only a video whose creator chose «Imágenes IA con FLUX» (reel_image_source = 'flux', or a
 * Long Form plan pinning image "flux") gets it, in the worker. Without FAL_KEY: clear configuration error, never a
 * fixture or another provider.
 */
export function getFluxImageProvider(): ImageProvider {
  if (!fluxImageProvider.isAvailable()) {
    throw new ProviderConfigurationError("imagen (FLUX vía fal.ai: falta FAL_KEY en el worker)", ["FAL_KEY"]);
  }
  return fluxImageProvider;
}

export type { ImageProvider, ImageGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
