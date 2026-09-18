import { requireRealProvider } from "../production";
import type { AvatarVideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureAvatarProvider } from "./fixture";
import { heygenAvatarProvider } from "./heygen";
import { didAvatarProvider } from "./did";

/** Real providers are required in production; disabled features are not selected. */
export function getAvatarProvider(): AvatarVideoProvider {
  const flags = getFeatureFlags();
  if (flags.avatarProvider === "heygen" && heygenAvatarProvider.isAvailable()) {
    return heygenAvatarProvider;
  }
  if (flags.avatarProvider === "did" && didAvatarProvider.isAvailable()) {
    return didAvatarProvider;
  }
  requireRealProvider("avatar", false);
  return fixtureAvatarProvider;
}

export type {
  AvatarVideoProvider,
  AvatarCreationRequest,
  AvatarCreationResult,
  AvatarVideoRequest,
  AvatarVideoResult,
  AvatarJobStatus,
} from "../types";
export { AvatarProviderError } from "../types";
