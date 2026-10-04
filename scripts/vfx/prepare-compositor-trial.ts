/** Prepare a real local cut/grain trial. Source approvals remain in the original job. */
import { createServiceClient } from "../../src/lib/supabase/service";
import { directorActor } from "../../src/lib/production-intelligence/vfx-director/access";
import { createJob, ownedJob } from "../../src/lib/production-intelligence/vfx-director/jobs";
import { supabaseJobStore } from "../../src/lib/production-intelligence/vfx-director/store";
import { supabaseResultStore } from "../../src/lib/paid-calls/result-store";
import { executionProfile, profileExecutors } from "../../src/lib/production-intelligence/vfx-director/execution-profiles";
async function main() {
 const sb=createServiceClient(), store=supabaseJobStore(sb), results=supabaseResultStore(sb);
 const existing=await store.get("precampaign-three-worlds-v1-preparation");
 if(!existing) throw Error("SOURCE_JOB_MISSING");
 const u=await sb.auth.admin.getUserById(existing.ownerId);
 if(u.error) throw Error("OWNER_LOOKUP_FAILED");
 const actor=directorActor(u.data.user);
 const base=await ownedJob(store,existing.id,actor);
 const id="vfx-compositor-trial-v1", profile=executionProfile(id);
 if(!profile) throw Error("TEST_PROFILE_MISSING");
 if(await store.get(id)) { await ownedJob(store,id,actor); console.log("TEST_ALREADY_PREPARED; NO_RESET"); return; }
 const executors=await profileExecutors(profile,{results,currentJob:async()=>base,sourceJob:async()=>base});
 const inventory=Object.fromEntries(Object.entries(executors).map(([name,e])=>[name,e.capability]));
 const executor=executors["approved-cuts"];
 await executor.preflight?.({id:"assemble-reviewed-cuts",stage:"master",executor:"approved-cuts",dependsOn:[],inputAssetIds:["approved-source"],outputAssetId:"trial-master",instruction:"Assemble approved intervals by hard cuts and add one global grain pass.",acceptance:["Exact approved source pixels and durable private output"]});
 const brief={...base.brief,projectId:id,intent:"Prueba real del compositor — cortes y grano final",emotion:"Revisión técnica y visual",budgetUsd:0,environments:[],subjectLock:"identity_with_relight" as const};
 const task={id:"assemble-reviewed-cuts",stage:"master" as const,executor:"approved-cuts",dependsOn:[],inputAssetIds:["approved-source"],outputAssetId:"trial-master",instruction:"Assemble approved intervals by hard cuts and add one global grain pass.",acceptance:["Exact approved source pixels and durable private output"]};
 const plan={...base.plan,environments:[],tasks:[task],requiredChecks:["cut-sequence"]};
 const job=await createJob(store,actor,actor,brief,plan,inventory,["approved-source"]);
 const after=await ownedJob(store,base.id,actor);
 if(after.revision!==base.revision||JSON.stringify(after.approvals)!==JSON.stringify(base.approvals)) throw Error("CAMPAIGN_CHANGED");
 console.log(JSON.stringify({testJob:job.id,pendingTasks:1,providerCalls:0,renderPending:true,campaignUnchanged:true}));
}
main().catch(()=>{console.error("VFX_COMPOSITOR_TRIAL_PREPARATION_BLOCKED");process.exitCode=1;});
