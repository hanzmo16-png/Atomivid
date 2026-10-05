/** Read-only delivery audit; no provider generation/retries. Retain media for human QA. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServiceClient } from "../src/lib/supabase/service";
import { readOwnerFormTrial, assertOwnerFormFrozen } from "../src/lib/billing/owner-form-trial";
import { sha256Hex } from "../src/lib/paid-calls/result-store";
import { measureLoudness } from "../src/lib/video/audio-master";
import { INCOMPLETE_REVIEW, SECOND_INCOMPLETE_REVIEW, activeRecoveryKeys, verifyIncompleteReview } from "../src/lib/paid-calls/owner-form-recovery";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
const execute = promisify(execFile);
async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId || process.env.OWNER_FORM_TRIAL_WORKER !== "true") throw new Error("AUDIT_SCOPE");
  const service = createServiceClient(), grant = await readOwnerFormTrial(service, requestId);
  const request = await service.from("video_requests").select("id,user_id,status,mode,script_json,video_path,render_attempts")
    .eq("id", requestId).single();
  if (!grant || request.error || request.data.user_id !== grant.ownerId || request.data.status !== "completed"
    || request.data.mode !== "visual" || request.data.render_attempts !== 1
    || request.data.video_path !== `${requestId}/attempt-1/final.mp4`) throw new Error("AUDIT_NOT_COMPLETED");
  await assertOwnerFormFrozen(service, grant, request.data.script_json);
  const file = await service.storage.from("videos").download(request.data.video_path);
  if (file.error || !file.data) throw new Error("AUDIT_DOWNLOAD_FAILED");
  const out = path.join(process.cwd(), "owner-form-trial-output");
  await fs.mkdir(out, { recursive: true });
  const bytes = Buffer.from(await file.data.arrayBuffer()), videoFile = path.join(out, "final.mp4");
  await fs.writeFile(videoFile, bytes);
  const probe = JSON.parse((await execute("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoFile])).stdout);
  const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const loudness = await measureLoudness(videoFile);
  const operations = await service.from("pi_paid_operations").select("idempotency_key,shot_id,provider,model,method,status,reserved_usd,committed_usd")
    .eq("project_id", requestId).neq("provider", "internal").neq("method", "capacity_hold").order("created_at", { ascending: true });
  if (operations.error || !operations.data) throw new Error("AUDIT_LEDGER");
  const paid = operations.data;
  const retainedIncomplete = await service.from("pi_paid_operations").select("status").eq("idempotency_key", INCOMPLETE_REVIEW).maybeSingle();
  const keys = activeRecoveryKeys();
  const recovery = await supabaseLedgerStore(service).get(keys.execution);
  const knownIncomplete = retainedIncomplete.data?.status === "RECONCILIATION_REQUIRED" && recovery?.status === "COMMITTED"
    && recovery.projectId === requestId && recovery.provider === "internal" && recovery.method === "resume_incomplete_visual_trial";
  if (knownIncomplete) await verifyIncompleteReview(service);
  const retainedKeys = knownIncomplete ? [INCOMPLETE_REVIEW] : [];
  if (knownIncomplete && keys.compact) { await verifyIncompleteReview(service, SECOND_INCOMPLETE_REVIEW); retainedKeys.push(SECOND_INCOMPLETE_REVIEW); }
  const accountedUsd = paid.reduce((sum, p) => sum + Math.max(Number(p.reserved_usd), Number(p.committed_usd ?? 0)), 0);
  const count = (method: string) => paid.filter(p => p.method === method).length;
  const checks = { vertical: video.width === 1080 && video.height === 1920, h264: video.codec_name === "h264",
    fps30: video.avg_frame_rate === "30/1", aac: audio.codec_name === "aac", near30: Math.abs(Number(probe.format.duration) - 30) <= 3,
    synchronized: Math.abs(Number(video.duration) - Number(audio.duration)) < 0.1,
    loudness: Math.abs(loudness.integratedLufs + 16) <= 1.5, truePeak: loudness.truePeakDbtp <= -1,
    budget: accountedUsd <= grant.maxAccountedUsd, paidStatesAccounted: paid.every(p => p.status === "COMMITTED"
      || (retainedKeys.includes(p.idempotency_key) && p.status === "RECONCILIATION_REQUIRED")),
    script: count("generate_script") > 0 && count("generate_script") <= 3, voice: count("tts_with_timestamps") <= 2,
    images: count("generate_image") <= 6, reviews: count("visual_relevance_review") > 0 && count("visual_relevance_review") <= 20 };
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify({ requestId, sha256: sha256Hex(bytes), bytes: bytes.length,
    script: request.data.script_json, durationSeconds: Number(probe.format.duration), loudness, operations: paid,
    accountedUsd, checks, passed: Object.values(checks).every(Boolean), manualVisualReview: "pending",
    financialReconciliation: retainedKeys.length ? `${retainedKeys.length} saved incomplete reviews retain $${retainedKeys.length * 0.005} in reservations; not treated as successful reviews or refunded.` : "No pending paid rows." }, null, 2));
  await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", videoFile, "-vf", "fps=1/2,scale=270:480,tile=5x3", "-frames:v", "1", path.join(out, "contact.jpg")]);
  if (!Object.values(checks).every(Boolean)) throw new Error("AUDIT_TECHNICAL_CHECK_FAILED");
  console.log("OWNER_FORM_TRIAL_TECHNICAL_CHECKS_PASSED_MANUAL_REVIEW_PENDING");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "AUDIT_FAILED"); process.exitCode = 1; });
