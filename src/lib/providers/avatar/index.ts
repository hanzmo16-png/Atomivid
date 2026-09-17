import type { AvatarVideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureAvatarProvider } from "./fixture";
import { heygenAvatarProvider } from "./heygen";

/**
 * Mismo patrón que getImageProvider()/getVideoProvider(): HeyGen nunca se
 * devuelve a menos que AVATAR_PROVIDER="heygen" Y HEYGEN_API_KEY esté
 * presente — sin eso, cae a fixture, nunca a un error duro. El modo
 * "avatar" del producto además requiere AVATAR_MODE_ENABLED=true en la
 * capa de pipeline (ver feature-flags.ts) — este selector solo decide
 * QUÉ proveedor, no SI el modo avatar está disponible para el usuario.
 */
export function getAvatarProvider(): AvatarVideoProvider {
  const flags = getFeatureFlags();
  if (flags.avatarProvider === "heygen" && heygenAvatarProvider.isAvailable()) {
    return heygenAvatarProvider;
  }
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
