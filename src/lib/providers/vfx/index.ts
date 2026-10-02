import { requireRealProvider } from "../production";
import { fixtureVfxProvider } from "./fixture";
import { lumaVfxProvider } from "./luma";
import type { VfxProvider } from "./types";

/**
 * VFX provider registry (VFX Provider V1). VFX_PROVIDER selects the adapter; only Luma (Ray 3.2
 * video_edit) exists today. No router yet: future adapters (Runway, Kling…) plug in here behind the
 * same VfxProvider contract. Selecting a provider never spends by itself: every paid request goes
 * through paid-calls/gated-vfx.ts (verified price, hard cap, ledger).
 */
export function getVfxProvider(requested = process.env.VFX_PROVIDER?.trim()): VfxProvider {
  if (requested === "luma" && lumaVfxProvider.isAvailable()) return lumaVfxProvider;
  requireRealProvider("VFX", false, requested === "luma" ? ["LUMA_API_KEY"] : ["VFX_PROVIDER"]);
  return fixtureVfxProvider;
}

export type { VfxProvider, VfxTransformRequest, VfxAsset, VfxCapabilities, TransformSceneInput } from "./types";
