import { createServiceClient } from "@/lib/supabase/service";
import { validScriptJobSignature } from "@/lib/video/long-form/script-job-auth";
import { runScriptJobStep } from "@/lib/video/long-form/script-jobs";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request) {
 const jobId=request.headers.get("x-script-job")??"";
 if(!validScriptJobSignature(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),jobId,request.headers.get("x-script-time"),request.headers.get("x-script-signature")))
  return Response.json({error:"Unauthorized"},{status:401});
 // Probe verifies transport/auth only. It cannot claim a job or contact a provider.
 if(request.headers.get("x-script-probe")==="1") {
  const {error}=await createServiceClient().from("documentary_script_jobs").select("id").limit(0);
  if(error || !process.env.ANTHROPIC_API_KEY) return Response.json({state:"probe_unavailable"},{status:503});
  return Response.json({state:"probe_ok"});
 }
 try {return Response.json(await runScriptJobStep(jobId));}
 catch {return Response.json({state:"interrupted"},{status:503});}
}
