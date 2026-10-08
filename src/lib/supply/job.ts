import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript } from "@/lib/providers/types";
import type { ProductionPlan } from "@/lib/video/long-form/production-plan-types";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { getPricingConfig } from "@/lib/billing/pricing";
import { SupplyUnavailableError } from "./policy";
import { supplyGuardRequired } from "./server";

/**
 * The attempt already holds an envelope smaller than what this process now demands: the per-production
 * caps of the starter (Vercel) and the worker disagree. A configuration inconsistency, NOT a balance
 * wait: retrying later can never succeed, so it must fail loudly instead of queueing forever.
 */
export class JobEnvelopeMismatchError extends Error {
  readonly customerMessage = "La configuración de límites de producción no coincide entre el inicio y el procesamiento. No se generó ni se cobró nada; avisa a soporte para corregirla antes de reintentar.";
  readonly diagnosticId = "SUPPLY-ENVELOPE";
  constructor(readonly provider: string) {
    super(`SUPPLY_ENVELOPE_MISMATCH:${provider}`);
    this.name = "JobEnvelopeMismatchError";
  }
}

export type JobSupplyDemand = { provider: string; unit: "usd" | "character"; units: number; usd: number };
export type SupplyJobInput = { mode: string | null; script_json: unknown; recorded_audio_path: string | null; long_form_production_plan: ProductionPlan | null };

/** Conservative envelopes, not an account balance or a quote. Runtime rates must be verified. */
export function jobSupplyDemands(row: SupplyJobInput, voiceProvider: string, flags: FeatureFlags = getFeatureFlags()): JobSupplyDemand[] {
  const demands = new Map<string, JobSupplyDemand>();
  const add = (provider: string, usd: number, units = usd, unit: JobSupplyDemand["unit"] = "usd") => {
    if (provider === "fixture" || provider === "curated-library" || usd === 0) return;
    if (!Number.isFinite(usd) || !Number.isFinite(units) || usd < 0 || units <= 0) throw new SupplyUnavailableError(provider, "job cost unverified");
    const prev = demands.get(provider);
    demands.set(provider, { provider, unit, units: units + (prev?.units ?? 0), usd: usd + (prev?.usd ?? 0) });
  };
  const mode = row.mode ?? "visual";
  const script = row.script_json as GeneratedScript & { beats?: { narration: string }[] };
  const text = mode === "long_form" ? (script?.beats ?? []).map(b => b.narration).join(" ") : (script?.segments ?? []).map(s => s.text).join(" ");
  if (!(mode === "avatar" && row.recorded_audio_path) && voiceProvider !== "fixture") {
    // Reel allows one pacing correction. Long-form narrations have one call per beat.
    const chars = text.length * (mode === "visual" ? 2 : 1);
    if (!chars) throw new SupplyUnavailableError(voiceProvider, "empty narration");
    add(voiceProvider, chars / 1000 * getPricingConfig().elevenLabsUsdPer1kChars, chars, "character");
  }
  if (mode === "avatar") add(flags.avatarProvider, flags.maxAvatarCostUsd);
  else if (mode === "long_form") {
    const plan = row.long_form_production_plan;
    if (!plan) throw new SupplyUnavailableError("production", "confirmed plan unavailable");
    // Shared generative cap covers reference images, replacements and video clips.
    const cap = plan.allocation?.maxGenerativeUsd ?? Math.max(0, plan.estimatedProviderCostUsd - (plan.estimatedVoiceCostUsd ?? 0));
    if (plan.allocation?.maxAiImageGenerations || plan.aiImageCount) add(plan.providers.image, cap);
    if (plan.allocation?.maxAiVideoClips || plan.aiVideoClipCount) add(plan.providers.aiVideo, cap);
  } else {
    if (flags.imageGenerationEnabled) add(flags.imageProvider, flags.maxVisualCostUsd);
    // Includes the existing one repair call. This is a ceiling, never an automatic purchase.
    if (flags.visualDirectorEnabled) add("anthropic", Number(process.env.SUPPLY_STORYBOARD_RESERVATION_USD || "2"));
    if (flags.premiumClipsEnabled) add(flags.videoProvider, flags.maxPremiumVideoCostUsd);
  }
  if (flags.musicProvider === "beatoven") add("beatoven", flags.maxMusicCostUsd);
  return [...demands.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function reserveJobSupply(service: SupabaseClient, requestId: string, attempt: number, demands: JobSupplyDemand[]): Promise<void> {
  if (!supplyGuardRequired()) return;
  const { data, error } = await service.rpc("pi_reserve_job_supply", { p_request_id: requestId, p_attempt: attempt, p_demands: demands });
  const result = data as { reserved?: boolean; reason?: string; provider?: string } | null;
  if (!error && result?.reserved === false && result.reason === "job envelope changed") throw new JobEnvelopeMismatchError(result.provider ?? "production");
  if (error || !result?.reserved) throw new SupplyUnavailableError(result?.provider ?? "production", result?.reason ?? "job reservation unavailable");
}
export async function releaseUnusedJobSupply(service: SupabaseClient, requestId: string, attempt: number): Promise<void> {
  if (!supplyGuardRequired()) return;
  const { error } = await service.rpc("pi_release_job_supply", { p_request_id: requestId, p_attempt: attempt });
  if (error) throw new Error("SUPPLY_UNUSED_RESERVATION_UNCONFIRMED");
}
