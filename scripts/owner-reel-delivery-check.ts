/** Server-only verification of the already accepted reel. No generation or browser credentials. */
import { createServiceClient } from "../src/lib/supabase/service";
import { getSignedVideoUrlForRequest } from "../src/lib/storage/signed-url";
import { asDownloadUrl } from "../src/lib/storage/download-url";
import { sha256Hex } from "../src/lib/paid-calls/result-store";

const requestId = "34bc43f3-a53d-4daa-b8fa-bef3f1544b04";
const ownerId = "d2064950-7a95-4208-8dfb-d93b470d141d";
const videoPath = `${requestId}/attempt-1/final.mp4`;
const expectedBytes = 5_809_682;
const expectedHash = "69f5b40bb1165c94c31a699374fb7e78dbfa3c556cf4370596b6f4e8b3abbb61";
const deployedCommit = "20e137529c3577172f8f2acb8d4f67fdb34fb86a";

async function main() {
  const runId = process.env.GITHUB_RUN_ID, commit = process.env.GITHUB_SHA;
  if (process.env.GITHUB_ACTIONS !== "true" || !runId || !/^\d+$/.test(runId)
    || !commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("DELIVERY_CHECK_ISOLATED_WORKER_REQUIRED");
  const service = createServiceClient();
  const checks: Record<string, boolean> = {};
  const http: Record<string, number> = {};
  let failure: string | null = null;
  try {
    const request = await service.from("video_requests").select("id,user_id,status,video_path,render_attempts,error_message")
      .eq("id", requestId).eq("user_id", ownerId).single();
    if (request.error || !request.data || request.data.status !== "completed" || request.data.render_attempts !== 1
      || request.data.error_message !== null || request.data.video_path !== videoPath) throw new Error("DELIVERY_CHECK_REQUEST_STATE");
    const owner = await service.auth.admin.getUserById(ownerId);
    if (owner.error || !owner.data.user?.email_confirmed_at) throw new Error("DELIVERY_CHECK_OWNER_UNVERIFIED");
    const bucket = await service.storage.getBucket("videos");
    if (bucket.error || bucket.data?.public !== false) throw new Error("DELIVERY_CHECK_BUCKET_NOT_PRIVATE");
    checks.ownedCompletedPrivateObject = true;

    // Create this worker's own short-lived URL via the same owner-scoped helper as the page.
    // Never read browser cookies, credentials, tokens, signed links, or network state.
    const signed = await getSignedVideoUrlForRequest(request.data, ownerId, undefined, 120);
    if (!signed) throw new Error("DELIVERY_CHECK_SIGNING");
    const url = new URL(signed);
    if (url.protocol !== "https:" || url.hostname !== "msyxczcdjhbednmfzxqq.supabase.co"
      || url.pathname !== `/storage/v1/object/sign/videos/${videoPath}`) throw new Error("DELIVERY_CHECK_DESTINATION");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    http.playback = response.status;
    checks.playbackHttp200 = response.status === 200;
    checks.playbackMime = response.headers.get("content-type")?.split(";")[0] === "video/mp4";
    checks.playbackLength = Number(response.headers.get("content-length")) === expectedBytes;
    if (!checks.playbackHttp200 || !checks.playbackMime || !checks.playbackLength) {
      await response.body?.cancel(); throw new Error("DELIVERY_CHECK_PLAYBACK_RESPONSE");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    checks.acceptedBytes = bytes.length === expectedBytes && sha256Hex(bytes) === expectedHash;

    const partial = await fetch(url, { headers: { Range: "bytes=0-1023" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    http.range = partial.status;
    checks.rangeHttp206 = partial.status === 206;
    checks.rangeHeader = partial.headers.get("content-range") === `bytes 0-1023/${expectedBytes}`;
    if (!checks.rangeHttp206 || !checks.rangeHeader) { await partial.body?.cancel(); throw new Error("DELIVERY_CHECK_RANGE_RESPONSE"); }
    const rangeBytes = Buffer.from(await partial.arrayBuffer());
    checks.rangeBytes = rangeBytes.length === 1024 && rangeBytes.equals(bytes.subarray(0, 1024));

    const download = await fetch(asDownloadUrl(signed, "atomivid-video.mp4"), {
      headers: { Range: "bytes=0-1023" }, redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    http.download = download.status;
    checks.downloadHttp206 = download.status === 206;
    checks.downloadAttachment = /^attachment\b/i.test(download.headers.get("content-disposition") ?? "")
      && (download.headers.get("content-disposition") ?? "").includes("atomivid-video.mp4");
    if (!checks.downloadHttp206) { await download.body?.cancel(); throw new Error("DELIVERY_CHECK_DOWNLOAD_RESPONSE"); }
    checks.downloadBytes = Buffer.from(await download.arrayBuffer()).equals(bytes.subarray(0, 1024));

    const unsigned = new URL(url);
    unsigned.search = "";
    const denied = await fetch(unsigned, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    http.unsigned = denied.status;
    await denied.body?.cancel();
    checks.unsignedDenied = denied.status >= 400 && denied.status < 500;

    const after = await service.from("video_requests").select("id,user_id,status,video_path,render_attempts,error_message")
      .eq("id", requestId).eq("user_id", ownerId).single();
    checks.requestUnchanged = !after.error && JSON.stringify(after.data) === JSON.stringify(request.data);
    if (!Object.values(checks).every(Boolean)) throw new Error("DELIVERY_CHECK_FAILED_CRITERION");
  } catch (error) {
    // No provider messages, raw response bodies, headers, URLs, tokens or credentials in reports/logs.
    failure = error instanceof Error && /^DELIVERY_CHECK_[A-Z_]+$/.test(error.message)
      ? error.message : "DELIVERY_CHECK_TRANSPORT_OR_DEPENDENCY";
  }
  const report = { version: 1, runId, commit, deployedCommit, checkedAt: new Date().toISOString(),
    checks, http, failure, passed: failure === null && Object.values(checks).every(Boolean),
    providerCalls: 0, browserPlaybackVerified: false, browserDownloadVerified: false };
  // Private technical evidence only. The existing request, grants and paid ledger are never written.
  const stored = await service.storage.from("videos").upload(`${requestId}/delivery-verification/${commit}/${runId}.json`,
    Buffer.from(JSON.stringify(report)), { contentType: "application/json", upsert: false, metadata: report });
  if (stored.error) throw new Error("DELIVERY_CHECK_REPORT_STORAGE");
  if (!report.passed) throw new Error(failure ?? "DELIVERY_CHECK_FAILED_CRITERION");
  console.log("OWNER_REEL_SERVER_DELIVERY_CHECK_PASSED_BROWSER_VERIFICATION_PENDING");
}
main().catch(() => { console.error("OWNER_REEL_SERVER_DELIVERY_CHECK_FAILED_SEE_PRIVATE_REPORT"); process.exitCode = 1; });
