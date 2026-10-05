/** Audit the owner's existing approved avatar. Never import trial/generation scripts. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import { createServiceClient } from "../src/lib/supabase/service";
import { getSignedVideoUrlForRequest } from "../src/lib/storage/signed-url";
import { asDownloadUrl } from "../src/lib/storage/download-url";
import { sha256Hex } from "../src/lib/paid-calls/result-store";

const requestId = "245a8a51-a699-4f69-a387-7c11246a0b7f";
const videoPath = `${requestId}/final.mp4`;
const narrationPath = `${requestId}/avatar-narration.wav`;
const expectedBytes = 34_866_991;
const selection = "id,user_id,avatar_id,status,video_path,recorded_audio_path,render_attempts,error_message,avatar_generation_started_at,avatar_provider_video_job_id";
function deny(code: string): never { throw new Error(`AVATAR_CHECK_${code}`); }
function probe(path: string) {
  const result = spawnSync(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256_000 });
  if (result.status !== 0) deny("PROBE");
  return JSON.parse(result.stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
}
async function main() {
  const runId = process.env.GITHUB_RUN_ID, commit = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== "true" || !runId || !/^\d+$/.test(runId) || !commit || !/^[a-f0-9]{40}$/.test(commit)) deny("ISOLATED_WORKER_REQUIRED");
  const service = createServiceClient();
  const checks: Record<string, boolean> = {};
  let failure: string | null = null;
  let media: Record<string, unknown> = {};
  let temp: string | undefined;
  try {
    const row = await service.from("video_requests").select(selection).eq("id", requestId).single();
    if (row.error || !row.data) deny("REQUEST");
    const request = row.data;
    const owner = await service.auth.admin.getUserById(request.user_id);
    if (owner.error || !owner.data.user?.email_confirmed_at || owner.data.user.email?.toLowerCase() !== "hansgtav77+beta@gmail.com") deny("OWNER");
    const avatar = await service.from("avatars").select("id,user_id,provider,consent_given").eq("id", request.avatar_id).eq("user_id", request.user_id).single();
    if (avatar.error || !avatar.data || avatar.data.provider !== "heygen" || avatar.data.consent_given !== true) deny("CONSENT_OR_PROVIDER");
    if (request.status !== "completed" || request.render_attempts !== 1 || request.error_message !== null || request.video_path !== videoPath
      || !request.recorded_audio_path || !request.avatar_generation_started_at || !request.avatar_provider_video_job_id) deny("STATE");
    const bucket = await service.storage.getBucket("videos");
    if (bucket.error || bucket.data?.public !== false) deny("PRIVATE_BUCKET");
    checks.ownedCompletedConsentedPrivateObject = true;
    const signed = await getSignedVideoUrlForRequest(request, request.user_id, undefined, 120);
    if (!signed) deny("SIGNING");
    const url = new URL(signed);
    if (url.protocol !== "https:" || url.hostname !== "msyxczcdjhbednmfzxqq.supabase.co" || url.pathname !== `/storage/v1/object/sign/videos/${videoPath}`) deny("DESTINATION");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    checks.playbackResponse = response.status === 200 && response.headers.get("content-type")?.split(";")[0] === "video/mp4" && Number(response.headers.get("content-length")) === expectedBytes;
    if (!checks.playbackResponse) { await response.body?.cancel(); deny("RESPONSE"); }
    const bytes = Buffer.from(await response.arrayBuffer());
    checks.byteLength = bytes.length === expectedBytes;
    if (!checks.byteLength) deny("BYTES");
    const download = await fetch(asDownloadUrl(signed, "atomivid-avatar.mp4"), { headers: { Range: "bytes=0-1023" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    checks.downloadResponse = download.status === 206 && download.headers.get("content-range") === `bytes 0-1023/${expectedBytes}`
      && /^attachment\b/i.test(download.headers.get("content-disposition") ?? "") && (download.headers.get("content-disposition") ?? "").includes("atomivid-avatar.mp4");
    if (!checks.downloadResponse) { await download.body?.cancel(); deny("DOWNLOAD"); }
    checks.downloadBytes = Buffer.from(await download.arrayBuffer()).equals(bytes.subarray(0, 1024));
    const unsigned = new URL(url); unsigned.search = "";
    const denied = await fetch(unsigned, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    checks.unsignedDenied = denied.status >= 400 && denied.status < 500; await denied.body?.cancel();
    const narration = await service.storage.from("videos").download(narrationPath);
    if (narration.error || !narration.data || narration.data.size > 10_000_000) deny("NARRATION");
    temp = await mkdtemp(join(tmpdir(), "owner-avatar-audit-"));
    const videoFile = join(temp, "final.mp4"), audioFile = join(temp, "narration.wav");
    await writeFile(videoFile, bytes); await writeFile(audioFile, Buffer.from(await narration.data.arrayBuffer()));
    const video = probe(videoFile), audio = probe(audioFile);
    const videoStream = video.streams.find(s => s.codec_type === "video"), audioStream = video.streams.find(s => s.codec_type === "audio");
    const duration = Number(video.format.duration), narrationDuration = Number(audio.format.duration);
    checks.browserCompatibleStreams = videoStream?.codec_name === "h264" && audioStream?.codec_name === "aac";
    checks.portrait = Boolean(videoStream?.width && videoStream.height && Math.abs(videoStream.width / videoStream.height - 9 / 16) < 0.02);
    checks.durationCoherent = Number.isFinite(duration) && Number.isFinite(narrationDuration) && narrationDuration > 40 && narrationDuration < 45 && Math.abs(duration - narrationDuration) <= 2;
    const decode = spawnSync(ffmpeg.path, ["-v", "error", "-xerror", "-i", videoFile, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 256_000 });
    checks.fullDecode = decode.status === 0 && !decode.error;
    media = { bytes: bytes.length, sha256: sha256Hex(bytes), duration, narrationDuration, width: videoStream?.width, height: videoStream?.height, videoCodec: videoStream?.codec_name, audioCodec: audioStream?.codec_name };
    const after = await service.from("video_requests").select(selection).eq("id", requestId).eq("user_id", request.user_id).single();
    checks.requestUnchanged = !after.error && JSON.stringify(after.data) === JSON.stringify(request);
    if (!Object.values(checks).every(Boolean)) deny("CRITERION");
  } catch (error) {
    failure = error instanceof Error && /^AVATAR_CHECK_[A-Z_]+$/.test(error.message) ? error.message : "AVATAR_CHECK_TRANSPORT_OR_DEPENDENCY";
  } finally { if (temp) await rm(temp, { recursive: true, force: true }); }
  const report = { version: 1, requestId, runId, commit, checkedAt: new Date().toISOString(), checks, media, failure,
    passed: failure === null && Object.values(checks).every(Boolean), providerCalls: 0, browserPlaybackVerified: false, visualIdentityVerified: false, lipSyncVerified: false };
  const stored = await service.storage.from("videos").upload(`${requestId}/delivery-verification/${commit}/${runId}.json`, Buffer.from(JSON.stringify(report)),
    { contentType: "application/json", upsert: false, metadata: report });
  if (stored.error) deny("REPORT_STORAGE");
  if (!report.passed) deny("FAILED_SEE_PRIVATE_REPORT");
  console.log("OWNER_EXISTING_AVATAR_TECHNICAL_DELIVERY_PASSED_VISUAL_REVIEW_PENDING");
}
main().catch(() => { console.error("OWNER_EXISTING_AVATAR_AUDIT_FAILED_SEE_PRIVATE_REPORT"); process.exitCode = 1; });
