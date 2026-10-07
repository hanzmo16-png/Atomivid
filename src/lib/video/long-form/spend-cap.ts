import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionPlanAllocation } from "./production-plan-types";

/** Conservative per-call prices: never below the configured estimate NOR below
 * the highest real billed cost the ledger has recorded for that call, rounded
 * UP to the cent. Reservations made with these prices cover the known cost. */
export type ConservativeUnits = { imageUsd: number; clipUsd: number; voiceUsdPer1kChars: number };
export type ObservedMax = { imageUsd?: number; clipUsd?: number };

const ceilCent = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;
export function conservativeUnits(estimates: ConservativeUnits, observed: ObservedMax): ConservativeUnits {
  return {
    imageUsd: ceilCent(Math.max(estimates.imageUsd, observed.imageUsd ?? 0)),
    clipUsd: ceilCent(Math.max(estimates.clipUsd, observed.clipUsd ?? 0)),
    voiceUsdPer1kChars: estimates.voiceUsdPer1kChars,
  };
}

/** Highest committed cost per call already billed (read-only ledger query). */
export async function loadObservedMax(supabase: SupabaseClient, providers: { image: string; aiVideo: string }): Promise<ObservedMax> {
  const max = async (provider: string, method: string) => {
    const { data, error } = await supabase.from("pi_paid_operations").select("committed_usd")
      .eq("provider", provider).eq("method", method).eq("status", "COMMITTED").order("committed_usd", { ascending: false }).limit(1);
    if (error) throw new Error("No se pudo leer el costo real registrado; no se inicia ninguna llamada pagada.");
    const value = Number(data?.[0]?.committed_usd);
    return Number.isFinite(value) ? value : undefined;
  };
  return { imageUsd: await max(providers.image, "generate_image"), clipUsd: await max(providers.aiVideo, "generate_video") };
}

/** Worst case of the CONFIRMED plan with conservative prices: every allocated
 * image and clip plus the exact narration characters. */
export function conservativeWorstCaseUsd(plan: { voiceCharacters: number; allocation: ProductionPlanAllocation }, units: ConservativeUnits): number {
  const voice = (plan.voiceCharacters / 1000) * units.voiceUsdPer1kChars;
  return ceilCent(voice + plan.allocation.maxAiImageGenerations * units.imageUsd + plan.allocation.maxAiVideoClips * units.clipUsd);
}

export class SpendCapExceededError extends Error {
  constructor(readonly worstCaseUsd: number, readonly capUsd: number) {
    super(`El peor caso conservador del plan confirmado (USD ${worstCaseUsd.toFixed(2)}) supera el tope por producción (USD ${capUsd.toFixed(2)}). No se inició ninguna llamada pagada.`);
    this.name = "SpendCapExceededError";
  }
}

/** Per-production hard cap. The conservative worst case must fit inside the
 * configured ceiling BEFORE any paid call; the cap enforced per call is that worst case. */
export function productionHardCap(worstCaseUsd: number, ceilingUsd: number): number {
  if (worstCaseUsd > ceilingUsd + 1e-9) throw new SpendCapExceededError(worstCaseUsd, ceilingUsd);
  return worstCaseUsd;
}
