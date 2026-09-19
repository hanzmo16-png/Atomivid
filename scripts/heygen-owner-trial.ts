/** One owner-authorized migration trial. No secrets/media/balances on stdout. */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { preparationId, digest } from "../src/lib/video/avatar/preparation";
import { measureNarrationSeconds } from "../src/lib/video/avatar/measure-narration";
import { recordingFormat, RECORDING_BUCKET } from "../src/lib/video/avatar/recording";
import { validatePhotoBuffer } from "../src/lib/video/avatar/photo-validation";
import { getHeygenWallet } from "../src/lib/providers/avatar/heygen";
import { runRenderJob } from "../src/lib/video/run-job";

const SOURCE_HASH = "24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function trialId(sourceId: string) {
  const h = hash(`heygen-owner-trial-v1:${sourceId}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
async function main() {
  const mode = process.env.TRIAL_ACTION;
  if (mode !== "prepare" && mode !== "generate") throw new Error("invalid_action");
  if (Date.now() > Date.parse("2026-09-20T02:00:00Z")) throw new Error("authorization_window_expired");
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const bucket = service.storage.from(RECORDING_BUCKET);
  for (const name of [RECORDING_BUCKET, "videos"]) {
    const b = await service.storage.getBucket(name);
    if (b.error || !b.data || b.data.public) throw new Error("private_storage_required");
  }
  const sourceRows = await service.from("video_requests").select("id,user_id,mode,status,avatar_id,recorded_audio_path,avatar_provider_video_job_id").eq("mode", "avatar");
  if (sourceRows.error) throw new Error("source_read_failed");
  const source = sourceRows.data?.find(r => hash(r.id) === SOURCE_HASH);
  if (!source || source.status !== "failed" || source.avatar_provider_video_job_id) throw new Error("source_not_eligible");
  const av = await service.from("avatars").select("user_id,consent_given,source_photo_path").eq("id", source.avatar_id).single();
  const prefix = `${source.user_id}/${source.id}/`;
  if (av.error || av.data.user_id !== source.user_id || !av.data.consent_given || !["photo.jpeg","photo.png"].some(n=>av.data.source_photo_path === prefix+n) || !["recording.m4a","recording.mp3","recording.wav"].some(n=>source.recorded_audio_path === prefix+n)) throw new Error("ownership_failed");
  const photoDownload = await bucket.download(av.data.source_photo_path);
  const audioDownload = await bucket.download(source.recorded_audio_path);
  if (photoDownload.error || audioDownload.error || !photoDownload.data || !audioDownload.data) throw new Error("private_assets_unavailable");
  const photo = Buffer.from(await photoDownload.data.arrayBuffer());
  const audio = Buffer.from(await audioDownload.data.arrayBuffer());
  // The original deterministic preparation ID binds owner + both exact files.
  if (preparationId(source.user_id, photo, audio) !== source.id) throw new Error("original_integrity_failed");
  const mime = av.data.source_photo_path.endsWith(".png") ? "image/png" : "image/jpeg";
  if (!validatePhotoBuffer(photo,mime).valid) throw new Error("photo_invalid");
  const format = recordingFormat(audio);
  const seconds = await measureNarrationSeconds(audio);
  if (seconds > 45) throw new Error("recording_too_long");
  const id = trialId(source.id); const dest = `${source.user_id}/${id}/`;
  const reportPath = dest + "heygen-trial-report.json";
  const report: Record<string, unknown> = { action: mode, original_seconds: seconds, photo_sha256: digest(photo), audio_sha256: digest(audio), updated_at: new Date().toISOString() };
  async function save() {
    const r = await bucket.upload(reportPath,Buffer.from(JSON.stringify(report,null,2)),{contentType:"application/json",upsert:true});
    if(r.error)throw new Error("private_report_save_failed");
  }
  if (mode === "prepare") {
    for (const [name,bytes,type] of [[av.data.source_photo_path.slice(prefix.length),photo,mime],[`recording.${format.extension}`,audio,format.mimeType]] as const) {
      await bucket.upload(dest+name,bytes,{contentType:type,upsert:false});
      const r=await bucket.download(dest+name);
      if(r.error || !r.data || digest(Buffer.from(await r.data.arrayBuffer()))!==digest(bytes))throw new Error("copy_integrity_failed");
    }
    const a=await service.from("avatars").upsert({id,user_id:source.user_id,name:"Avatar privado HeyGen",provider:"heygen",status:"uploaded",source_photo_path:dest+av.data.source_photo_path.slice(prefix.length),consent_given:true,consent_given_at:new Date().toISOString(),consent_policy_version:"owner-heygen-trial-v1"},{onConflict:"id",ignoreDuplicates:true});
    if(a.error)throw new Error("avatar_prepare_failed");
    const r=await service.from("video_requests").upsert({id,user_id:source.user_id,topic:"Avatar con grabación original — HeyGen",style:"Personal",duration_seconds:Math.ceil(seconds),language:"es",mode:"avatar",avatar_id:id,recorded_audio_path:dest+`recording.${format.extension}`,status:"script_ready",idempotency_key:`heygen-owner-trial:${id}`,script_json:{title:"Avatar con grabación original",segments:[]}},{onConflict:"id",ignoreDuplicates:true});
    if(r.error)throw new Error("request_prepare_failed");
    report.status="prepared_without_generation";await save();return;
  }
  const {data: row,error} = await service.from("video_requests").select("status,user_id,avatar_id,recorded_audio_path,render_attempts,avatar_generation_started_at,avatar_provider_video_job_id").eq("id",id).single();
  if(error || !row || row.user_id!==source.user_id || row.avatar_id!==id || row.recorded_audio_path!==dest+`recording.${format.extension}` || row.status!=="script_ready" || row.render_attempts!==0 || row.avatar_generation_started_at || row.avatar_provider_video_job_id)throw new Error("trial_not_eligible");
  // Recheck exact stored copies immediately before the durable claim.
  for (const [name,expected] of [[av.data.source_photo_path.slice(prefix.length),photo],[`recording.${format.extension}`,audio]] as const) {
    const copy=await bucket.download(dest+name);
    if(copy.error || !copy.data || digest(Buffer.from(await copy.data.arrayBuffer()))!==digest(expected))throw new Error("prepared_integrity_failed");
  }
  const before=await getHeygenWallet();
  if(before<2)throw new Error("insufficient_budget");
  report.balance_before=before;
  const lock=await bucket.upload(dest+"heygen-owner-trial.lock",Buffer.from(new Date().toISOString()),{upsert:false,contentType:"text/plain"});
  if(lock.error)throw new Error("trial_already_reserved");
  await save();
  const claim=await service.from("video_requests").update({status:"processing",render_attempts:1,render_started_at:new Date().toISOString(),render_worker:"heygen-owner-trial",progress_stage:"queued"}).eq("id",id).eq("user_id",source.user_id).eq("status","script_ready").eq("render_attempts",0).is("avatar_generation_started_at",null).is("avatar_provider_video_job_id",null).select("id").maybeSingle();
  if(claim.error || !claim.data)throw new Error("trial_claim_failed");
  process.env.AVATAR_MODE_ENABLED="true";
  process.env.AVATAR_PROVIDER="heygen";
  process.env.MAX_AVATAR_DURATION_SECONDS="45";
  process.env.MAX_AVATAR_COST_USD="2";
  const log=console.log,warn=console.warn;
  try {
    console.log=()=>{}; console.warn=()=>{};
    await runRenderJob(id);
    report.status="completed";
  } catch(e) { report.status="failed";report.error=e instanceof Error?e.message:"unknown_error"; }
  finally {console.log=log;console.warn=warn;}
  try { const after=await getHeygenWallet();report.balance_after=after;report.consumed_usd=Number((before-after).toFixed(6)); }
  catch { report.balance_after=null; }
  await save();
  if(report.status!=="completed")throw new Error("generation_failed_details_private");
}
main().then(()=>console.log("OWNER_TRIAL_STEP_FINISHED_REPORT_PRIVATE")).catch(()=>{console.error("OWNER_TRIAL_STOPPED_NO_RETRY_DETAILS_PRIVATE");process.exitCode=1;});
