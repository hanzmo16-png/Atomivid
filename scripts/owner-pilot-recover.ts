/** Resume only the known capacity-hold accounting defect, within the same render and quote. */
import { createHash } from "node:crypto";
import { createServiceClient } from "../src/lib/supabase/service";
import { readOwnerPilot, assertOwnerPilot } from "../src/lib/billing/owner-pilot";
import { supabaseLedgerStore } from "../src/lib/paid-calls/supabase-ledger-store";
import { executePaidOperation } from "../src/lib/production-intelligence/ledger";
import { runRenderJob } from "../src/lib/video/run-job";
async function main() {
  const service = createServiceClient(), ledger = supabaseLedgerStore(service);
  const prepared = await ledger.get("owner_pilot_preparation_current");
  if (prepared?.status !== "COMMITTED" || prepared.method !== "human_direction") throw new Error("PILOT_RECOVERY_NOT_AUTHORIZED");
  const requestId = JSON.parse(prepared.resultRef!).requestId as string;
  const grant = await readOwnerPilot(service, requestId);
  if (!grant) throw new Error("PILOT_RECOVERY_NO_GRANT");
  const request = await service.from("video_requests").select("id,user_id,status,mode,duration_seconds,script_json,render_attempts,error_message,video_path").eq("id",requestId).single();
  const row = request.data;
  const user = await service.auth.admin.getUserById(grant.ownerId);
  if (request.error || user.error || !row || !user.data.user || row.status !== "failed" || row.video_path
    || !/^PILOT_BUDGET_BLOCKED \(Código: [a-f0-9]+\)$/.test(row.error_message ?? "")) throw new Error("PILOT_RECOVERY_WRONG_DEFECT");
  assertOwnerPilot(grant,row,user.data.user,"worker");
  const operations = await service.from("pi_paid_operations").select("provider,method,status,committed_usd,result_ref")
    .eq("project_id",requestId).neq("provider","internal").neq("method","capacity_hold");
  const calls = operations.data;
  if (operations.error || calls?.length !== 1 || calls[0].provider !== "elevenlabs" || calls[0].method !== "tts_with_timestamps"
    || calls[0].status !== "COMMITTED" || Number(calls[0].committed_usd) !== 0
    || !calls[0].result_ref?.startsWith(requestId+"/paid/") || !calls[0].result_ref.endsWith(".json")) throw new Error("PILOT_RECOVERY_CALL_STATE_BLOCKED");
  const metadataFile = await service.storage.from("videos").download(calls[0].result_ref);
  if (metadataFile.error || !metadataFile.data) throw new Error("PILOT_RECOVERY_AUDIO_MISSING");
  const metadata = JSON.parse(await metadataFile.data.text());
  if (!metadata.audioPath?.startsWith(requestId+"/paid/") || metadata.audioPath.includes("..")) throw new Error("PILOT_RECOVERY_AUDIO_SCOPE");
  const audio = await service.storage.from("videos").download(metadata.audioPath);
  if (audio.error || !audio.data) throw new Error("PILOT_RECOVERY_AUDIO_MISSING");
  const bytes = Buffer.from(await audio.data.arrayBuffer());
  if (bytes.length !== metadata.bytes || createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) throw new Error("PILOT_RECOVERY_AUDIO_CORRUPT");
  // The first voice is reused by its immutable paid-call key. Do not reset attempts,
  // alter the grant, refund a real call, or increase the remaining one-call budget.
  await executePaidOperation(ledger,{idempotencyKey:"owner_pilot_capacity_hold_repair:"+requestId,
    projectId:requestId,shotId:"accounting-defect",provider:"internal",model:"capacity-hold-count/1",
    method:"resume_verified_defect",attemptKind:"repair",reservedUsd:0},{
    async submit() {
      const resumed = await service.from("video_requests").update({status:"processing",progress_stage:"queued",error_message:null})
        .eq("id",requestId).eq("user_id",grant.ownerId).eq("status","failed")
        .eq("render_attempts",1).eq("error_message",row.error_message).is("video_path",null).select("id");
      if (resumed.error || resumed.data?.length !== 1) throw new Error("PILOT_RECOVERY_CONFLICT");
      return {providerJobId:requestId,submissionReceiptRef:JSON.stringify({defect:"capacity_hold_counted_as_call",renderAttempt:1,
        preservedVoiceSha256:metadata.sha256,remainingVoiceCalls:1,additionalUsd:0})};
    },
    async poll() {return {actualUsd:0,resultRef:JSON.stringify({resumedSameAttempt:true,remainingVoiceCalls:1,additionalUsd:0})};},
  },()=>new Date().toISOString());
  await runRenderJob(requestId,1);
}
const original = {log:console.log,warn:console.warn,error:console.error};
console.log=console.warn=console.error=()=>{};
main().then(()=>{Object.assign(console,original);console.log("PILOT_RECOVERY_WORKER_FINISHED_CHECK_PRIVATE_REQUEST");})
  .catch(()=>{Object.assign(console,original);console.error("PILOT_RECOVERY_BLOCKED_CHECK_PRIVATE_REQUEST");process.exitCode=1;});
