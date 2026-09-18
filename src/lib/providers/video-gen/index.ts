import { requireRealProvider } from "../production";
import type { VideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureVideoProvider } from "./fixture";
import { runwayVideoProvider } from "./runway";

export function getVideoProvider(): VideoProvider {
  const flags = getFeatureFlags();
  const requested = flags.videoProvider;
  if (requested === "runway" && flags.premiumClipsEnabled && runwayVideoProvider.isAvailable()) {
    return runwayVideoProvider;
  }
  requireRealProvider("video premium", false);
  return fixtureVideoProvider;
}

export type { VideoProvider, VideoGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
