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
  // El AVATAR_PROVIDER configurado decide qué variable falta de verdad —
  // nunca se adivina, nunca se muestra al usuario (ver ProviderConfigurationError),
  // solo queda disponible server-side para correlacionar con el diagnosticId.
  const missingEnvVars =
    flags.avatarProvider === "did" ? ["DID_API_KEY"] : flags.avatarProvider === "heygen" ? ["HEYGEN_API_KEY"] : [];
  requireRealProvider("avatar", false, missingEnvVars);
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
