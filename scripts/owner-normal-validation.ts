/** One explicitly authorized normal video. No private output in public Actions logs. */
import { createHash } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase/service";
import { generateScriptForRequest } from "../src/lib/video/generate-script";
import { runRenderJob } from "../src/lib/video/run-job";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ownerSourceHash = "24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5";
async function main() {
  if (Date.now() > Date.parse("2026-09-20T02:00:00Z")) throw new Error("authorization_expired");
  const service = createServiceClient();
  const bucket = service.storage.from("videos");
  const privacy = await service.storage.getBucket("videos");
  if (privacy.error || !privacy.data || privacy.data.public) throw new Error("private_storage_required");
  // Resolve only the owner of the previously authorized request, without loading their media.
  const sources = await service.from("video_requests").select("id,user_id").eq("mode", "avatar");
  const source = sources.data?.find(r => hash(r.id) === ownerSourceHash);
  if (sources.error || !source) throw new Error("owner_unavailable");
  const h = hash(`normal-owner-validation-2026-09-19:${source.id}`);
  const id = `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  // The immutable PK is the durable reservation BEFORE any billable call.
  // A repeated workflow cannot create a second script, voice or video.
  const input = { topic: "La constancia se construye con decisiones pequeñas", style: "Motivacional", durationSeconds: 30, language: "es" as const };
  const insert = await service.from("video_requests").insert({ id, user_id: source.user_id,
    topic: input.topic, style: input.style, duration_seconds: input.durationSeconds, language: input.language,
    mode: "visual", status: "pending", render_attempts: 0, idempotency_key: `normal-validation:${id}` });
  if (insert.error) throw new Error(insert.error.code === "23505" ? "single_attempt_already_reserved" : "reservation_failed");
  const original = { log: console.log, warn: console.warn, error: console.error };
  const report: Record<string, unknown> = { started_at: new Date().toISOString(), kind: "normal_video_validation", status: "started" };
  let failed = false;
  try {
    console.log = console.warn = console.error = () => {};
    const { script, providerName } = await generateScriptForRequest(input);
    if (providerName === "fixture") throw new Error("real_script_required");
    const claim = await service.from("video_requests").update({ script_json: script, status: "processing",
      render_attempts: 1, render_started_at: new Date().toISOString(), render_worker: "owner-normal-validation", progress_stage: "queued" })
      .eq("id",id).eq("user_id",source.user_id).eq("status","pending").eq("render_attempts",0).select("id").maybeSingle();
    if (claim.error || !claim.data) throw new Error("render_claim_failed");
    await runRenderJob(id);
    const result = await service.from("video_requests").select("status,video_path,error_message").eq("id",id).single();
    if (result.error || result.data?.status !== "completed" || !result.data.video_path) throw new Error(result.data?.error_message || "completion_unverified");
    const artifact = await bucket.download(result.data.video_path);
    if (artifact.error || !artifact.data || artifact.data.size === 0) throw new Error("output_unavailable");
    report.status = "completed";
    report.video_path = result.data.video_path;
    report.bytes = artifact.data.size;
  } catch (error) {
    failed = true;
    report.status = "failed";
    report.error = error instanceof Error ? error.message : "unknown_error";
    // Private row/report retain detail. Public logs contain only a fixed outcome.
    await service.from("video_requests").update({status:"failed",error_message:String(report.error),progress_stage:null})
      .eq("id",id).in("status",["pending","processing"]);
  } finally { Object.assign(console, original); }
  report.finished_at = new Date().toISOString();
  const saved = await bucket.upload(`${source.user_id}/${id}/normal-validation-report.json`,
    Buffer.from(JSON.stringify(report,null,2)),{contentType:"application/json",upsert:false});
  if (saved.error) throw new Error("private_report_save_failed");
  if (failed) throw new Error("normal_video_failed_details_private");
}
main().then(()=>console.log("NORMAL_VIDEO_COMPLETED_PRIVATE_OUTPUT_VERIFIED"))
  .catch(()=>{console.error("NORMAL_VIDEO_STOPPED_NO_RETRY_DETAILS_PRIVATE");process.exitCode=1;});
