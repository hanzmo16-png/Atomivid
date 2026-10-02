/**
 * VFX cost engine: pre-call estimate from a rate table, and the budget check that must pass before
 * any paid VFX request. Only a rate marked `verified` (checked against the provider's primary
 * pricing page and confirmed by a human) can produce an estimate; an unverified rate throws, so an
 * unknown price can never let a paid call through. The provider's account balance is NOT a budget.
 */
import { GenerativeProviderError } from "../types";

export type VfxRate = {
  provider: string;
  model: string;
  /** per_megapixel: USD per million OUTPUT pixels (width × height × fps × seconds). */
  basis: "per_megapixel" | "per_second";
  usd: number;
  verified: boolean;
  /** Where the number comes from, and when it was read. */
  source: string;
};

/**
 * Luma Modify Video (Dream Machine API v1). The models come from the official SDK (npm lumaai
 * 1.19.1, generated from Luma's OpenAPI spec). The rates do NOT: docs.lumalabs.ai is blocked by
 * this environment's network policy and they were only read from a search-result snippet of
 * docs.lumalabs.ai/docs/modify-video (2026-10-02). They reproduce that page's own examples
 * (ray-2, 720p, 5 s, 16:9 → USD 1.75; ray-flash-2 → USD 0.60 at 24 fps), but stay unverified until
 * a human confirms them on the primary page.
 */
export const VFX_RATES: readonly VfxRate[] = [
  { provider: "luma", model: "ray-2", basis: "per_megapixel", usd: 0.01582, verified: false, source: "search snippet of docs.lumalabs.ai/docs/modify-video, 2026-10-02 (primary page blocked)" },
  { provider: "luma", model: "ray-flash-2", basis: "per_megapixel", usd: 0.00544, verified: false, source: "search snippet of docs.lumalabs.ai/docs/modify-video, 2026-10-02 (primary page blocked)" },
];

export type VfxOutputShape = { width: number; height: number; fps: number; durationSeconds: number };

export function findVfxRate(provider: string, model: string, rates: readonly VfxRate[] = VFX_RATES): VfxRate | undefined {
  return rates.find((r) => r.provider === provider && r.model === model);
}

/** Cost from a rate, rounded UP to the cent (never under-reserve). Pure: ignores `verified`. */
export function costFromRate(rate: VfxRate, out: VfxOutputShape): number {
  if (![out.width, out.height, out.fps, out.durationSeconds].every((n) => Number.isFinite(n) && n > 0)) throw new GenerativeProviderError("VFX: forma de salida inválida para estimar costo", rate.provider, "invalid_request");
  const raw = rate.basis === "per_megapixel" ? ((out.width * out.height * out.fps * out.durationSeconds) / 1e6) * rate.usd : out.durationSeconds * rate.usd;
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

/** Estimate usable before a paid call: refuses (no network, no ledger row) when the rate is missing or unverified. */
export function estimateVfxCostUsd(provider: string, model: string, out: VfxOutputShape, rates: readonly VfxRate[] = VFX_RATES): number {
  const rate = findVfxRate(provider, model, rates);
  if (!rate) throw new GenerativeProviderError(`VFX: no hay tarifa para ${provider}/${model}`, provider, "contract_unverified");
  if (!rate.verified) throw new GenerativeProviderError(`VFX: la tarifa de ${provider}/${model} no está verificada contra la documentación primaria`, provider, "contract_unverified");
  return costFromRate(rate, out);
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
    throw new GenerativeProviderError(`VFX: estimado USD ${estimateUsd.toFixed(2)} supera el máximo de la operación (USD ${maxCostUsd})`, provider, "budget_exceeded");
  }
  if (!Number.isFinite(budget.hardCapUsd) || total > budget.hardCapUsd + 1e-9) {
    throw new GenerativeProviderError(`VFX: estimado + comprometido + reservado = USD ${total.toFixed(2)} supera el tope absoluto (USD ${budget.hardCapUsd})`, provider, "budget_exceeded");
  }
}
