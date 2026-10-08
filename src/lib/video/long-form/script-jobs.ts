import { cinematicV6Enabled } from "./cinematic-v6-access";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { withDocumentarySupplyContext } from "@/lib/supply/anthropic";
import { withDocumentaryStep, DocumentaryStepYield } from "@/lib/supply/documentary-step";
import { canAccessLongFormBeta } from "./private-access";
import { loadCreativeHistory } from "./creative-history";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { generateDocumentaryScript, LongFormScriptDurationError } from "./documentary-script";
import { FRAGMENT_CONTRACT } from "./narrative-fragments";
import { researchDocumentary, RESEARCH_VERSION } from "./research";
import { EDITORIAL_VERSION, EditorialQualityError, type EditorialReport } from "./editorial";
import { documentaryFormError } from "./form-error";
import { ScriptJobFieldsSchema, type ScriptJobFields, type ScriptJobInput } from "./script-job-types";
import { parseOpenQuestions, parseSources } from "@/app/dashboard/long-form/new/parse";

export async function enqueueScriptJob(session: SupabaseClient, user: {id:string; email_confirmed_at?:string}, rawFields: ScriptJobFields, service: SupabaseClient=createServiceClient()) {
 const fields=ScriptJobFieldsSchema.parse(rawFields);
 const inputHash=stableHash({fields,version:"durable-documentary-v1"},32);
 const {data:existing,error:readError}=await service.from("documentary_script_jobs").select("id,status").eq("user_id",user.id).eq("input_hash",inputHash).maybeSingle();
 if(readError) throw new Error("No se pudo comprobar la solicitud guardada.");
 if(existing) return existing as {id:string;status:string};
 const creativeHistory=await loadCreativeHistory(session,user.id);
 const input:ScriptJobInput={fields,creativeHistory,recoverLegacyOperator:isInternalProductionOwner(user),referenceContract:"catalog-v1",writerContract:FRAGMENT_CONTRACT};
 const {error}=await service.from("documentary_script_jobs").upsert({user_id:user.id,input_hash:inputHash,topic:fields.topic,input},
   {onConflict:"user_id,input_hash",ignoreDuplicates:true});
 if(error) throw new Error("No se pudo guardar la preparación. No se inició ninguna generación.");
 const {data,error:lookupError}=await service.from("documentary_script_jobs").select("id,status").eq("user_id",user.id).eq("input_hash",inputHash).single();
 if(lookupError || !data) throw new Error("No se pudo recuperar el trabajo guardado.");
 return data as {id:string;status:string};
}

/** A worker invocation replays cached stages but admits at most ONE new paid
 * request. A lost HTTP response cannot resubmit: SQL CAS and the ledger both fence it. */
export async function runScriptJobStep(id:string, service=createServiceClient()) {
 const token=randomUUID();
 const {data:claim,error:claimError}=await service.rpc("claim_documentary_script_job",{p_id:id,p_token:token});
 if(claimError) throw new Error("Could not claim script job");
 if(claim?.state!=="claimed") return {state:String(claim?.state??"missing")};
 const update=async (patch:Record<string,unknown>) => {
  const {data,error}=await service.from("documentary_script_jobs").update({...patch,updated_at:new Date().toISOString()})
   .eq("id",id).eq("status","running").eq("run_token",token).select("id");
  if(error || data?.length!==1) throw new Error("Script job ownership lost");
 };
 try {
  const {data:job,error}=await service.from("documentary_script_jobs").select("user_id,input,editorial_rounds,resubmit_allowance").eq("id",id).single();
  if(error || !job?.input) throw new Error("Script job input unavailable");
  const {data:owner,error:ownerError}=await service.auth.admin.getUserById(job.user_id);
  if(ownerError || !canAccessLongFormBeta(owner?.user)) throw new Error("Script job access unavailable");
  const input=job.input as ScriptJobInput, fields=ScriptJobFieldsSchema.parse(input.fields);
  let editorial:EditorialReport|undefined;
  if(input.referenceContract!==undefined && input.referenceContract!=="catalog-v1")throw new Error("Unsupported saved reference contract");
  if(input.writerContract!==undefined && input.writerContract!==FRAGMENT_CONTRACT)throw new Error("Unsupported saved writer contract");
  const script=await withDocumentaryStep(()=>withDocumentarySupplyContext(job.user_id,
   {...fields,editorialVersion:EDITORIAL_VERSION,researchVersion:RESEARCH_VERSION,creativeHistory:input.creativeHistory,...(input.referenceContract?{referenceContract:input.referenceContract}:{})},
   input.recoverLegacyOperator && isInternalProductionOwner(owner.user),async()=>{
    await update({stage:"Investigando fuentes"});
    const researchPack=await researchDocumentary({topic:fields.topic,references:parseSources(fields.sources),openQuestions:parseOpenQuestions(fields.openQuestions)});
    const beats=await generateDocumentaryScript({researchPack,creativeHistory:input.creativeHistory,referenceContract:input.referenceContract,writerContract:input.writerContract,extraEditorialRounds:job.editorial_rounds??0,mode:"curiosity_documentary",language:fields.language,
     targetDurationSeconds:Number(fields.durationMinutes)*60,cinematicV6:cinematicV6Enabled(owner.user),onStage:stage=>update({stage}),
     onDraft:draft=>update({editorial_checkpoint:draft}),onEditorialApproved:r=>{editorial=r;}});
    if(!editorial) throw new Error("Editorial approval missing");
    return {topic:fields.topic,beats:beats.map((b,i)=>({id:`beat-${i+1}`,...b})),editorial,sources:researchPack.sources};
   },job.resubmit_allowance??0));
  const {error:finishError}=await service.rpc("finish_documentary_script_job",{p_id:id,p_token:token,p_script:script});
  if(finishError) throw new Error("Could not persist approved script");
  return {state:"completed"};
 } catch(error) {
  if(error instanceof DocumentaryStepYield) {await update({status:"queued",run_token:null});return {state:"queued"};}
  if(error instanceof SupplyUnavailableError) {
   await update({status:"queued",run_token:null,stage:"Esperando disponibilidad",error_message:error.customerMessage});
   return {state:"waiting"};
  }
  const code=randomUUID().slice(0,8), kind=scriptFailureKind(error);
  console.error(`[atomivid:script-job:${code}:${kind}]`,error);
  await update({status:"failed",run_token:null,failure_kind:kind,error_code:code,error_message:documentaryFormError(error,code)});
  return {state:"failed"};
 }
}

