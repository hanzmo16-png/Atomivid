import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript } from "@/lib/providers/types";
import type { ProductionPlan } from "@/lib/video/long-form/production-plan-types";
import { getFeatureFlags, type FeatureFlags } from "@/lib/video/feature-flags";
import { getPricingConfig } from "@/lib/billing/pricing";
import { SupplyUnavailableError } from "./policy";
import { supplyGuardRequired } from "./server";
import { ledgerUsd } from "@/lib/paid-calls/ledger-usd";

/**
 * The attempt already holds an envelope smaller than what this process now demands: the per-production
 * caps of the starter (Vercel) and the worker disagree. A configuration inconsistency, NOT a balance
 * wait: retrying later can never succeed, so it must fail loudly instead of queueing forever.
 */
export class JobEnvelopeMismatchError extends Error {
  // Control de costos (2026-10-18): raised when the attempt's envelope is (re)reserved, before the run's first
  // paid call — but a resumed attempt may hold earlier paid steps, so only «nothing new» is proven.
  readonly customerMessage = "La configuración de límites de producción no coincide entre el inicio y el procesamiento. No se hizo ninguna llamada de pago nueva y tus avances se conservan; avisa a soporte para corregirla antes de reintentar.";
  readonly diagnosticId = "SUPPLY-ENVELOPE";
  constructor(readonly provider: string) {
    super(`SUPPLY_ENVELOPE_MISMATCH:${provider}`);
    this.name = "JobEnvelopeMismatchError";
  }
}

/**
 * Control de costos (2026-10-18): a paid call of a RUNNING production did not fit in what remains of its
 * attempt's envelope ("job envelope exhausted"). The call was refused before reaching the provider, but
 * earlier steps of the same attempt may already have been paid: never claim that nothing was charged.
 */
export class JobEnvelopeExhaustedError extends Error {
  readonly customerMessage = "La producción se detuvo antes de superar el presupuesto reservado para este intento. Los pasos ya hechos se conservan y pueden haber tenido costo; no se repetirá ningún gasto sin revisión. Avisa a soporte para continuar.";
  readonly diagnosticId = "SUPPLY-ENVELOPE-USED";
  constructor(readonly provider: string) {
    super(`SUPPLY_ENVELOPE_EXHAUSTED:${provider}`);
    this.name = "JobEnvelopeExhaustedError";
  }
}

export type JobSupplyDemand = { provider: string; unit: "usd" | "character"; units: number; usd: number;
  /** New provider calls this job will make. When given, the provider's daily call quota must have room for all of them. */
  calls?: number };
export type SupplyJobInput = { mode: string | null; script_json: unknown; recorded_audio_path: string | null; long_form_production_plan: ProductionPlan | null };

/** Conservative envelopes, not an account balance or a quote. Runtime rates must be verified. */
export function jobSupplyDemands(row: SupplyJobInput, voiceProvider: string, flags: FeatureFlags = getFeatureFlags(),
  /** Anexo C1: new Director material the owner approved for this start (render route only; 0 elsewhere). */
  opts: { directorMaterialUsd?: number; recraftUsd?: number } = {}): JobSupplyDemand[] {
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
    // Podcast 2.0 (2026-10-21): each TTS call is admitted with its OWN cost rounded up to the ledger's 4 decimals
    // (ceilLedgerUsd). Reserving ceil(total) under-counted: 2 × ceil(486 chars) > ceil(972 chars) → SUPPLY-ENVELOPE-USED
    // (video 13d20347). Reserve the sum of the per-call ceilings: never less than what the calls will consume.
    add(voiceProvider, voiceEnvelopeUsd(mode, text, script, getPricingConfig().elevenLabsUsdPer1kChars), chars, "character");
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
    // The owner's approved ceiling for new Director material is reserved in the SAME image envelope, so the atomic
    // per-call admission (pi_submit_with_supply) bounds it. Recomputing without it (worker, resume) asks for less,
    // which the reservation accepts (it only refuses a LARGER envelope).
    if ((opts.directorMaterialUsd ?? 0) > 0) add(flags.imageProvider, opts.directorMaterialUsd!);
    // «Imágenes IA con Recraft» (per-video choice): one image per scene at the published fal price (recraft-reel.ts).
    if ((opts.recraftUsd ?? 0) > 0) add("recraft", opts.recraftUsd!);
    // Includes the existing one repair call. This is a ceiling, never an automatic purchase.
    if (flags.visualDirectorEnabled) add("anthropic", Number(process.env.SUPPLY_STORYBOARD_RESERVATION_USD || "2"));
    // generateVideoFromScript currently uses stock footage and optional images;
    // it never invokes VideoProvider. Global premium flags must not reserve or
    // require an unused video provider. Long-form AI clips are covered above by
    // the confirmed plan; any future Reel integration must add its demand here.
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

/** Sum of per-call ledger reservations for the narration calls of one attempt (Reel: original + one pacing
 * correction; long form: one ledger row per beat — production-tts-cache.ts guards each beat, a long beat is split
 * inside that call; others: one call). Each call is priced exactly as the gate records it (`ledgerUsd`: strict
 * ceiling to 0.0001, no tolerance) and the total is never below the previous raw estimate. Exported for tests. */
export function voiceEnvelopeUsd(mode: string, text: string, script: { beats?: { narration: string }[] } | null | undefined, usdPer1kChars: number): number {
  const callCost = (n: number) => (n > 0 ? ledgerUsd(n / 1000 * usdPer1kChars) : 0);
  const beats = mode === "long_form" ? (script?.beats ?? []).filter((b) => b.narration.length > 0) : [];
  const calls = mode === "visual" ? 2 : 1;
  const sum = beats.length > 0 ? beats.reduce((s, b) => s + callCost(b.narration.length), 0) : calls * callCost(text.length);
  const raw = text.length * calls / 1000 * usdPer1kChars;
  // Las piezas son múltiplos de 0.0001: se redondea la suma para no arrastrar ruido de coma flotante.
  return Math.max(Math.round(sum * 10_000) / 10_000, raw);
}
