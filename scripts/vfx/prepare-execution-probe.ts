/** Prepare an isolated orchestration probe, never a cinematic-quality claim. */
import { createHash } from "node:crypto";
import { createServiceClient } from "../../src/lib/supabase/service";
import { directorActor } from "../../src/lib/production-intelligence/vfx-director/access";
import { createJob, ownedJob } from "../../src/lib/production-intelligence/vfx-director/jobs";
import { supabaseJobStore } from "../../src/lib/production-intelligence/vfx-director/store";
import { supabaseResultStore } from "../../src/lib/paid-calls/result-store";
import { executionProfile, stagedArtifactPath } from "../../src/lib/production-intelligence/vfx-director/execution-profiles";
async function main() {
 const sb=createServiceClient(), store=supabaseJobStore(sb), results=supabaseResultStore(sb);
 const existing=await store.get("precampaign-three-worlds-v1-preparation");
 if(!existing) throw Error("SOURCE_JOB_MISSING");
 const u=await sb.auth.admin.getUserById(existing.ownerId);
 if(u.error) throw Error("OWNER_LOOKUP_FAILED");
 const actor=directorActor(u.data.user);
 const base=await ownedJob(store,existing.id,actor);
 const id="vfx-execution-smoke-v1", profile=executionProfile(id);
 if(!profile) throw Error("TEST_PROFILE_MISSING");
 if(await store.get(id)) { await ownedJob(store,id,actor); console.log("TEST_ALREADY_PREPARED; NO_RESET"); return; }
 const bytes=Buffer.from(JSON.stringify({version:"vfx-orchestration-probe/1",providerCalls:0,render:false,cinematicQualityClaim:false}));
 const sha256=createHash("sha256").update(bytes).digest("hex");
 const path=id+"/execution/probe.json";
 await results.putBytes(path,bytes,"application/json");
 const task={id:"verify-private-artifact",stage:"preview" as const,executor:"artifact-registry",dependsOn:[],
  inputAssetIds:["diagnostic-input"],outputAssetId:"diagnostic-proof",instruction:"Verify stored diagnostic bytes without rendering or generating assets.",
  acceptance:["Measured fingerprint matches the staged private diagnostic."]};
 const inventory={"artifact-registry":{available:true,paid:false,preservesOriginalPixels:true,recipeVersion:"artifact-registry/approved-styleframes-1"}};
 const brief={...base.brief,projectId:id,intent:"Prueba de ejecución — coste cero",emotion:"Diagnóstico técnico",budgetUsd:0,environments:[]};
 const plan={...base.plan,environments:[],tasks:[task],requiredChecks:["stored-artifact-fingerprint"]};
 await results.putJson(stagedArtifactPath(id,task.id),{jobId:id,taskId:task.id,assetId:task.outputAssetId,assetPath:path,sha256,bytes:bytes.length,
  evidence:"Isolated orchestration probe; verifies persisted bytes only. No render, provider call, approval or campaign mutation."});
 const job=await createJob(store,actor,actor,brief,plan,inventory,["diagnostic-input"]);
 const after=await ownedJob(store,base.id,actor);
 if(after.revision!==base.revision||JSON.stringify(after.approvals)!==JSON.stringify(base.approvals)) throw Error("CAMPAIGN_CHANGED");
 console.log(JSON.stringify({testJob:job.id,pendingTasks:1,providerCalls:0,render:false,campaignUnchanged:true}));
}
main().catch(()=>{console.error("VFX_TEST_PREPARATION_BLOCKED");process.exitCode=1;});
