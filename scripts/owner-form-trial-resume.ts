/** One separately authorized continuation of the existing failed attempt.
 * No script generation, counter reset, changed paid keys or replay of an incomplete review.
 */
import fs from "node:fs/promises";
import { createServiceClient } from "../src/lib/supabase/service";
import { readOwnerFormTrial, assertOwnerFormTrial, assertOwnerFormFrozen } from "../src/lib/billing/owner-form-trial";
import { readRecovery, verifyIncompleteReview, RECOVERY_REQUEST, SECOND_INCOMPLETE_REVIEW, activeRecoveryKeys } from "../src/lib/paid-calls/owner-form-recovery";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "../src/lib/paid-calls/result-store";
import { runRenderJob } from "../src/lib/video/run-job";

async function main() {
  if (process.env.OWNER_FORM_RECOVERY_WORKER !== "true" || process.env.OWNER_FORM_TRIAL_WORKER !== "true"
    || !process.env.GITHUB_ACTIONS || !process.env.GITHUB_RUN_ID) throw Error("RECOVERY_ISOLATION_REQUIRED");
  const service = createServiceClient(), ledger = supabaseLedgerStore(service);
  const keys = activeRecoveryKeys();
  const trial = await readOwnerFormTrial(service, RECOVERY_REQUEST);
  if (!trial) throw Error("RECOVERY_TRIAL_REQUIRED");
  await readRecovery(service, trial); await verifyIncompleteReview(service);
  if (keys.compact) await verifyIncompleteReview(service, SECOND_INCOMPLETE_REVIEW);
  const query = await service.from("video_requests").select("id,user_id,mode,topic,style,language,duration_seconds,status,render_attempts,script_json,video_path,error_message")
    .eq("id", RECOVERY_REQUEST).single();
  if (query.error || !query.data) throw Error("RECOVERY_REQUEST_UNAVAILABLE");
  const row = query.data;
  if (row.status !== "failed" || row.render_attempts !== 1 || row.video_path !== null
    || row.error_message !== (keys.compact
      ? "La revisión visual alcanzó el límite de respuesta. Se conservó el resultado para revisarlo sin repetir el cobro automáticamente. (Código: 1af729fd)"
      : "La revisión visual no terminó. (Código: d4c0765a)")) throw Error("RECOVERY_STATE_BLOCKED");
  const user = await service.auth.admin.getUserById(row.user_id);
  if (user.error || !user.data.user) throw Error("RECOVERY_OWNER_UNVERIFIED");
  // Validate the exact confirmed owner/input/frozen script before the one-time CAS.
  assertOwnerFormTrial(trial, { ...row, status: "processing" }, user.data.user, "worker");
  await assertOwnerFormFrozen(service, trial, row.script_json);
  const voice = await ledger.get("op_9e7d00cb2609dec11b8eab35f9cc8e34");
  if (!voice || voice.projectId !== RECOVERY_REQUEST || voice.status !== "COMMITTED" || voice.provider !== "elevenlabs"
    || voice.method !== "tts_with_timestamps" || !voice.resultRef
    || !await supabaseResultStore(service).getJson(voice.resultRef)) throw Error("RECOVERY_SAVED_VOICE_REQUIRED");
  // Inserting the immutable identity first makes a duplicate/uncertain run stop.
  if (!await ledger.insert({ idempotencyKey: keys.execution, projectId: RECOVERY_REQUEST, shotId: "owner-form-recovery",
    provider: "internal", model: "owner-form-recovery/1", method: "resume_incomplete_visual_trial", attemptKind: "initial",
    reservedUsd: 0, committedUsd: null, status: "SUBMITTED", providerJobId: process.env.GITHUB_RUN_ID, resultRef: null,
    updatedAt: new Date().toISOString() })) throw Error("RECOVERY_ALREADY_CONSUMED_NO_REPLAY");
  const claim = await service.from("video_requests").update({ status: "processing", error_message: null, progress_stage: "queued",
    render_started_at: new Date().toISOString(), render_worker: "github-actions" })
    .eq("id", RECOVERY_REQUEST).eq("user_id", trial.ownerId).eq("status", "failed").eq("render_attempts", 1)
    .is("video_path", null).eq("error_message", row.error_message).eq("script_json", JSON.stringify(row.script_json)).select("id");
  if (claim.error || claim.data?.length !== 1) throw Error("RECOVERY_STATE_CONFLICT");
  await fs.writeFile(".render-attempt.json", JSON.stringify({ requestId: RECOVERY_REQUEST, attempt: 1 }), { mode: 0o600 });
  await runRenderJob(RECOVERY_REQUEST, 1);
  const finished = await service.from("video_requests").select("status,video_path").eq("id", RECOVERY_REQUEST).single();
  if (finished.error || finished.data.status !== "completed" || !finished.data.video_path) throw Error("RECOVERY_RENDER_FAILED_NO_AUTOMATIC_RETRY");
  if (!await ledger.update(keys.execution, "SUBMITTED", { status: "COMMITTED", committedUsd: 0,
    resultRef: finished.data.video_path, updatedAt: new Date().toISOString() })) throw Error("RECOVERY_RECEIPT_SAVE_FAILED");
  console.log("OWNER_FORM_RECOVERY_COMPLETED_MANUAL_QA_PENDING");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "RECOVERY_BLOCKED"); process.exitCode = 1; });
