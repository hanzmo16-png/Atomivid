/** Explicit offline repair only. No provider, production, accounting or row-retry dependencies. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { LONG_FORM_OUTPUT_POLICY, decideOutputFit } from "./output-policy";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import { assertNoLongBlackIntervals, parseBlackDetectOutput } from "./long-form-qc";
import { finalizeLongFormOutput, type LongFormOutputState, type OutputFinalizeDeps } from "./output-finalize";
import { sha256File, type OutputMediaMetrics } from "./output-media";

const run = promisify(execFile);
export const ORIGINAL_SHA256 = "c51e179b5aaa05cf4b443b1c046b14c58795d796e47ea38abb6135785777a0d4";
export const REPAIR_REQUEST_ID = "41fe8781-75d5-4b48-91b6-0c3094ebedfd";
export const ROOT_DRIVE_RECEIPT_SHA256 = "59621bf0a8221968e505f602e4c32d246652b3040f6ac9fe7759a22f5bf357b2";
export const ORIGINAL_BYTES = 58683166;
export const NATIVE_RUN_ID = 45838670701;
export const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
export function assertPrivateCanonicalUrl(signedUrl: string, supabaseUrl: string): void {
  const url = new URL(signedUrl), origin = new URL(supabaseUrl);
  if (url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password || url.hash
    || url.pathname !== `/storage/v1/object/sign/videos/${REPAIR_REQUEST_ID}/output/final.mp4` || !url.searchParams.get("token")) throw new Error("private_canonical_url_mismatch");
}
export type CachedRepairValidation = {
  status: "VALIDATED_NOT_APPLIED"; requestId: string; proofSha256: string; originalSha256: string;
  candidateSha256: string; candidatePath: string; bytes: number; metrics: Awaited<ReturnType<typeof probeRepairMedia>>;
  beforeSnapshotSha256: string; target: 180; runId: string;
};
export async function loadApprovedCachedCandidate(input: { receiptPath: string; receiptSha256: string; approvedCandidateSha256: string; proofSha256: string; beforeSnapshotSha256: string }, download: (path: string) => Promise<Buffer>) {
  const prefix = `${REPAIR_REQUEST_ID}/state/free-duration-repair-v1`;
  if (!input.receiptPath.startsWith(`${prefix}/validation-`) || !/^[0-9]+\.json$/.test(input.receiptPath.slice(`${prefix}/validation-`.length))
    || !/^[a-f0-9]{64}$/.test(input.receiptSha256) || !/^[a-f0-9]{64}$/.test(input.approvedCandidateSha256)) throw new Error("approved_validation_receipt_required");
  const raw = await download(input.receiptPath);
  if (hash(raw) !== input.receiptSha256) throw new Error("validation_receipt_hash_mismatch");
  const receipt = JSON.parse(raw.toString()) as CachedRepairValidation;
  if (receipt.status !== "VALIDATED_NOT_APPLIED" || receipt.requestId !== REPAIR_REQUEST_ID || receipt.originalSha256 !== ORIGINAL_SHA256
    || receipt.proofSha256 !== input.proofSha256 || receipt.beforeSnapshotSha256 !== input.beforeSnapshotSha256 || receipt.target !== 180
    || receipt.candidateSha256 !== input.approvedCandidateSha256 || receipt.candidatePath !== `${prefix}/candidate-${input.approvedCandidateSha256}.mp4`
    || !(receipt.bytes > 0 && receipt.bytes <= ORIGINAL_BYTES)) throw new Error("validated_candidate_binding_mismatch");
  const bytes = await download(receipt.candidatePath);
  if (bytes.length !== receipt.bytes || hash(bytes) !== input.approvedCandidateSha256) throw new Error("cached_candidate_tampered");
  return { receipt, bytes };
}
export function assertPrivateCandidateUrl(signedUrl: string, supabaseUrl: string, candidateSha256: string): void {
  const url = new URL(signedUrl), origin = new URL(supabaseUrl);
  if (!/^[a-f0-9]{64}$/.test(candidateSha256) || url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password || url.hash
    || url.pathname !== `/storage/v1/object/sign/videos/${REPAIR_REQUEST_ID}/state/free-duration-repair-v1/candidate-${candidateSha256}.mp4` || !url.searchParams.get("token")) throw new Error("private_candidate_url_mismatch");
}
export type PreservationProof = {
  version: 1; requestId: string; qaOwnerId: string; rootOwnerLogin: string;
  originalSha256: string; originalBytes: number; nativeRunId: number;
  drive: { rootReceiptSha256: string; independentReadback: true; method: "GoogleDriveConnector"; privateOwnerOnly: true; verifiedAt: string; expiresAt: string };
  ledgerObjectPaths: string[];
};
export function assertProof(p: PreservationProof, owner: string, actor: string): void {
  if (p.version !== 1 || !/^[a-f0-9-]{36}$/.test(p.requestId) || !/^[a-f0-9-]{36}$/.test(p.qaOwnerId)
    || !owner || actor !== owner || p.rootOwnerLogin !== owner || p.originalSha256 !== ORIGINAL_SHA256
    || p.originalBytes !== ORIGINAL_BYTES || p.nativeRunId !== NATIVE_RUN_ID
    || p.requestId !== REPAIR_REQUEST_ID || p.drive?.rootReceiptSha256 !== ROOT_DRIVE_RECEIPT_SHA256
    || p.drive.independentReadback !== true || p.drive.method !== "GoogleDriveConnector" || p.drive.privateOwnerOnly !== true
    || !Number.isFinite(Date.parse(p.drive.verifiedAt)) || !Number.isFinite(Date.parse(p.drive.expiresAt))
    || Date.parse(p.drive.expiresAt) <= Date.now() || Date.parse(p.drive.expiresAt) - Date.parse(p.drive.verifiedAt) > 86_400_000
    || !Array.isArray(p.ledgerObjectPaths) || p.ledgerObjectPaths.length === 0) throw new Error("root_private_preservation_proof_required");
}
export async function probeRepairMedia(file: string) {
  const { stdout } = await run(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const j = JSON.parse(stdout) as { format: { duration: string }; streams: { codec_type: string; duration?: string; start_time?: string; width?: number; height?: number; r_frame_rate?: string }[] };
  const video = j.streams.find(s => s.codec_type === "video");
  const audio = j.streams.find(s => s.codec_type === "audio");
  if (!video || !audio) throw new Error("repair_requires_video_and_audio");
  const duration = Number(video.duration ?? j.format.duration);
  const audioDuration = Number(audio.duration);
  const avEndDelta = Math.abs((Number(video.start_time ?? 0) + duration) - (Number(audio.start_time ?? 0) + audioDuration));
  if (![duration, audioDuration, avEndDelta].every(Number.isFinite) || duration <= 0 || avEndDelta > 0.1
    || Math.abs(Number(video.start_time ?? 0) - Number(audio.start_time ?? 0)) > 0.05) throw new Error("repair_av_sync_failed");
  return { duration, audioDuration, avEndDelta, width: video.width, height: video.height, fps: video.r_frame_rate };
}
/** Explicit installer binary, never the system PATH or a mutable FFMPEG/FFPROBE env override. */
export async function probePinnedOutput(file: string): Promise<OutputMediaMetrics> {
  const [stat, result] = await Promise.all([fs.stat(file), run(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 30_000, maxBuffer: 1024 * 1024 })]);
  const j = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; bit_rate?: string }[] };
  const video = j.streams?.find(x => x.codec_type === "video"), audio = j.streams?.find(x => x.codec_type === "audio");
  const durationSeconds = Number(j.format?.duration ?? 0);
  const [n, d] = (video?.avg_frame_rate ?? video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const kbps = (v?: string) => v && Number.isFinite(Number(v)) ? Math.round(Number(v) / 1000) : null;
  return { bytes: stat.size, durationSeconds, width: video?.width ?? null, height: video?.height ?? null, fps: d ? n / d : null,
    videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null, totalKbps: durationSeconds > 0 ? Math.round(stat.size * 8 / durationSeconds / 1000) : 0, videoKbps: kbps(video?.bit_rate), audioKbps: kbps(audio?.bit_rate) };
}
export async function inspectProbeDependency(file: string, defaultProbe: (file: string) => Promise<OutputMediaMetrics>) {
  let defaultProbePassed = false;
  let defaultProbeError: { code: string; reason: string; message: string } | null = null;
  // Deliberately run the unchanged production dependency first, before the pinned adapter.
  try { await defaultProbe(file); defaultProbePassed = true; }
  catch (err) { const e = err as { code?: string; message?: string }; defaultProbeError = { code: e.code ?? "unknown", reason: "ffprobe_failed", message: (e.message ?? String(err)).slice(0, 1000) }; }
  const pinned = await probePinnedOutput(file);
  return { defaultProbePassed, defaultProbeError, pinned, dependencyGapConfirmed: !defaultProbePassed && defaultProbeError?.code === "ENOENT" && Boolean(pinned.videoCodec && pinned.audioCodec && pinned.durationSeconds >= 180) };
}
export const FAILED_BEFORE_UPLOAD_RUN_ID = 45850929535;
export type BeforeUploadInspection = {
  status: "INSPECTED_ORIGINAL_BEFORE_UPLOAD"; failedRunId: number; intentSha256: string; canonicalSha256: string; originalStateSha256: string;
  candidateSha256: string; validationReceiptSha256: string; proofSha256: string; beforeSnapshotSha256: string; snapshotEqual: true; resultAbsent: true; dependencyGapConfirmed: true; originalMediaMatch: true;
};
export function assertResumeInspection(input: { rawInspection: Buffer; expectedInspectionSha256: string; rawIntent: Buffer; expectedIntentSha256: string; canonicalSha256: string; originalStateSha256: string; candidateSha256: string; validationReceiptSha256: string; proofSha256: string; beforeSnapshotSha256: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedIntentSha256) || hash(input.rawIntent) !== input.expectedIntentSha256 || hash(input.rawInspection) !== input.expectedInspectionSha256) throw new Error("exact_root_approved_inspection_and_intent_required");
  const inspected = JSON.parse(input.rawInspection.toString()) as BeforeUploadInspection;
  const intent = JSON.parse(input.rawIntent.toString()) as Record<string, unknown>;
  if (inspected.status !== "INSPECTED_ORIGINAL_BEFORE_UPLOAD" || inspected.failedRunId !== FAILED_BEFORE_UPLOAD_RUN_ID || inspected.intentSha256 !== input.expectedIntentSha256
    || inspected.canonicalSha256 !== ORIGINAL_SHA256 || input.canonicalSha256 !== ORIGINAL_SHA256 || inspected.originalStateSha256 !== input.originalStateSha256
    || inspected.candidateSha256 !== input.candidateSha256 || inspected.validationReceiptSha256 !== input.validationReceiptSha256 || inspected.proofSha256 !== input.proofSha256
    || inspected.beforeSnapshotSha256 !== input.beforeSnapshotSha256 || inspected.snapshotEqual !== true || inspected.resultAbsent !== true || inspected.dependencyGapConfirmed !== true || inspected.originalMediaMatch !== true
    || intent.originalSha256 !== ORIGINAL_SHA256 || intent.candidateSha256 !== input.candidateSha256 || intent.validationReceiptSha256 !== input.validationReceiptSha256
    || intent.proofSha256 !== input.proofSha256 || intent.beforeSnapshotSha256 !== input.beforeSnapshotSha256 || intent.attempt !== 1) throw new Error("resume_before_upload_binding_mismatch");
  return inspected;
}
/** Clone the last decoded visible frame and pad existing mixed audio; never invent or resynthesize narration. */
export async function createDurationRepair(source: string, candidate: string, target = 180) {
  const before = await probeRepairMedia(source);
  const extra = target - before.duration;
  if (!(extra > 0 && extra <= 2) || !Number.isFinite(target)) throw new Error("repair_extension_out_of_bounds");
  const originalHash = await sha256File(source);
  await assertNoLongBlackIntervals(source);
  const tail = await run(ffmpeg.path, ["-nostdin", "-sseof", "-0.1", "-i", source, "-vf", "blackdetect=d=0.001:pic_th=0.98:pix_th=0.1", "-an", "-sn", "-f", "null", "-"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (parseBlackDetectOutput(tail.stderr).length) throw new Error("repair_terminal_frame_not_visible");
  await run(ffmpeg.path, ["-nostdin", "-n", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-map", "0:s?",
    "-vf", `tpad=stop_mode=clone:stop_duration=${extra + 0.1}`, "-af", `apad,atrim=duration=${target}`,
    "-t", String(target), "-c:v", "libx264", "-preset", "medium", "-b:v", "2300k", "-maxrate", "2400k", "-bufsize", "4800k", "-threads", "2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-c:s", "copy", "-movflags", "+faststart", candidate],
  { timeout: 600_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" });
  const after = await probeRepairMedia(candidate);
  if (after.duration < target || after.duration > target + 0.1 || before.width !== after.width || before.height !== after.height || before.fps !== after.fps) throw new Error("repair_candidate_media_mismatch");
  await assertNoLongBlackIntervals(candidate);
  if (await sha256File(source) !== originalHash) throw new Error("repair_original_mutated");
  return { before, after, originalHash, candidateHash: await sha256File(candidate), target };
}
export function assertRepairCandidateSize(bytes: number, configuredMaxBytes?: number | null): void {
  const ceilingBytes = Math.min(ORIGINAL_BYTES, configuredMaxBytes ?? LONG_FORM_OUTPUT_POLICY.demonstratedStorageMaxBytes, LONG_FORM_OUTPUT_POLICY.policyMaxBytes);
  if (!(bytes > 0) || decideOutputFit({ bytes, durationSeconds: 180, ceilingBytes }).action !== "upload") throw new Error("repair_candidate_storage_cap_failed_BEFORE_INTENT");
}
export type RepairDeps = {
  finalize: OutputFinalizeDeps;
  /** Deterministic offline test seams; ops adapter never overrides these. */
  fileHash?: typeof sha256File;
  candidateQc?: (original: string, candidate: string) => Promise<void>;
  /** Must hash current canonical bytes, not state metadata. */
  canonicalHash(): Promise<string>;
  /** Entire row + PI operations + generation_costs + raw ledger hashes. Read-only. */
  snapshot(): Promise<unknown>;
  /** Atomic create-only immutable intent at a fixed per-request path. Existing intent always blocks rerun. */
  createIntent(intent: unknown): Promise<void>;
  /** Create-only retained original/candidate and receipt objects before canonical mutation. */
  preserve(original: string, candidate: string, state: LongFormOutputState): Promise<void>;
};
export async function applyDurationRepair(input: { requestId: string; original: string; candidate: string; proofHash: string; state: LongFormOutputState; candidateHash: string }, deps: RepairDeps) {
  const state = input.state;
  const fileHash = deps.fileHash ?? sha256File;
  if (state.requestId !== input.requestId || state.status !== "UPLOADED" || state.attempt !== 1 || state.costsRecorded !== true || state.nativeBlackQc !== "passed-v1" || state.sha256 !== ORIGINAL_SHA256) throw new Error("repair_original_state_invalid");
  if (await fileHash(input.original) !== ORIGINAL_SHA256 || await fileHash(input.candidate) !== input.candidateHash) throw new Error("repair_local_hash_mismatch");
  await (deps.candidateQc ?? (async (original, candidate) => {
    const a = await probeRepairMedia(original), b = await probeRepairMedia(candidate);
    if (!(180 - a.duration > 0 && 180 - a.duration <= 2) || b.duration < 180 || b.duration > 180.1
      || a.width !== b.width || a.height !== b.height || a.fps !== b.fps) throw new Error("repair_candidate_qc_failed");
    await assertNoLongBlackIntervals(candidate);
  }))(input.original, input.candidate);
  const candidateBytes = (await fs.stat(input.candidate)).size;
  assertRepairCandidateSize(candidateBytes, deps.finalize.storageMaxBytes);
  const before = await deps.snapshot();
  const beforeHash = hash(stableJson(before));
  if (await deps.canonicalHash() !== ORIGINAL_SHA256) throw new Error("repair_canonical_changed");
  const lineage = { version: 1, originalSha256: ORIGINAL_SHA256, candidateSha256: input.candidateHash, proofSha256: input.proofHash, beforeSnapshotSha256: beforeHash, nativeRunId: NATIVE_RUN_ID, attempt: 1, providerCalls: 0, candidateBytes };
  await deps.createIntent({ ...lineage, beforeSnapshot: before });
  await deps.preserve(input.original, input.candidate, state);
  let uploaded = false;
  let stateWritten = false;
  const result = await finalizeLongFormOutput({ requestId: input.requestId, attempt: 1, filePath: input.candidate, profile: state.profile }, {
    ...deps.finalize,
    transcode: async () => { throw new Error("repair_size_fit_forbidden"); },
    upload: async (objectPath, filePath) => {
      if (uploaded) throw new Error("repair_second_upload_forbidden");
      if (hash(stableJson(await deps.snapshot())) !== beforeHash || await deps.canonicalHash() !== ORIGINAL_SHA256) throw new Error("repair_preupload_snapshot_changed");
      if (await fileHash(filePath) !== input.candidateHash) throw new Error("repair_candidate_changed");
      uploaded = true;
      return deps.finalize.upload(objectPath, filePath); // adapter is a single standard upload, no retries.
    },
    writeState: async (next) => {
      if (next.status !== "UPLOADED") return; // retain original state on any ambiguous failure.
      await deps.finalize.writeState({ ...state, ...next, costsRecorded: true, repairLineage: lineage } as LongFormOutputState);
      stateWritten = true;
    },
  });
  if (!stateWritten) throw new Error("repair_state_write_ambiguous_NO_RETRY");
  if (hash(stableJson(await deps.snapshot())) !== beforeHash) throw new Error("repair_postupload_financial_snapshot_changed_NO_RETRY");
  if (await deps.canonicalHash() !== input.candidateHash) throw new Error("repair_postupload_hash_mismatch_NO_RETRY");
  return { ...result, state: { ...state, ...result.state, costsRecorded: true, repairLineage: lineage }, before, beforeHash, lineage };
}

export const FAILED_AFTER_UPLOAD_RUN_ID = 45853613321;
/** Acceptance of already uploaded bytes only; this function has no encoder/upload/financial-write capability. */
export function verifyUploadedRepair(input: {
  sdkBytes: Buffer; httpsBytes: Buffer; expectedBytes: number; candidateSha256: string; proofSha256: string; validationReceiptSha256: string;
  rawIntent: Buffer; intentSha256: string; rawInspection: Buffer; inspectionSha256: string; rawResumeFence: Buffer; rawOriginalState: Buffer;
  sdkState: LongFormOutputState; httpsState: LongFormOutputState; beforeSnapshotSha256: string; afterSnapshotSha256: string;
  pinned: OutputMediaMetrics; media: Awaited<ReturnType<typeof probeRepairMedia>>;
}) {
  const i = input;
  if (hash(i.sdkBytes) !== i.candidateSha256 || hash(i.httpsBytes) !== i.candidateSha256 || i.sdkBytes.length !== i.expectedBytes || i.httpsBytes.length !== i.expectedBytes) throw new Error("uploaded_bytes_ambiguous_NO_UPLOAD_ALLOWED");
  if (hash(i.rawIntent) !== i.intentSha256 || hash(i.rawInspection) !== i.inspectionSha256) throw new Error("uploaded_history_hash_mismatch");
  const intent = JSON.parse(i.rawIntent.toString()) as Record<string, unknown>;
  const inspected = JSON.parse(i.rawInspection.toString()) as BeforeUploadInspection;
  const fence = JSON.parse(i.rawResumeFence.toString()) as Record<string, unknown>;
  const originalState = JSON.parse(i.rawOriginalState.toString()) as LongFormOutputState;
  if (intent.originalSha256 !== ORIGINAL_SHA256 || intent.candidateSha256 !== i.candidateSha256 || intent.proofSha256 !== i.proofSha256
    || intent.validationReceiptSha256 !== i.validationReceiptSha256 || intent.beforeSnapshotSha256 !== i.beforeSnapshotSha256 || intent.attempt !== 1 || intent.nativeRunId !== NATIVE_RUN_ID || intent.providerCalls !== 0 || intent.candidateBytes !== i.expectedBytes
    || inspected.status !== "INSPECTED_ORIGINAL_BEFORE_UPLOAD" || inspected.intentSha256 !== i.intentSha256 || inspected.proofSha256 !== i.proofSha256 || inspected.validationReceiptSha256 !== i.validationReceiptSha256
    || inspected.candidateSha256 !== i.candidateSha256 || inspected.originalStateSha256 !== hash(i.rawOriginalState) || inspected.canonicalSha256 !== ORIGINAL_SHA256
    || inspected.beforeSnapshotSha256 !== i.beforeSnapshotSha256 || inspected.failedRunId !== FAILED_BEFORE_UPLOAD_RUN_ID
    || inspected.dependencyGapConfirmed !== true || inspected.originalMediaMatch !== true || inspected.resultAbsent !== true || inspected.snapshotEqual !== true
    || fence.originalIntentSha256 !== i.intentSha256 || fence.inspectionReceiptSha256 !== i.inspectionSha256 || fence.candidateSha256 !== i.candidateSha256
    || fence.validationReceiptSha256 !== i.validationReceiptSha256 || fence.proofSha256 !== i.proofSha256 || fence.beforeSnapshotSha256 !== i.beforeSnapshotSha256
    || fence.failedRunId !== FAILED_BEFORE_UPLOAD_RUN_ID || String(fence.resumeRunId) !== String(FAILED_AFTER_UPLOAD_RUN_ID)
    || originalState.sha256 !== ORIGINAL_SHA256 || originalState.status !== "UPLOADED" || originalState.attempt !== 1 || originalState.costsRecorded !== true || originalState.nativeBlackQc !== "passed-v1"
    || i.beforeSnapshotSha256 !== i.afterSnapshotSha256) throw new Error("uploaded_lineage_or_financial_snapshot_mismatch");
  const state = i.httpsState;
  if (hash(stableJson(i.sdkState)) !== hash(stableJson(state))) throw new Error("uploaded_state_readback_ambiguous");
  const lineage = (state as LongFormOutputState & { repairLineage?: Record<string, unknown> }).repairLineage;
  if (state.requestId !== REPAIR_REQUEST_ID || state.objectPath !== `${REPAIR_REQUEST_ID}/output/final.mp4` || state.profile !== originalState.profile
    || state.status !== "UPLOADED" || state.sha256 !== i.candidateSha256 || state.nativeBlackQc !== "passed-v1" || state.costsRecorded !== true || state.attempt !== 1
    || lineage?.originalSha256 !== ORIGINAL_SHA256 || lineage?.candidateSha256 !== i.candidateSha256 || lineage?.proofSha256 !== i.proofSha256
    || lineage?.beforeSnapshotSha256 !== i.beforeSnapshotSha256 || lineage?.providerCalls !== 0 || lineage?.attempt !== 1 || lineage?.nativeRunId !== NATIVE_RUN_ID
    || lineage?.candidateBytes !== i.expectedBytes) throw new Error("uploaded_state_or_repair_lineage_invalid");
  const technical = new Set(["status", "objectPath", "attempt", "profile", "delivery", "rendered", "delivered", "sha256", "ceilingBytes", "fit", "uploadMethod", "uploadAttempts", "timingsMs", "updatedAtIso", "nativeBlackQc", "repairLineage"]);
  for (const [key, value] of Object.entries(originalState)) if (!technical.has(key) && stableJson((state as unknown as Record<string, unknown>)[key]) !== stableJson(value)) throw new Error("uploaded_original_financial_field_changed");
  if (i.pinned.bytes !== i.expectedBytes || !i.pinned.videoCodec || !i.pinned.audioCodec || i.media.duration < 180 || i.media.duration > 180.1 || i.media.avEndDelta > 0.1
    || state.delivered?.bytes !== i.pinned.bytes || state.delivered?.videoCodec !== i.pinned.videoCodec || state.delivered?.audioCodec !== i.pinned.audioCodec
    || state.delivered?.width !== i.pinned.width || state.delivered?.height !== i.pinned.height || state.delivered?.fps !== i.pinned.fps
    || Math.abs((state.delivered?.durationSeconds ?? 0) - i.pinned.durationSeconds) > 0.05) throw new Error("uploaded_metrics_invalid");
  return { status: "READONLY_VERIFIED_UPLOADED_CANDIDATE", candidateSha256: i.candidateSha256, bytes: i.expectedBytes, outputStateSha256: hash(stableJson(state)), originalStateSha256: hash(i.rawOriginalState),
    intentSha256: i.intentSha256, inspectionSha256: i.inspectionSha256, resumeFenceSha256: hash(i.rawResumeFence), failedResumeRunId: FAILED_AFTER_UPLOAD_RUN_ID, snapshotEqual: true, metrics: i.media, lineage };
}
