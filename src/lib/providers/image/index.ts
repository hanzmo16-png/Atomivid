import { requireRealProvider } from "../production";
import type { ImageProvider } from "../types";
import { fixtureImageProvider } from "./fixture";
import { openaiImageProvider } from "./openai";

export function getImageProvider(): ImageProvider {
  const requested = (process.env.IMAGE_PROVIDER || "fixture").trim();
  if (requested === "openai" && openaiImageProvider.isAvailable()) {
    return openaiImageProvider;
  }
  requireRealProvider("imagen", false);
  return fixtureImageProvider;
}

export type { ImageProvider, ImageGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
