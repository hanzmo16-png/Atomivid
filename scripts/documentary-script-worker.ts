import { randomUUID } from "node:crypto";
import { SCRIPT_JOB_PATH, scriptJobSignature } from "../src/lib/video/long-form/script-job-auth";
async function main() {
const probe=process.env.SCRIPT_PROBE_ONLY==="true";
const id=probe?randomUUID():process.env.SCRIPT_JOB_ID;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if(!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !key || key.length<32) throw new Error("Worker configuration unavailable");
// Fixed first-party origin: never send a signed request to an event-supplied URL.
const url=`https://atomivid.vercel.app${SCRIPT_JOB_PATH}`;
for(let step=0;step<40;step++) {
 const timestamp=String(Date.now());
 const response=await fetch(url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(320_000),headers:{
  "x-script-job":id,"x-script-time":timestamp,"x-script-signature":scriptJobSignature(key,id,timestamp),...(probe?{"x-script-probe":"1"}:{})}});
 if(!response.ok) {
  // Only the no-generation probe may wait for the new deployment to become live.
  if(probe && step<9) {await new Promise(r=>setTimeout(r,15000));continue;}
  throw new Error(`Worker HTTP ${response.status}; stopped without retry`);
 }
 const result=await response.json() as {state:string};
 console.log(`Preparation stage ${step+1}: ${result.state}`);
 if(["completed","probe_ok"].includes(result.state)) break;
 if(result.state==="running") break; // Another fenced invocation owns it; NEVER steal.
 if(!["queued","waiting"].includes(result.state)) throw new Error(`Preparation stopped: ${result.state}`);
 if(step===39) throw new Error("Preparation remains queued; bounded worker finished");
 if(result.state==="waiting") await new Promise(r=>setTimeout(r,15000));
}

}
main().catch(error => { console.error(error instanceof Error ? error.message : "Worker interrupted"); process.exitCode=1; });
