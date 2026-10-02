import { requireRealProvider } from "../production";
import { fixtureVfxProvider } from "./fixture";
import { lumaVfxProvider } from "./luma";
import type { VfxProvider } from "./types";

/**
 * VFX provider registry (VFX Provider V1). VFX_PROVIDER selects the adapter; only Luma exists
 * today. Selecting Luma never enables spend by itself: while its contract is unverified every
 * paid request is refused before the ledger (see luma.ts and paid-calls/gated-vfx.ts).
 */
export function getVfxProvider(requested = process.env.VFX_PROVIDER?.trim()): VfxProvider {
  if (requested === "luma" && lumaVfxProvider.isAvailable()) return lumaVfxProvider;
  requireRealProvider("VFX", false, requested === "luma" ? ["LUMA_API_KEY"] : ["VFX_PROVIDER"]);
  return fixtureVfxProvider;
}

export type { VfxProvider, VfxTransformRequest, VfxAsset, VfxCapabilities, TransformSceneInput } from "./types";
