/** Owner-authorized start of the Gucci long-form production (GUCCI_CINEMATIC_V3_PRODUCTION_AUTHORIZED,
 * MAX_SPEND_USD_4_00). Re-runs every gate, then performs exactly the steps of
 * POST /api/generate/[id]/render (render guard, quota, supply reservation,
 * compare-and-swap to processing). It makes no provider call itself; the
 * existing render worker is dispatched separately. Any failed gate stops here. */
import { createClient } from "@supabase/supabase-js";
import { resolveExecutablePlan, type ProductionPlan } from "../src/lib/video/long-form/production-plan";
import { editorialApprovalError } from "../src/lib/video/long-form/editorial";
import { evaluateRenderStart } from "../src/lib/video/render-guard";
import { assertCanGenerate } from "../src/lib/billing/quota";
import { jobSupplyDemands, reserveJobSupply } from "../src/lib/supply/job";
import { getMusicProvider } from "../src/lib/providers/music";
import { getFootageProvider } from "../src/lib/providers/footage";
import { getVoiceProvider } from "../src/lib/providers/voice";

const CAP_USD = 4.0, OPENAI_IMAGE_OBSERVED_USD = 0.056; // ledger max of 17 real calls
async function main() {
  const start = process.env.START === "true";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id,user_id,status,input");
  const job = jobs!.find(j => j.id.startsWith("7b7d4b60"))!;
  const { data: row, error } = await db.from("video_requests").select("id, mode, user_id, status, script_json, render_attempts, render_started_at, created_at, error_message, avatar_provider_video_job_id, long_form_confirmed_at, long_form_progress, long_form_production_plan, recorded_audio_path, supply_wait_started_at").eq("id", job.request_id).single();
  if (error || !row) throw Error("read");
  const plan = row.long_form_production_plan as ProductionPlan;
  const beats = (row.script_json as { beats: { id: string; type: never; narration: string; visuals?: unknown }[] }).beats;
  const fail: string[] = [];
  // Evidence recorded by production itself at enqueue: isInternalProductionOwner(user)
  // evaluated with Vercel's configuration for this exact owner.
  const internalOwnerAtEnqueue = (job.input as { recoverLegacyOperator?: boolean } | null)?.recoverLegacyOperator === true;
  console.log("OWNER_EVIDENCE", JSON.stringify({ internalOwnerAtEnqueue, envOwnerMatches: (process.env.INTERNAL_PRODUCTION_OWNER_USER_ID ?? "").toLowerCase() === row.user_id.toLowerCase() }));
  const check = (ok: boolean, what: string) => { if (!ok) fail.push(what); };
  check(row.mode === "long_form" && row.status === "script_ready" && row.render_attempts === 0 && !row.render_started_at, "state is script_ready with 0 attempts");
  check(!!row.long_form_confirmed_at, "production confirmed");
  check(plan?.version === 3 && plan.strategy === "cinematic", "plan is cinematic v3");
  check(JSON.stringify(plan?.providers) === JSON.stringify({ image: "openai", music: "curated-library", voice: "elevenlabs", aiVideo: "runway", footage: "pexels-video-first" }), "plan providers unchanged");
  check(plan?.aiImageCount === 39 && plan.aiVideoClipCount === 1 && plan.shotCount === 88 && plan.voiceCharacters === 5164, "plan composition unchanged");
  check(plan?.allocation?.maxAiImageGenerations === 40 && plan.allocation.maxAiVideoClips === 1 && plan.allocation.maxGenerativeUsd === 2.5, "allocation unchanged");
  try { resolveExecutablePlan({ confirmedAt: row.long_form_confirmed_at, plan, beats }); } catch (e) { fail.push(`executable plan: ${e instanceof Error ? e.message : "invalid"}`); }
  check(editorialApprovalError(row.script_json as never) === null, "editorial approval valid");
  const decision = evaluateRenderStart(row as never);
  check(decision.allowed, `render guard allows start${decision.allowed ? "" : `: ${decision.error}`}`);
  // Providers the worker will resolve (names only; no calls).
  const names = { voice: getVoiceProvider().name, footage: getFootageProvider().name, music: getMusicProvider().name };
  check(names.voice === "elevenlabs" && names.footage === "pexels-video-first" && names.music === "curated-library", "worker providers match the plan");
  check(process.env.RUNWAY_KEY_PRESENT === "true", "Runway connection configured");
  // Spend projection with the observed OpenAI image price and the hard allocation counts.
  const voiceUsd = plan.estimatedVoiceCostUsd ?? 0, imagesUsd = (plan.allocation?.maxAiImageGenerations ?? 0) * OPENAI_IMAGE_OBSERVED_USD, videoUsd = plan.estimatedAiVideoCostUsd ?? 0;
  const projected = +(voiceUsd + imagesUsd + videoUsd).toFixed(4);
  check(projected <= CAP_USD, `projected spend ${projected} <= ${CAP_USD}`);
  const demands = jobSupplyDemands(row as never, plan.providers.voice);
  console.log("GATES", JSON.stringify({ passed: fail.length === 0, failed: fail, providers: names, projected: { voiceUsd, imagesUsd: +imagesUsd.toFixed(4), videoUsd, totalUsd: projected, capUsd: CAP_USD }, supplyDemands: demands }));
  if (fail.length) throw Error("STOP: gate failed");
  if (!start) return;

  const { data: owner } = await db.auth.admin.getUserById(row.user_id);
  const quota = await assertCanGenerate(db as never, row.user_id, row.mode, owner!.user as never);
  if (!quota.allowed) throw Error(`STOP: quota ${quota.reason}`);
  await reserveJobSupply(db, row.id, 1, demands); // throws SupplyUnavailableError: nothing reserved or charged
  const { data: updated, error: updateError } = await db.from("video_requests").update({ supply_wait_started_at: null, supply_not_before: null, status: "processing", error_message: null,
    progress_stage: "queued", render_started_at: new Date().toISOString(), render_attempts: 1, render_worker: "github-actions" })
    .eq("id", row.id).eq("status", "script_ready").eq("render_attempts", 0).select("id");
  if (updateError || updated?.length !== 1) throw Error("STOP: state changed before start");
  console.log("STARTED", JSON.stringify({ status: "processing", renderAttempt: 1, worker: "github-actions", supplyReserved: true }));
}
main().catch(e => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : "failed"); process.exitCode = 1; });
