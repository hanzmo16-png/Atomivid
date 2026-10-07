/** Read-only cost preflight of the CONFIRMED Gucci production plan.
 * Reads the persisted plan, validates it with the worker's own validator, recomputes
 * it locally to detect drift, and reads supply policies/capacity. No writes, no
 * provider calls, no render. Prints counts, rates and USD only. */
import { createClient } from "@supabase/supabase-js";
import { computeProductionPlan, resolveExecutablePlan, getGenerativeUnitCosts, getRealLongFormProviderNames, strategyLimits, type ProductionPlan } from "../src/lib/video/long-form/production-plan";
import { getLongFormBudget } from "../src/lib/video/long-form/cost";
import { getPricingConfig } from "../src/lib/billing/pricing";
import { editorialApprovalError } from "../src/lib/video/long-form/editorial";

async function main() {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.ELEVENLABS_API_KEY) throw Error("Provider credentials must not be present");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id,status");
  const job = jobs!.find(j => j.id.startsWith("7b7d4b60"))!;
  const { data: r, error } = await db.from("video_requests").select("status,mode,duration_seconds,render_attempts,render_started_at,video_path,long_form_confirmed_at,long_form_production_plan,script_json,long_form_stage").eq("id", job.request_id).single();
  if (error || !r) throw Error("read");
  const plan = r.long_form_production_plan as ProductionPlan & Record<string, unknown>;
  const script = r.script_json as { topic: string; beats: { id: string; type: never; narration: string; visuals?: unknown[] }[] };
  console.log("STATE", JSON.stringify({ jobStatus: job.status, requestStatus: r.status, confirmedAt: r.long_form_confirmed_at, renderAttempts: r.render_attempts, renderStarted: r.render_started_at,
    hasVideo: !!r.video_path, stage: r.long_form_stage, beats: script.beats.length, visualPlans: script.beats.reduce((n, b) => n + (b.visuals?.length ?? 0), 0), editorialApproval: editorialApprovalError(script as never) ?? "valid" }));

  const { scriptHash: _h, beatShotCounts, packaging, ...persisted } = plan;
  console.log("PLAN_PERSISTED", JSON.stringify({ ...persisted, beatShotCounts, packaging }));
  let executable = "valid";
  try { resolveExecutablePlan({ confirmedAt: r.long_form_confirmed_at, plan, beats: script.beats }); } catch (e) { executable = e instanceof Error ? e.message : "invalid"; }
  console.log("EXECUTABLE", JSON.stringify({ resolveExecutablePlan: executable }));

  // Local recompute with the same engine (aiVideoAvailable pinned to the confirmed value).
  const recomputed = computeProductionPlan({ beats: script.beats, topic: script.topic, strategy: plan.strategy, providers: plan.providers ?? getRealLongFormProviderNames(),
    aiVideoEnabled: plan.aiVideoAvailable ?? false, requestedDurationSeconds: r.duration_seconds ?? undefined });
  const keys = ["shotCount", "stockVideoCount", "stockImageCount", "aiImageCount", "aiVideoClipCount", "aiVideoSeconds", "aiVideoBilledSeconds", "voiceCharacters", "scriptHash",
    "estimatedVoiceCostUsd", "estimatedImageCostUsd", "estimatedAiVideoCostUsd", "estimatedProviderCostUsd"] as const;
  const drift = keys.filter(k => JSON.stringify(recomputed[k]) !== JSON.stringify(plan[k])).map(k => ({ field: k, persisted: plan[k], recomputed: recomputed[k] }));
  console.log("RECOMPUTE_DRIFT", JSON.stringify({ drift, allocationPersisted: plan.allocation, allocationRecomputed: recomputed.allocation }));

  const pricing = getPricingConfig(), units = getGenerativeUnitCosts(plan.providers?.aiVideo), budget = getLongFormBudget();
  const limits = strategyLimits(plan.strategy, plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled: plan.aiVideoAvailable ?? false, units });
  console.log("RATES_LOCAL_DEFAULTS", JSON.stringify({ elevenLabsUsdPer1kChars: pricing.elevenLabsUsdPer1kChars, imageUsd: units.imageUsd, aiVideoClipUsd: units.veoClipUsd,
    aiVideoBilledSecondsPerClip: units.veoBilledSeconds, longFormBudget: budget, strategyLimits: { maxAiImageGenerations: limits.maxAiImageGenerations, maxAiVideoClips: limits.maxAiVideoClips, maxGenerativeUsd: limits.maxGenerativeUsd } }));

  const { data: policies } = await db.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,daily_cap_usd,monthly_cap_usd,max_concurrent,baseline,updated_at");
  console.log("SUPPLY_POLICIES", JSON.stringify(policies?.filter(p => ["__global__", "elevenlabs", "openai", "veo", "runway", "beatoven", "anthropic"].includes(p.provider))));
  const snaps: Record<string, unknown> = {};
  for (const provider of ["elevenlabs", "openai", "veo", "runway", "beatoven"]) {
    const { data } = await db.from("pi_capacity_snapshots").select("*").eq("provider", provider).order("checked_at", { ascending: false }).limit(1);
    snaps[provider] = data?.[0] ?? null;
  }
  console.log("CAPACITY_SNAPSHOTS", JSON.stringify(snaps));
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: month } = await db.from("pi_paid_operations").select("provider,committed_usd,reserved_usd,status").gte("created_at", monthStart.toISOString()).neq("method", "capacity_hold");
  const byProvider: Record<string, { committed: number; openReserved: number }> = {};
  for (const o of month ?? []) {
    const p = (byProvider[o.provider] ??= { committed: 0, openReserved: 0 });
    p.committed += Number(o.committed_usd ?? 0);
    if (["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status)) p.openReserved += Number(o.reserved_usd ?? 0);
  }
  console.log("MONTH_TO_DATE_LEDGER", JSON.stringify(Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, { committed: +v.committed.toFixed(4), openReserved: +v.openReserved.toFixed(4) }]))));
  const { data: reservations } = await db.from("pi_supply_job_reservations").select("*").limit(20);
  console.log("JOB_RESERVATIONS", JSON.stringify({ count: reservations?.length ?? 0, forGucci: (reservations ?? []).filter(x => JSON.stringify(x).includes(job.request_id)).length }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
