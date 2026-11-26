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
import { sha256File } from "./output-media";

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
    "-t", String(target), "-c:v", "libx264", "-preset", "medium", "-b:v", "2300k", "-maxrate", "2400k", "-bufsize", "4800k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-c:s", "copy", "-movflags", "+faststart", candidate],
  { timeout: 600_000, maxBuffer: 2 * 1024 * 1024, killSignal: "SIGKILL" });
  const after = await probeRepairMedia(candidate);
  if (after.duration < target || after.duration > target + 0.1 || before.width !== after.width || before.height !== after.height || before.fps !== after.fps) throw new Error("repair_candidate_media_mismatch");
  await assertNoLongBlackIntervals(candidate);
  if (await sha256File(source) !== originalHash) throw new Error("repair_original_mutated");
  return { before, after, originalHash, candidateHash: await sha256File(candidate), target };
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
  const ceilingBytes = Math.min(ORIGINAL_BYTES, deps.finalize.storageMaxBytes ?? LONG_FORM_OUTPUT_POLICY.demonstratedStorageMaxBytes, LONG_FORM_OUTPUT_POLICY.policyMaxBytes);
  if (decideOutputFit({ bytes: candidateBytes, durationSeconds: 180, ceilingBytes }).action !== "upload") throw new Error("repair_candidate_storage_cap_failed_BEFORE_INTENT");
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
