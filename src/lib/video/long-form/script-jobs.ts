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
import { generateDocumentaryScript } from "./documentary-script";
import { researchDocumentary, RESEARCH_VERSION } from "./research";
import { EDITORIAL_VERSION, type EditorialReport } from "./editorial";
import { documentaryFormError } from "./form-error";
import { ScriptJobFieldsSchema, type ScriptJobFields, type ScriptJobInput } from "./script-job-types";
import { parseOpenQuestions, parseSources } from "@/app/dashboard/long-form/new/parse";

export async function enqueueScriptJob(session: SupabaseClient, user: {id:string; email_confirmed_at?:string}, rawFields: ScriptJobFields) {
 const fields=ScriptJobFieldsSchema.parse(rawFields), service=createServiceClient();
 const inputHash=stableHash({fields,version:"durable-documentary-v1"},32);
 const {data:existing,error:readError}=await service.from("documentary_script_jobs").select("id,status").eq("user_id",user.id).eq("input_hash",inputHash).maybeSingle();
 if(readError) throw new Error("No se pudo comprobar la solicitud guardada.");
 if(existing) return existing as {id:string;status:string};
 const creativeHistory=await loadCreativeHistory(session,user.id);
 const input:ScriptJobInput={fields,creativeHistory,recoverLegacyOperator:isInternalProductionOwner(user)};
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
  const {data:job,error}=await service.from("documentary_script_jobs").select("user_id,input").eq("id",id).single();
  if(error || !job?.input) throw new Error("Script job input unavailable");
  const {data:owner,error:ownerError}=await service.auth.admin.getUserById(job.user_id);
  if(ownerError || !canAccessLongFormBeta(owner?.user)) throw new Error("Script job access unavailable");
  const input=job.input as ScriptJobInput, fields=ScriptJobFieldsSchema.parse(input.fields);
  let editorial:EditorialReport|undefined;
  const script=await withDocumentaryStep(()=>withDocumentarySupplyContext(job.user_id,
   {...fields,editorialVersion:EDITORIAL_VERSION,researchVersion:RESEARCH_VERSION,creativeHistory:input.creativeHistory},
   input.recoverLegacyOperator && isInternalProductionOwner(owner.user),async()=>{
    await update({stage:"Investigando fuentes"});
    const researchPack=await researchDocumentary({topic:fields.topic,references:parseSources(fields.sources),openQuestions:parseOpenQuestions(fields.openQuestions)});
    const beats=await generateDocumentaryScript({researchPack,creativeHistory:input.creativeHistory,mode:"curiosity_documentary",language:fields.language,
     targetDurationSeconds:Number(fields.durationMinutes)*60,onStage:stage=>update({stage}),onEditorialApproved:r=>{editorial=r;}});
    if(!editorial) throw new Error("Editorial approval missing");
    return {topic:fields.topic,beats:beats.map((b,i)=>({id:`beat-${i+1}`,...b})),editorial,sources:researchPack.sources};
   }));
  const {error:finishError}=await service.rpc("finish_documentary_script_job",{p_id:id,p_token:token,p_script:script});
  if(finishError) throw new Error("Could not persist approved script");
  return {state:"completed"};
 } catch(error) {
  if(error instanceof DocumentaryStepYield) {await update({status:"queued",run_token:null});return {state:"queued"};}
  if(error instanceof SupplyUnavailableError) {
   await update({status:"queued",run_token:null,stage:"Esperando disponibilidad",error_message:error.customerMessage});
   return {state:"waiting"};
  }
  const code=randomUUID().slice(0,8);
  console.error(`[atomivid:script-job:${code}]`,error);
  await update({status:"failed",run_token:null,error_message:documentaryFormError(error,code)});
  return {state:"failed"};
 }
}
