import type { VideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureVideoProvider } from "./fixture";
import { runwayVideoProvider } from "./runway";

/**
 * Runway (u otro proveedor premium) NUNCA se devuelve a menos que:
 *  1) VIDEO_PROVIDER="runway", Y
 *  2) PREMIUM_CLIPS_ENABLED=true (interruptor de gasto explícito, ver
 *     feature-flags.ts — puede haber una clave configurada sin querer
 *     gastar), Y
 *  3) la clave RUNWAY_API_KEY esté presente.
 * Cualquier condición que falte cae a fixture, nunca a un error duro.
 */
export function getVideoProvider(): VideoProvider {
  const flags = getFeatureFlags();
  const requested = flags.videoProvider;
  if (requested === "runway" && flags.premiumClipsEnabled && runwayVideoProvider.isAvailable()) {
    return runwayVideoProvider;
  }
  return fixtureVideoProvider;
}

export type { VideoProvider, VideoGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
