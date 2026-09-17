import type { AvatarVideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureAvatarProvider } from "./fixture";
import { heygenAvatarProvider } from "./heygen";
import { didAvatarProvider } from "./did";

/**
 * Mismo patrón que getImageProvider()/getVideoProvider(): un proveedor
 * real nunca se devuelve a menos que AVATAR_PROVIDER coincida Y su API key
 * esté presente — sin eso, cae a fixture, nunca a un error duro. El modo
 * "avatar" del producto además requiere AVATAR_MODE_ENABLED=true en la
 * capa de pipeline (ver feature-flags.ts) — este selector solo decide
 * QUÉ proveedor, no SI el modo avatar está disponible para el usuario.
 *
 * D-ID (providers/avatar/did.ts) es, según la comparación documentada en
 * docs/AVATAR_MODE.md, el candidato más fuerte para el caso de uso de
 * ATOMIVID — pero, igual que HeyGen, NO está verificado contra su
 * documentación oficial primaria (docs.d-id.com bloqueado en este
 * entorno). No presentarlo como production-ready.
 */
export function getAvatarProvider(): AvatarVideoProvider {
  const flags = getFeatureFlags();
  if (flags.avatarProvider === "heygen" && heygenAvatarProvider.isAvailable()) {
    return heygenAvatarProvider;
  }
  if (flags.avatarProvider === "did" && didAvatarProvider.isAvailable()) {
    return didAvatarProvider;
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
