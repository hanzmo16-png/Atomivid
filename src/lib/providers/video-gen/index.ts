import { requireRealProvider } from "../production";
import type { VideoProvider } from "../types";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { fixtureVideoProvider } from "./fixture";
import { runwayVideoProvider } from "./runway";
import { klingVideoProvider } from "./kling";
import { veoVideoProvider } from "./veo";

/**
 * Registro de VideoProvider — Runway sigue siendo el único candidato
 * "real" ya aceptado en producción; Kling/Veo (P2A) se agregan aquí con el
 * MISMO patrón de selección (VIDEO_PROVIDER + PREMIUM_CLIPS_ENABLED +
 * isAvailable()) para que un futuro proveedor verificado pueda activarse
 * sin tocar esta función de nuevo — pero como kling.ts/veo.ts NUNCA
 * intentan una llamada real todavía (ver sus comentarios de cabecera:
 * contrato no verificado contra doc primaria), seleccionarlos aquí no
 * cambia ningún default de producción ni habilita gasto real.
 */
export function getVideoProvider(): VideoProvider {
  const flags = getFeatureFlags();
  const requested = flags.videoProvider;
  if (requested === "runway" && flags.premiumClipsEnabled && runwayVideoProvider.isAvailable()) {
    return runwayVideoProvider;
  }
  if (requested === "kling" && flags.premiumClipsEnabled && klingVideoProvider.isAvailable()) {
    return klingVideoProvider;
  }
  if (requested === "veo" && flags.premiumClipsEnabled && veoVideoProvider.isAvailable()) {
    return veoVideoProvider;
  }
  requireRealProvider("video premium", false);
  return fixtureVideoProvider;
}

export type { VideoProvider, VideoGenerationRequest, GenerativeAsset, GenerativeCapabilities } from "../types";
export { GenerativeProviderError } from "../types";
