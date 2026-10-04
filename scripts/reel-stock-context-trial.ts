/** One independently authorized narrated stock reel through the actual production render stage.
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
import { supabaseResultStore, paidResultPath, sha256Hex } from "../src/lib/paid-calls/result-store";
import { paidCallKey, type PaidCallSpec } from "../src/lib/paid-calls/gate";
import { checkDuration } from "../src/lib/video/duration-check";
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
import { REQUEST, OWNER, KEY, IDEMPOTENCY, SCRIPT, LIMITS, PLAN_HASH, LABELS } from "./reel-stock-context-plan";

const OUT = path.join(process.cwd(), "reel-stock-context-trial-output");
const execute = promisify(execFile);
const service = createServiceClient(), base = supabaseLedgerStore(service), results = supabaseResultStore(service);
let claimed = false;
const report: Record<string, unknown> = { requestId: REQUEST, planHash: PLAN_HASH, reviewPolicy: VISUAL_REVIEW_POLICY,
  scriptSource: "frozen_render_stage_test", limits: LIMITS, script: SCRIPT, negativeChecks: [], events: [] };
const originals = { log: console.log, warn: console.warn, error: console.error };
async function ledgerRows() {
  const { data, error } = await service.from("pi_paid_operations")
    .select("idempotency_key,shot_id,provider,model,method,status,reserved_usd,committed_usd,result_ref")
    .eq("project_id", REQUEST).in("method", ["generate_image", "visual_relevance_review", "tts_with_timestamps"]).order("created_at", { ascending: true });
  if (error || !data) throw Error("STOCK_CONTEXT_TRIAL_LEDGER_UNAVAILABLE");
  return data;
}
function accounted(rows: Awaited<ReturnType<typeof ledgerRows>>) {
  return rows.reduce((sum, r) => sum + Math.max(Number(r.committed_usd ?? 0), r.status === "COMMITTED" ? 0 : Number(r.reserved_usd)), 0);
}
async function main() {
  const receipt = await base.get(KEY);
  if (receipt?.status !== "COMMITTED" || receipt.provider !== "internal" || receipt.method !== "human_direction"
    || receipt.projectId !== REQUEST || !receipt.resultRef) throw Error("STOCK_CONTEXT_TRIAL_NOT_AUTHORIZED");
  const grant = JSON.parse(receipt.resultRef);
  const { planHash, expiresAt, ...limits } = grant;
  if (planHash !== PLAN_HASH || stableHash(limits, 64) !== stableHash(LIMITS, 64)
    || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw Error("STOCK_CONTEXT_TRIAL_SCOPE_CHANGED");
  const request = await service.from("video_requests").select("user_id,status,mode,idempotency_key,script_json,render_attempts,video_path,duration_seconds,language")
    .eq("id", REQUEST).single();
  if (request.error || request.data.user_id !== OWNER || request.data.mode !== "visual" || request.data.idempotency_key !== IDEMPOTENCY
    || request.data.duration_seconds !== 30 || request.data.language !== "es" || stableHash(request.data.script_json, 64) !== stableHash(SCRIPT, 64)) throw Error("STOCK_CONTEXT_TRIAL_REQUEST_CHANGED");
  if (request.data.status === "completed" && request.data.video_path) { originals.log("STOCK_CONTEXT_TRIAL_ALREADY_COMPLETED_NO_PAID_REPLAY"); return; }
  if (request.data.status !== "script_ready" || request.data.render_attempts !== 0) throw Error("STOCK_CONTEXT_TRIAL_ALREADY_CLAIMED_NO_PAID_REPLAY");
  const text = SCRIPT.segments.map(s => s.text).join(" ");
  const identity = getVoiceIdentity("es");
  if (text.length > LIMITS.maxVoiceCharacters || identity.voiceId !== LIMITS.voiceId || identity.modelId !== LIMITS.modelId
    || getVoiceProvider().name !== "elevenlabs" || getFootageProvider().name !== "pexels-video-first"
    || getMusicProvider().name !== "curated-library" || getPricingConfig().elevenLabsUsdPer1kChars !== LIMITS.voiceEstimatedUsdPer1kChars
    || VISUAL_REVIEW_POLICY !== LIMITS.reviewPolicy || process.env.OPENAI_IMAGE_ESTIMATED_COST_USD !== "0.08"
    || process.env.OPENAI_IMAGE_MODEL !== "gpt-image-2" || process.env.OPENAI_IMAGE_SIZE !== "1024x1536" || process.env.OPENAI_IMAGE_QUALITY !== "medium") throw Error("STOCK_CONTEXT_TRIAL_PROVIDER_CONTRACT_CHANGED");
  assertReviewedVisualConfiguration(SCRIPT.segments, false);
  if ((await ledgerRows()).length) throw Error("STOCK_CONTEXT_TRIAL_HAS_PRIOR_OPERATIONS_NO_PAID_REPLAY");
  const claim = await service.from("video_requests").update({ status: "processing", render_attempts: 1, progress_stage: "voice", error_message: null })
    .eq("id", REQUEST).eq("user_id", OWNER).eq("status", "script_ready").eq("render_attempts", 0).select("id");
  if (claim.error || claim.data?.length !== 1) throw Error("STOCK_CONTEXT_TRIAL_CLAIM_CONFLICT");
  claimed = true;
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(".render-attempt.json", JSON.stringify({ requestId: REQUEST, attempt: 1 }), { mode: 0o600 });
  report.voiceReuse = await seedPreviouslyPaidNarration();
  const bounded = { ...base, async insert(op: Parameters<typeof base.insert>[0]) {
    const rows = await ledgerRows();
    if (op.projectId !== REQUEST || !Number.isFinite(op.reservedUsd) || op.reservedUsd < 0
      || accounted(rows) + op.reservedUsd > LIMITS.maxAccountedUsd) throw Error("STOCK_CONTEXT_TRIAL_TOTAL_BUDGET_BLOCKED");
    if (op.method === "tts_with_timestamps") {
      if (op.provider !== "elevenlabs" || op.model !== LIMITS.modelId || op.reservedUsd > LIMITS.maxVoiceCharacters / 1000 * 0.1 + 1e-9
        || rows.filter(r => r.method === op.method).length >= LIMITS.maxVoiceCalls) throw Error("STOCK_CONTEXT_TRIAL_VOICE_BUDGET_BLOCKED");
    } else if (op.method === "generate_image") {
      if (op.provider !== "openai" || !/^image:scene-[0-3]$/.test(op.shotId) || op.reservedUsd > LIMITS.maxImageReservationUsd + 1e-9
        || rows.filter(r => r.method === op.method).length >= LIMITS.maxImages) throw Error("STOCK_CONTEXT_TRIAL_IMAGE_BUDGET_BLOCKED");
    } else throw Error("STOCK_CONTEXT_TRIAL_PAID_METHOD_BLOCKED");
    return base.insert(op);
  } };
  // Zero new voice calls; four image holds ($0.32) plus the atomic twenty-review
  // hold ($0.10) fit the independently authorized $0.45 accounted ceiling.
  const stock = await service.storage.from("videos").list(`${LIMITS.voiceReuseFromRequest}/reviewed`);
  const rejectedClip = stock.data?.find(f => /^scene-3-.*\.mp4$/.test(f.name));
  if (stock.error || !rejectedClip) throw Error("STOCK_CONTEXT_TRIAL_NEGATIVE_CLIP_MISSING");
  const buffer = await results.getBytes(`${LIMITS.voiceReuseFromRequest}/reviewed/${rejectedClip.name}`);
  if (!buffer) throw Error("STOCK_CONTEXT_TRIAL_NEGATIVE_CLIP_MISSING");
  const negative = await reviewVisual({ service, requestId: REQUEST, sceneIndex: 13,
    intent: SCRIPT.segments[3].visualIntent!, narration: SCRIPT.segments[3].text, buffer, mediaType: "video", durationSeconds: 8.974 });
  (report.negativeChecks as unknown[]).push({ subject: "previously accepted trading clip", accepted: negative.accepted, verdict: negative.verdict, costUsd: negative.costUsd });
  if (negative.accepted) throw Error("STOCK_CONTEXT_TRIAL_TRADING_SUBSTITUTE_ACCEPTED");
  originals.log("STOCK_CONTEXT_TRIAL_TRADING_CLIP_REJECTED");
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
      style: "Motivacional", topic: SCRIPT.title, targetDurationSeconds: 30, paidCalls: { ledger: bounded, results },
      onProgress: async stage => {
        const updated = await update({ progress_stage: stage }).select("id");
        if (updated.error || updated.data?.length !== 1) throw Error("STOCK_CONTEXT_TRIAL_STATUS_CONFLICT");
        originals.log("STOCK_CONTEXT_TRIAL_STAGE", stage);
      },
    });
  } finally { Object.assign(console, originals); }
  report.videoPath = output.videoPath;
  const final = await results.getBytes(output.videoPath);
  if (!final) throw Error("STOCK_CONTEXT_TRIAL_FINAL_MISSING");
  const file = path.join(OUT, "final.mp4"); await fs.writeFile(file, final);
  const probe = await execute("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 30_000 });
  const media = JSON.parse(probe.stdout);
  const video = media.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = media.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const duration = Number(media.format.duration);
  report.output = { width: video?.width, height: video?.height, fps: video?.avg_frame_rate, videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name, durationSeconds: duration, bytes: final.length };
  if (video?.width !== 1080 || video?.height !== 1920 || !audio || !Number.isFinite(duration) || duration < 27 || duration > 33.6) throw Error("STOCK_CONTEXT_TRIAL_FINAL_MEDIA_REJECTED");
  const loudness = await measureLoudness(file); report.loudness = loudness;
  if (!Number.isFinite(loudness.integratedLufs) || Math.abs(loudness.integratedLufs + 16) > 1 || loudness.truePeakDbtp > -1) throw Error("STOCK_CONTEXT_TRIAL_AUDIO_REJECTED");
  const events = report.events as { event: string; details: { accepted?: boolean; sceneIndex?: number; musicProvider?: string } }[];
  if (events.filter(e => e.event === "[atomivid:visual-review]" && e.details.accepted && (e.details.sceneIndex ?? 99) < LIMITS.sceneCount).length !== LIMITS.sceneCount
    || !events.some(e => e.details.musicProvider === "curated-library")) throw Error("STOCK_CONTEXT_TRIAL_INCOMPLETE_RENDER_EVIDENCE");
  const rows = await ledgerRows(); report.accountedUsd = accounted(rows);
  report.operations = rows.map(r => ({ shot: r.shot_id, method: r.method, provider: r.provider, status: r.status, reservedUsd: r.reserved_usd, committedUsd: r.committed_usd }));
  if (accounted(rows) > LIMITS.maxAccountedUsd || rows.some(r => r.status !== "COMMITTED")) throw Error("STOCK_CONTEXT_TRIAL_PAID_ACCOUNTING_INCOMPLETE");
  const reviews = rows.filter(r => r.method === "visual_relevance_review");
  report.verdicts = await Promise.all(reviews.map(async r => ({ shot: r.shot_id, verdict: await results.getJson(r.result_ref!) })));
  const voiceMeta = await results.getJson<{ words: { startSeconds: number; endSeconds: number }[] }>((report.voiceReuse as { finalMetaPath: string }).finalMetaPath);
  if (!voiceMeta?.words.length) throw Error("STOCK_CONTEXT_TRIAL_WORD_TIMINGS_MISSING");
  let wordIndex = 0;
  const sceneRanges = SCRIPT.segments.map(segment => {
    const count = segment.text.split(/\s+/).filter(Boolean).length;
    const start = voiceMeta.words[Math.min(wordIndex, voiceMeta.words.length - 1)].startSeconds;
    const end = voiceMeta.words[Math.min(wordIndex + count - 1, voiceMeta.words.length - 1)].endSeconds;
    wordIndex += count;
    return { start, end };
  });
  report.sceneRanges = sceneRanges;
  const tiles: Buffer[] = [];
  for (let i = 0; i < LIMITS.sceneCount; i++) {
    const frame = path.join(OUT, `frame-${i}.jpg`);
    await execute("ffmpeg", ["-v", "error", "-ss", String((sceneRanges[i].start + sceneRanges[i].end) / 2), "-i", file, "-frames:v", "1", "-y", frame], { timeout: 30_000 });
    tiles.push(await sharp(frame).resize(270, 480).toBuffer());
  }
  await sharp({ create: { width: 270 * LIMITS.sceneCount, height: 480, channels: 3, background: "#09090f" } })
    .composite(tiles.map((input, i) => ({ input, left: i * 270, top: 0 }))).jpeg({ quality: 92 }).toFile(path.join(OUT, "contact-sheet.jpg"));
  const positive = events.filter(e => e.event === "[atomivid:visual-review]" && e.details.accepted && (e.details.sceneIndex ?? 99) < LIMITS.sceneCount);
  report.acceptedMedia = positive.map(e => ({ sceneIndex: e.details.sceneIndex, mediaType: (e.details as { mediaType?: string }).mediaType }));
  report.stockAssets = (await service.storage.from("videos").list(`${REQUEST}/reviewed`)).data?.filter(f => /\.(mp4|jpg)$/.test(f.name)).map(f => f.name) ?? [];
  report.stockVideoCount = (report.stockAssets as string[]).filter(n => n.endsWith(".mp4")).length;
  report.stockImageCount = (report.stockAssets as string[]).filter(n => n.endsWith(".jpg")).length;
  if (Number(report.stockVideoCount) < 1) throw Error("STOCK_CONTEXT_TRIAL_NO_REAL_STOCK_VIDEO_VALIDATED");
  report.labels = LABELS;
  if (rows.some(r => r.method === "tts_with_timestamps")) throw Error("STOCK_CONTEXT_TRIAL_FRESH_VOICE_NOT_ALLOWED");
  report.qualityPassed = true;
  const saved = await service.from("video_requests").update({ status: "completed", video_path: output.videoPath, progress_stage: null, error_message: null })
    .eq("id", REQUEST).eq("status", "processing").eq("render_attempts", 1).select("id");
  if (saved.error || saved.data?.length !== 1) throw Error("STOCK_CONTEXT_TRIAL_STATUS_CONFLICT");
  originals.log("STOCK_CONTEXT_TRIAL_COMPLETED", JSON.stringify({ durationSeconds: duration, accountedUsd: accounted(rows), images: rows.filter(r => r.method === "generate_image").length, reviews: reviews.length,
    voiceCalls: rows.filter(r => r.method === "tts_with_timestamps").length }));
}
async function seedPreviouslyPaidNarration() {
  const source = LIMITS.voiceReuseFromRequest;
  const prior = await service.from("video_requests").select("user_id,language,mode,script_json").eq("id", source).single();
  const text = SCRIPT.segments.map(s => s.text).join(" ");
  if (prior.error || prior.data.user_id !== OWNER || prior.data.language !== "es" || prior.data.mode !== "visual"
    || prior.data.script_json.segments.map((s: { text: string }) => s.text).join(" ") !== text) throw Error("STOCK_CONTEXT_TRIAL_VOICE_SOURCE_CHANGED");
  const saved = await service.from("pi_paid_operations").select("idempotency_key,result_ref,status,provider,model")
    .eq("project_id", source).eq("method", "tts_with_timestamps");
  if (saved.error || saved.data?.length !== 2 || saved.data.some(r => r.status !== "COMMITTED" || r.provider !== "elevenlabs" || r.model !== LIMITS.modelId)) throw Error("STOCK_CONTEXT_TRIAL_VOICE_PAYMENT_UNVERIFIED");
  const identity = getVoiceIdentity("es");
  type Meta = { audioPath: string; sha256: string; bytes: number; durationSeconds: number; words: unknown[] };
  const reuse = async (speed?: number) => {
    const fingerprint = { text, language: "es", speed: speed ?? null, ...identity };
    const spec: PaidCallSpec = { projectId: source, shotId: `voice:${stableHash(fingerprint,16)}`, provider: "elevenlabs", model: identity.modelId,
      method: "tts_with_timestamps", inputFingerprint: fingerprint, reservedUsd: text.length / 1000 * 0.1 };
    const key = paidCallKey(spec);
    const receipt = saved.data!.find(r => r.idempotency_key === key);
    if (!receipt?.result_ref || receipt.result_ref !== paidResultPath(source,key,"json")) throw Error("STOCK_CONTEXT_TRIAL_VOICE_FINGERPRINT_MISMATCH");
    const meta = await results.getJson<Meta>(receipt.result_ref);
    const audio = meta?.audioPath === paidResultPath(source,key,"mp3") ? await results.getBytes(meta.audioPath) : null;
    if (!meta || !audio || meta.bytes !== audio.length || meta.sha256 !== sha256Hex(audio) || !meta.words.length || !Number.isFinite(meta.durationSeconds)) throw Error("STOCK_CONTEXT_TRIAL_VOICE_BYTES_UNVERIFIED");
    const newKey = paidCallKey({ ...spec, projectId: REQUEST });
    const metaPath = paidResultPath(REQUEST,newKey,"json");
    // A verified cached sidecar references the original paid audio; no paid TTS
    // row is fabricated. The separate internal reuse receipt records provenance.
    await results.putJson(metaPath,meta);
    return { metaPath, sourceOperation: key, sha256: meta.sha256, durationSeconds: meta.durationSeconds };
  };
  const first = await reuse();
  const final = checkDuration(30,first.durationSeconds).withinTolerance ? first : await reuse(first.durationSeconds / 30);
  if (!checkDuration(30,final.durationSeconds).withinTolerance) throw Error("STOCK_CONTEXT_TRIAL_CACHED_DURATION_REJECTED");
  const evidence = { sourceRequestId: source, textHash: stableHash(text,64), voiceIdentity: identity, first, final, finalMetaPath: final.metaPath, newVoiceCalls: 0 };
  await base.insert({ idempotencyKey: `stock_context_voice_reuse:${REQUEST}`, projectId: REQUEST, shotId: "voice:cache-reuse", provider: "internal", model: "verified-paid-voice-cache",
    method: "reuse_paid_asset", attemptKind: "initial", reservedUsd: 0, committedUsd: 0, status: "COMMITTED", providerJobId: null, resultRef: JSON.stringify(evidence), updatedAt: new Date().toISOString() });
  return evidence;
}
main().catch(async error => {
  Object.assign(console, originals);
  report.qualityPassed = false; report.error = error instanceof Error ? error.message.slice(0, 1000) : "unknown";
  if (claimed) await service.from("video_requests").update({ status: "failed", progress_stage: "failed", error_message: "La prueba de calidad se detuvo. Se conservan los resultados pagados; no se repetirán llamadas automáticamente." })
    .eq("id", REQUEST).eq("status", "processing").eq("render_attempts", 1);
  originals.error("STOCK_CONTEXT_TRIAL_STOPPED_DETAILS_IN_PRIVATE_REPORT"); process.exitCode = 1;
}).finally(async () => {
  if (!claimed) return;
  const rows = await ledgerRows(); report.accountedUsd = accounted(rows);
  report.operations = rows.map(r => ({ shot: r.shot_id, method: r.method, provider: r.provider, status: r.status, reservedUsd: r.reserved_usd, committedUsd: r.committed_usd }));
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const stored = await service.storage.from("videos").upload(`${REQUEST}/stock-context-trial/report.json`, Buffer.from(JSON.stringify(report)), { contentType: "application/json", upsert: true });
  if (stored.error) { originals.error("STOCK_CONTEXT_TRIAL_REPORT_PERSIST_FAILED"); process.exitCode = 1; }
});
