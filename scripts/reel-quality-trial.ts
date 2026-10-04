/** One independently authorized narrated reel through the actual production render stage.
 * The frozen script isolates visual QA from planning; no global flags, old grants or rows are changed.
 * A completed/failed/claimed request never starts this runner's paid work a second time.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore } from "../src/lib/paid-calls/result-store";
import { refreshPrepaidPilot } from "../src/lib/paid-calls/prepaid-pilot";
import { acquireCapacityHolds, settleCapacityHolds, supabaseCapacityHoldStore, type AcquiredHold } from "../src/lib/paid-calls/capacity-hold";
import { snapshotBalancePort } from "../src/lib/paid-calls/capacity-port";
import { getVoiceIdentity } from "../src/lib/ai/voice";
import { getVoiceProvider } from "../src/lib/providers/voice";
import { getFootageProvider } from "../src/lib/providers/footage";
import { getMusicProvider } from "../src/lib/providers/music";
import { getPricingConfig } from "../src/lib/billing/pricing";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { assertReviewedVisualConfiguration } from "../src/lib/video/reviewed-visual";
import { reviewVisual, VISUAL_REVIEW_POLICY } from "../src/lib/video/visual-review";
import { measureLoudness } from "../src/lib/video/audio-master";
import { generateVideoFromScript } from "../src/lib/video/generate-video";
import { attemptState } from "../src/lib/video/attempt-state";
import { REQUEST, OWNER, KEY, IDEMPOTENCY, SCRIPT, LIMITS, PLAN_HASH, LABELS } from "./reel-quality-trial-plan";

const OUT = path.join(process.cwd(), "reel-quality-trial-output");
const execute = promisify(execFile);
const service = createServiceClient(), base = supabaseLedgerStore(service), results = supabaseResultStore(service);
const holdsStore = supabaseCapacityHoldStore(service);
let claimed = false, holds: AcquiredHold[] = [];
const report: Record<string, unknown> = { requestId: REQUEST, planHash: PLAN_HASH, reviewPolicy: VISUAL_REVIEW_POLICY,
  scriptSource: "frozen_render_stage_test", limits: LIMITS, script: SCRIPT, negativeChecks: [], events: [] };
const originals = { log: console.log, warn: console.warn, error: console.error };
async function ledgerRows() {
  const { data, error } = await service.from("pi_paid_operations")
    .select("idempotency_key,shot_id,provider,model,method,status,reserved_usd,committed_usd,result_ref")
    .eq("project_id", REQUEST).in("method", ["generate_image", "visual_relevance_review", "tts_with_timestamps"]);
  if (error || !data) throw Error("QUALITY_TRIAL_LEDGER_UNAVAILABLE");
  return data;
}
function accounted(rows: Awaited<ReturnType<typeof ledgerRows>>) {
  return rows.reduce((sum, r) => sum + Math.max(Number(r.committed_usd ?? 0), r.status === "COMMITTED" ? 0 : Number(r.reserved_usd)), 0);
}
async function main() {
  const receipt = await base.get(KEY);
  if (receipt?.status !== "COMMITTED" || receipt.provider !== "internal" || receipt.method !== "human_direction"
    || receipt.projectId !== REQUEST || !receipt.resultRef) throw Error("QUALITY_TRIAL_NOT_AUTHORIZED");
  const grant = JSON.parse(receipt.resultRef);
  const { planHash, expiresAt, ...limits } = grant;
  if (planHash !== PLAN_HASH || stableHash(limits, 64) !== stableHash(LIMITS, 64)
    || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw Error("QUALITY_TRIAL_SCOPE_CHANGED");
  const request = await service.from("video_requests").select("user_id,status,mode,idempotency_key,script_json,render_attempts,video_path,duration_seconds,language")
    .eq("id", REQUEST).single();
  if (request.error || request.data.user_id !== OWNER || request.data.mode !== "visual" || request.data.idempotency_key !== IDEMPOTENCY
    || request.data.duration_seconds !== 30 || request.data.language !== "es" || stableHash(request.data.script_json, 64) !== stableHash(SCRIPT, 64)) throw Error("QUALITY_TRIAL_REQUEST_CHANGED");
  if (request.data.status === "completed" && request.data.video_path) { originals.log("QUALITY_TRIAL_ALREADY_COMPLETED_NO_PAID_REPLAY"); return; }
  if (request.data.status !== "script_ready" || request.data.render_attempts !== 0) throw Error("QUALITY_TRIAL_ALREADY_CLAIMED_NO_PAID_REPLAY");
  const text = SCRIPT.segments.map(s => s.text).join(" ");
  const identity = getVoiceIdentity("es");
  if (text.length > LIMITS.maxVoiceCharacters || identity.voiceId !== LIMITS.voiceId || identity.modelId !== LIMITS.modelId
    || getVoiceProvider().name !== "elevenlabs" || getFootageProvider().name !== "pexels-video-first"
    || getMusicProvider().name !== "curated-library" || getPricingConfig().elevenLabsUsdPer1kChars !== LIMITS.voiceEstimatedUsdPer1kChars
    || VISUAL_REVIEW_POLICY !== LIMITS.reviewPolicy || process.env.OPENAI_IMAGE_ESTIMATED_COST_USD !== "0.08"
    || process.env.OPENAI_IMAGE_MODEL !== "gpt-image-2" || process.env.OPENAI_IMAGE_SIZE !== "1024x1536" || process.env.OPENAI_IMAGE_QUALITY !== "medium") throw Error("QUALITY_TRIAL_PROVIDER_CONTRACT_CHANGED");
  assertReviewedVisualConfiguration(SCRIPT.segments, false);
  if ((await ledgerRows()).length) throw Error("QUALITY_TRIAL_HAS_PRIOR_OPERATIONS_NO_PAID_REPLAY");
  const claim = await service.from("video_requests").update({ status: "processing", render_attempts: 1, progress_stage: "voice", error_message: null })
    .eq("id", REQUEST).eq("user_id", OWNER).eq("status", "script_ready").eq("render_attempts", 0).select("id");
  if (claim.error || claim.data?.length !== 1) throw Error("QUALITY_TRIAL_CLAIM_CONFLICT");
  claimed = true;
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(".render-attempt.json", JSON.stringify({ requestId: REQUEST, attempt: 1 }), { mode: 0o600 });
  await refreshPrepaidPilot(service, LIMITS);
  report.voiceCapacityBefore = await snapshotBalancePort(service).read("elevenlabs");
  const admission = await acquireCapacityHolds({ store: holdsStore, balance: snapshotBalancePort(service) }, {
    requestId: REQUEST, demands: [{ provider: "elevenlabs", units: LIMITS.maxVoiceCharacters * LIMITS.maxVoiceCalls, usd: 0 }],
  });
  if (!admission.acquired) throw Error("QUALITY_TRIAL_PREPAID_VOICE_HOLD_BLOCKED");
  holds = admission.holds;
  const bounded = { ...base, async insert(op: Parameters<typeof base.insert>[0]) {
    const rows = await ledgerRows();
    if (op.projectId !== REQUEST || !Number.isFinite(op.reservedUsd) || op.reservedUsd < 0
      || accounted(rows) + op.reservedUsd > LIMITS.maxAccountedUsd) throw Error("QUALITY_TRIAL_TOTAL_BUDGET_BLOCKED");
    if (op.method === "tts_with_timestamps") {
      if (op.provider !== "elevenlabs" || op.model !== LIMITS.modelId || op.reservedUsd > LIMITS.maxVoiceCharacters / 1000 * 0.1 + 1e-9
        || rows.filter(r => r.method === op.method).length >= LIMITS.maxVoiceCalls) throw Error("QUALITY_TRIAL_VOICE_BUDGET_BLOCKED");
    } else if (op.method === "generate_image") {
      if (op.provider !== "openai" || !/^image:scene-[0-4]$/.test(op.shotId) || op.reservedUsd > LIMITS.maxImageReservationUsd + 1e-9
        || rows.filter(r => r.method === op.method).length >= LIMITS.maxImages) throw Error("QUALITY_TRIAL_IMAGE_BUDGET_BLOCKED");
    } else throw Error("QUALITY_TRIAL_PAID_METHOD_BLOCKED");
    return base.insert(op);
  } };
  // Vision has its separate atomic 20-call/$0.10 RPC limit, including failed/uncertain calls.
  // Voice <=$0.13, images <=5*$0.08 and vision <=$0.10: <=$0.63 of the $0.65 admission ceiling.
  for (const [query, index] of [["iguana", 1], ["light bulb", 0]] as const) {
    const footage = getFootageProvider();
    const candidates = await footage.searchImageCandidates?.(query);
    if (!candidates?.length) throw Error("QUALITY_TRIAL_NEGATIVE_SOURCE_MISSING");
    const buffer = await footage.downloadFootage(candidates[0].url);
    const review = await reviewVisual({ service, requestId: REQUEST, sceneIndex: 10 + index,
      intent: SCRIPT.segments[index].visualIntent!, narration: SCRIPT.segments[index].text, buffer, mediaType: "image", durationSeconds: 5 });
    (report.negativeChecks as unknown[]).push({ query, accepted: review.accepted, verdict: review.verdict, costUsd: review.costUsd });
    if (review.accepted) throw Error("QUALITY_TRIAL_INCORRECT_SUBSTITUTE_ACCEPTED");
    originals.log("QUALITY_TRIAL_NEGATIVE_REJECTED", query);
  }
  const capture = (...args: unknown[]) => {
    if (typeof args[0] === "string" && /\[atomivid:(visual-review|music|audio|quality-gate)\]/.test(args[0])) {
      let details: unknown = args.slice(1);
      if (typeof args[1] === "string") { try { details = JSON.parse(args[1]); } catch { /* Keep diagnostic only in the private report. */ } }
      (report.events as unknown[]).push({ event: args[0], details });
    }
  };
  let output: { videoPath: string };
  const { update } = attemptState(service, { requestId: REQUEST, userId: OWNER, attempt: 1 });
  try {
    console.log = console.warn = console.error = capture;
    output = await generateVideoFromScript({ supabase: service, requestId: REQUEST, script: SCRIPT, language: "es",
      style: "Curiosidades", topic: SCRIPT.title, targetDurationSeconds: 30, paidCalls: { ledger: bounded, results },
      onProgress: async stage => {
        const updated = await update({ progress_stage: stage }).select("id");
        if (updated.error || updated.data?.length !== 1) throw Error("QUALITY_TRIAL_STATUS_CONFLICT");
        originals.log("QUALITY_TRIAL_STAGE", stage);
      },
    });
  } finally { Object.assign(console, originals); }
  report.videoPath = output.videoPath;
  const final = await results.getBytes(output.videoPath);
  if (!final) throw Error("QUALITY_TRIAL_FINAL_MISSING");
  const file = path.join(OUT, "final.mp4"); await fs.writeFile(file, final);
  const probe = await execute("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 30_000 });
  const media = JSON.parse(probe.stdout);
  const video = media.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = media.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const duration = Number(media.format.duration);
  report.output = { width: video?.width, height: video?.height, fps: video?.avg_frame_rate, videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name, durationSeconds: duration, bytes: final.length };
  if (video?.width !== 1080 || video?.height !== 1920 || !audio || !Number.isFinite(duration) || duration < 27 || duration > 33.6) throw Error("QUALITY_TRIAL_FINAL_MEDIA_REJECTED");
  const loudness = await measureLoudness(file); report.loudness = loudness;
  if (!Number.isFinite(loudness.integratedLufs) || Math.abs(loudness.integratedLufs + 16) > 1 || loudness.truePeakDbtp > -1) throw Error("QUALITY_TRIAL_AUDIO_REJECTED");
  const events = report.events as { event: string; details: { accepted?: boolean; sceneIndex?: number; musicProvider?: string } }[];
  if (events.filter(e => e.event === "[atomivid:visual-review]" && e.details.accepted && (e.details.sceneIndex ?? 99) < 5).length !== 5
    || !events.some(e => e.details.musicProvider === "curated-library")) throw Error("QUALITY_TRIAL_INCOMPLETE_RENDER_EVIDENCE");
  const rows = await ledgerRows(); report.accountedUsd = accounted(rows);
  report.operations = rows.map(({ result_ref: _ref, ...row }) => row);
  if (accounted(rows) > LIMITS.maxAccountedUsd || rows.some(r => r.status !== "COMMITTED")) throw Error("QUALITY_TRIAL_PAID_ACCOUNTING_INCOMPLETE");
  const reviews = rows.filter(r => r.method === "visual_relevance_review");
  report.verdicts = await Promise.all(reviews.map(async r => ({ shot: r.shot_id, verdict: await results.getJson(r.result_ref!) })));
  const tiles: Buffer[] = [];
  for (let i = 0; i < 5; i++) {
    const frame = path.join(OUT, `frame-${i}.jpg`);
    await execute("ffmpeg", ["-v", "error", "-ss", String((i + 0.5) / 5 * duration), "-i", file, "-frames:v", "1", "-y", frame], { timeout: 30_000 });
    tiles.push(await sharp(frame).resize(270, 480).toBuffer());
  }
  await sharp({ create: { width: 1350, height: 480, channels: 3, background: "#09090f" } })
    .composite(tiles.map((input, i) => ({ input, left: i * 270, top: 0 }))).jpeg({ quality: 92 }).toFile(path.join(OUT, "contact-sheet.jpg"));
  report.labels = LABELS;
  await refreshPrepaidPilot(service, LIMITS);
  report.voiceCapacityAfter = await snapshotBalancePort(service).read("elevenlabs");
  report.qualityPassed = true;
  const saved = await service.from("video_requests").update({ status: "completed", video_path: output.videoPath, progress_stage: null, error_message: null })
    .eq("id", REQUEST).eq("status", "processing").eq("render_attempts", 1).select("id");
  if (saved.error || saved.data?.length !== 1) throw Error("QUALITY_TRIAL_STATUS_CONFLICT");
  originals.log("QUALITY_TRIAL_COMPLETED", JSON.stringify({ durationSeconds: duration, accountedUsd: accounted(rows), images: 5, reviews: reviews.length,
    voiceCalls: rows.filter(r => r.method === "tts_with_timestamps").length }));
}
main().catch(async error => {
  Object.assign(console, originals);
  report.qualityPassed = false; report.error = error instanceof Error ? error.message.slice(0, 1000) : "unknown";
  if (claimed) await service.from("video_requests").update({ status: "failed", progress_stage: "failed", error_message: "La prueba de calidad se detuvo. Se conservan los resultados pagados; no se repetirán llamadas automáticamente." })
    .eq("id", REQUEST).eq("status", "processing").eq("render_attempts", 1);
  originals.error("QUALITY_TRIAL_STOPPED_DETAILS_IN_PRIVATE_REPORT"); process.exitCode = 1;
}).finally(async () => {
  if (!claimed) return;
  const rows = await ledgerRows(); report.accountedUsd = accounted(rows);
  report.operations = rows.map(({ result_ref: _ref, ...row }) => row);
  // Any charged/uncertain voice operation consumes the hold; zero operations releases it.
  await settleCapacityHolds(holdsStore, holds, rows.some(r => r.method === "tts_with_timestamps" && r.status !== "REFUNDED") ? "COMMITTED" : "REFUNDED");
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const stored = await service.storage.from("videos").upload(`${REQUEST}/quality-trial/report.json`, Buffer.from(JSON.stringify(report)), { contentType: "application/json", upsert: true });
  if (stored.error) { originals.error("QUALITY_TRIAL_REPORT_PERSIST_FAILED"); process.exitCode = 1; }
});
