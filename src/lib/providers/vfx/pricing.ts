/**
 * VFX cost engine: pre-call estimate from a price table, and the budget check that must pass before
 * any paid VFX request. Only a `verified` price can produce an estimate; a missing price (another
 * resolution, duration, HDR…) throws, so an unknown price can never let a paid call through. The
 * provider's account balance is NOT a budget.
 */
import { GenerativeProviderError } from "../types";
import type { VfxDynamicRange, VfxResolution } from "./types";

export type VfxPrice = {
  provider: string;
  model: string;
  requestType: string;
  resolution: VfxResolution;
  dynamicRange: VfxDynamicRange;
  /** Billed duration of the output, in seconds (the table is per duration step). */
  durationSeconds: number;
  usd: number;
  verified: boolean;
  source: string;
};

const LUMA_SOURCE =
  "Ray 3.2 video_edit standard/SDR price table authorized by the owner on 2026-10-02; units (360p/540p/720p/1080p, 5s/10s) match the official " +
  "luma-agents 0.5.0 SDK enums (VideoResolution, VideoDuration).";
const lumaPrice = (resolution: VfxResolution, durationSeconds: number, usd: number): VfxPrice => ({ provider: "luma", model: "ray-3.2", requestType: "video_edit", resolution, dynamicRange: "sdr", durationSeconds, usd, verified: true, source: LUMA_SOURCE });

export const VFX_PRICES: readonly VfxPrice[] = [
  lumaPrice("360p", 5, 0.54), lumaPrice("360p", 10, 1.08),
  lumaPrice("540p", 5, 0.72), lumaPrice("540p", 10, 1.44),
  lumaPrice("720p", 5, 1.08), lumaPrice("720p", 10, 2.16),
  lumaPrice("1080p", 5, 2.16), lumaPrice("1080p", 10, 4.32),
];

/** A source within this many seconds of a priced step is billed as that step. */
export const VFX_DURATION_TOLERANCE_SECONDS = 0.05;

export type VfxPriceQuery = { provider: string; model: string; requestType: string; resolution: VfxResolution; dynamicRange: VfxDynamicRange; durationSeconds: number };

export function findVfxPrice(q: VfxPriceQuery, prices: readonly VfxPrice[] = VFX_PRICES): VfxPrice | undefined {
  return prices.find((p) => p.provider === q.provider && p.model === q.model && p.requestType === q.requestType && p.resolution === q.resolution && p.dynamicRange === q.dynamicRange && Math.abs(p.durationSeconds - q.durationSeconds) <= VFX_DURATION_TOLERANCE_SECONDS);
}

/**
 * Estimate usable before a paid call. Durations between steps are NOT interpolated: the billing
 * rule for them is not documented, so the source must be trimmed to a priced step (5 s or 10 s).
 */
export function estimateVfxCostUsd(q: VfxPriceQuery, prices: readonly VfxPrice[] = VFX_PRICES): number {
  const price = findVfxPrice(q, prices);
  if (!price) throw new GenerativeProviderError(`VFX: no hay precio verificado para ${q.provider}/${q.model} ${q.requestType} ${q.resolution} ${q.dynamicRange} ${q.durationSeconds.toFixed(2)} s`, q.provider, "contract_unverified", undefined, undefined, "not_sent");
  if (!price.verified) throw new GenerativeProviderError(`VFX: el precio de ${q.provider}/${q.model} no está verificado`, q.provider, "contract_unverified", undefined, undefined, "not_sent");
  return price.usd;
}

export type VfxBudget = {
  /** Absolute cap for the whole production (e.g. VFX-001: 5.00). */
  hardCapUsd: number;
  /** Already committed in the ledger for this production. */
  committedUsd: number;
  /** Reserved by other in-flight paid operations of this production. */
  reservedUsd: number;
};

/** estimated + committed + reserved must fit the hard cap, and the estimate must fit the per-operation max. */
export function assertVfxBudget(provider: string, estimateUsd: number, maxCostUsd: number, budget: VfxBudget): void {
  const total = estimateUsd + budget.committedUsd + budget.reservedUsd;
  if (!Number.isFinite(maxCostUsd) || estimateUsd > maxCostUsd + 1e-9) {
    throw new GenerativeProviderError(`VFX: estimado USD ${estimateUsd.toFixed(2)} supera el máximo de la operación (USD ${maxCostUsd})`, provider, "budget_exceeded", undefined, undefined, "not_sent");
  }
  if (!Number.isFinite(budget.hardCapUsd) || total > budget.hardCapUsd + 1e-9) {
    throw new GenerativeProviderError(`VFX: estimado + comprometido + reservado = USD ${total.toFixed(2)} supera el tope absoluto (USD ${budget.hardCapUsd})`, provider, "budget_exceeded", undefined, undefined, "not_sent");
  }
}