/** An objection to a complete, valid draft is editorial; everything else
 * (format, truncation beyond continuation, references, persistence) is technical. */
export function scriptFailureKind(error:unknown):"editorial"|"technical" {
 return error instanceof EditorialQualityError || error instanceof LongFormScriptDurationError ? "editorial" : "technical";
}

/** Vercel stops an invocation at maxDuration (300 s). A job still "running"
 * long after that has no live worker: persist it as interrupted instead of
 * showing an endless "preparing" state. Fenced on the same stale timestamp. */
export const STALE_RUNNING_MS=10*60_000;
export async function reconcileStaleScriptJobs(userId:string,service:SupabaseClient=createServiceClient(),now=Date.now()) {
 const cutoff=new Date(now-STALE_RUNNING_MS).toISOString();
 await service.from("documentary_script_jobs").update({status:"failed",run_token:null,failure_kind:"interrupted",
  error_message:"La preparación se interrumpió sin confirmar su última etapa. Los avances pagados están guardados; puedes reanudarla.",updated_at:new Date(now).toISOString()})
  .eq("user_id",userId).eq("status","running").lt("updated_at",cutoff);
}

export const MAX_SCRIPT_RETRIES=3, MAX_EDITORIAL_ROUNDS=2, MAX_RESUBMITS=2;
type RetryRow={id:string;status:string;failure_kind:string|null;retry_count:number;editorial_rounds:number;resubmit_allowance:number;updated_at:string};
/** Owner action on a failed job. Compare-and-swap on the exact row version, so a
 * double click or two tabs requeue it once. Saved paid responses replay free;
 * only the stage that failed can reach the provider again. */
export async function retryScriptJob(userId:string,id:string,service:SupabaseClient=createServiceClient()):Promise<"queued"|"refused"> {
 const {data,error}=await service.from("documentary_script_jobs").select("id,status,failure_kind,retry_count,editorial_rounds,resubmit_allowance,updated_at").eq("id",id).eq("user_id",userId).maybeSingle();
 if(error||!data) return "refused";
 const job=data as RetryRow, patch=retryPatch(job);
 if(!patch) return "refused";
 const {data:updated,error:updateError}=await service.from("documentary_script_jobs").update({...patch,status:"queued",run_token:null,failure_kind:null,error_code:null,
  error_message:null,stage:"En cola",updated_at:new Date().toISOString()}).eq("id",id).eq("user_id",userId).eq("status","failed").eq("updated_at",job.updated_at).select("id");
 return !updateError && updated?.length===1 ? "queued" : "refused";
}
export function retryPatch(job:Pick<RetryRow,"status"|"failure_kind"|"retry_count"|"editorial_rounds"|"resubmit_allowance">):Record<string,number>|null {
 if(job.status!=="failed") return null;
 if(job.failure_kind==="editorial") return job.editorial_rounds<MAX_EDITORIAL_ROUNDS ? {editorial_rounds:job.editorial_rounds+1} : null;
 if(job.retry_count>=MAX_SCRIPT_RETRIES) return null;
 if(job.failure_kind==="interrupted") return job.resubmit_allowance<MAX_RESUBMITS ? {retry_count:job.retry_count+1,resubmit_allowance:job.resubmit_allowance+1} : null;
 return {retry_count:job.retry_count+1};
}
