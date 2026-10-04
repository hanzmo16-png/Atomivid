/** Read the completed pilot and persist measurements privately; never export media in job logs. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceClient } from "../src/lib/supabase/service";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { readOwnerPilot,assertOwnerPilot } from "../src/lib/billing/owner-pilot";
const exec = promisify(execFile);
async function main() {
  const service=createServiceClient(),ledger=supabaseLedgerStore(service);
  const preparation=await ledger.get("owner_pilot_preparation_current");
  if(preparation?.status!=="COMMITTED"||preparation.method!=="human_direction")throw new Error("PILOT_AUDIT_SCOPE");
  const requestId=JSON.parse(preparation.resultRef!).requestId;
  const grant=await readOwnerPilot(service,requestId);
  const request=await service.from("video_requests").select("id,user_id,status,mode,duration_seconds,script_json,render_attempts,video_path").eq("id",requestId).single();
  if(!grant||request.error||request.data?.status!=="completed"||request.data.video_path!==requestId+"/attempt-1/final.mp4")throw new Error("PILOT_AUDIT_NOT_COMPLETED");
  const user=await service.auth.admin.getUserById(grant.ownerId);
  if(user.error||!user.data.user)throw new Error("PILOT_AUDIT_OWNER");
  assertOwnerPilot(grant,request.data,user.data.user,"worker");
  const media=await service.storage.from("videos").download(request.data.video_path);
  if(media.error||!media.data)throw new Error("PILOT_AUDIT_MEDIA_MISSING");
  const bytes=Buffer.from(await media.data.arrayBuffer()),root=await mkdtemp(join(tmpdir(),"pilot-audit-"));
  try {
    const file=join(root,"pilot.mp4");await writeFile(file,bytes,{mode:0o600});
    const probe=JSON.parse((await exec("ffprobe",["-v","error","-count_frames","-show_streams","-show_format","-of","json",file])).stdout);
    const video=probe.streams.find((s:{codec_type:string})=>s.codec_type==="video");
    const audio=probe.streams.find((s:{codec_type:string})=>s.codec_type==="audio");
    const {stderr}=await exec("ffmpeg",["-hide_banner","-i",file,"-af","loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json","-f","null","-"],{maxBuffer:4*1024*1024});
    const loudness=JSON.parse(stderr.slice(stderr.lastIndexOf("{"),stderr.lastIndexOf("}")+1));
    const ops=await service.from("pi_paid_operations").select("provider,method,status,committed_usd").eq("project_id",requestId).neq("provider","internal").neq("method","capacity_hold");
    if(ops.error)throw new Error("PILOT_AUDIT_LEDGER");
    const calls=ops.data??[];
    const checks={vertical1080:video?.width===1080&&video?.height===1920,fps30:video?.avg_frame_rate==="30/1",
      durationNear30:Math.abs(Number(probe.format.duration)-30)<=2.5,
      h264:video?.codec_name==="h264",aacStereo:audio?.codec_name==="aac"&&audio?.channels===2,
      synchronized:Math.abs(Number(video?.duration)-Number(audio?.duration))<0.1,
      audible:Math.abs(Number(loudness.input_i)+16)<=1.5,truePeakSafe:Number(loudness.input_tp)<=-1,
      oneRender:request.data.render_attempts===1,twoVoiceCallsMaximum:calls.length>0&&calls.length<=2,
      exactProviders:calls.every(c=>c.provider==="elevenlabs"&&c.method==="tts_with_timestamps"),
      cashBudget:calls.every(c=>c.status==="COMMITTED"&&Number(c.committed_usd)===0)};
    const report={checkedAt:new Date().toISOString(),sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,
      durationSeconds:Number(probe.format.duration),video:{width:video.width,height:video.height,fps:video.avg_frame_rate,frames:video.nb_read_frames},
      audio:{sampleRate:audio.sample_rate,channels:audio.channels,loudness:Number(loudness.input_i),truePeak:Number(loudness.input_tp)},
      checks,passed:Object.values(checks).every(Boolean),visualReview:"pending",ownerApproval:false};
    await ledger.insert({idempotencyKey:"owner_pilot_delivery_audit:"+requestId,projectId:requestId,shotId:"delivery",provider:"internal",
      model:"ffprobe-loudnorm/1",method:"technical_review",attemptKind:"audit",reservedUsd:0,committedUsd:0,status:"COMMITTED",
      providerJobId:null,resultRef:JSON.stringify(report),updatedAt:report.checkedAt});
    if(!report.passed)throw new Error("PILOT_AUDIT_CHECK_FAILED");
    console.log("PILOT_DELIVERY_TECHNICAL_CHECKS_PASSED_VISUAL_REVIEW_PENDING");
  }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(()=>{console.error("PILOT_DELIVERY_AUDIT_BLOCKED_PRIVATE_REPORT_RETAINED");process.exitCode=1;});
