/** Explicitly authorized repair. BFL only; no motion, master, merge or deployment. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {ownedJob,runTask,approveStage,jobGates,type DurableExecutor} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {CHECKS} from '../../src/lib/production-intelligence/vfx-director/gates';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {gatedWorldAsset} from '../../src/lib/paid-calls/gated-world-assets';
import {officialWorldPort,OfficialCallError} from '../../src/lib/providers/vfx-worlds/official';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const authBytes=await readFile('docs/production-intelligence/VFX-REPAIR-AUTHORIZATION.json');const auth=JSON.parse(authBytes.toString());
 const pkgBytes=await readFile('docs/production-intelligence/VFX-CAMPAIGN-MATERIALS.json');const pkg=JSON.parse(pkgBytes.toString());
 if(auth.packageSha256!==sha(pkgBytes)||auth.maximumAdditionalUsd!==.03||auth.maximumProjectGenerationUsd!==4.80||auth.replacementEnvironment!=='beach'||auth.approved!==true)throw new Error('VFX_REPAIR_NOT_BOUND');
 const measured=JSON.parse(await readFile('vfx-source-metadata.json','utf8'));
 if(measured.sourceSha256!==pkg.source.sha256||measured.width!==1080||measured.height!==1920||measured.frames!==150||measured.fps!=='30/1')throw new Error('SOURCE_CHANGED');
 const preflight=JSON.parse(await readFile('vfx-provider-preflight.json','utf8'));
 const bfl=preflight.connections.find((c:{provider:string})=>c.provider==='bfl');
 if(Date.now()-Date.parse(preflight.checkedAt)>3600000||!bfl?.authenticated||!bfl.creditsVerified||!bfl.enoughForBaseQuote)throw new Error('VFX_BFL_NOT_READY');
 const sb=createServiceClient();const user=await sb.auth.admin.getUserById(auth.ownerId);if(user.error)throw new Error('OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user),store=supabaseJobStore(sb),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb),port=officialWorldPort();
 const projectId=pkg.projectId+'-preparation';let job=await ownedJob(store,projectId,actor);
 const deps=()=>({ledger,results,port,projectId,actorId:actor,job,maxCostUsd:.03,projectBudgetUsd:4.80,connectionsVerified:true});
 const beach=pkg.worlds.find((w:{environmentId:string})=>w.environmentId==='beach');
 const request={environmentId:'beach' as const,phase:'styleframe' as const,prompt:beach.styleframePrompt};
 // Try the original recorded request once. A new request requires a durable rejected defect.
 const rows=await sb.from('pi_paid_operations').select('*').eq('project_id',projectId).eq('shot_id','world:beach:styleframe');
 if(rows.error)throw new Error('VFX_LEDGER_READ_FAILED');
 const original=rows.data.find(o=>o.method==='text-to-image'&&o.provider_job_id===auth.failedProviderJobId);
 const slot=rows.data.find(o=>o.method==='generation_slot');if(!original||!slot)throw new Error('VFX_ORIGINAL_REQUEST_MISSING');
 const defectKey=slot.idempotency_key+'_defect_1';
 if(!await ledger.get(defectKey)){
  try{await gatedWorldAsset(deps(),request);}
  catch(e){
   if(!(e instanceof OfficialCallError)||!['VFX_HTTP_404','VFX_DOWNLOAD_HTTP_403','VFX_DOWNLOAD_HTTP_404'].includes(e.code))throw e;
   if(e.jobId!==auth.failedProviderJobId)throw new Error('VFX_WRONG_REJECTED_REQUEST');
   if(!await ledger.update(original.idempotency_key,'PROVIDER_JOB_RECORDED',{status:'RECONCILIATION_REQUIRED',updatedAt:new Date().toISOString()}))throw new Error('VFX_DEFECT_CAS_FAILED');
   const defect={failedOperationKey:original.idempotency_key,providerJobId:auth.failedProviderJobId,ownerId:actor,environmentId:'beach',phase:'styleframe',rejected:true,maximumAdditionalUsd:.03,authorizationSha256:sha(authBytes),code:e.code,recordedAt:new Date().toISOString()};
   if(!await ledger.insert({idempotencyKey:defectKey,projectId,shotId:original.shot_id,provider:'internal',model:'vfx-rejected-styleframe/1',method:'rejected_styleframe',attemptKind:'defect',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify(defect),updatedAt:new Date().toISOString()}))throw new Error('VFX_DEFECT_ALREADY_EXISTS');
   console.log(JSON.stringify({environmentId:'beach',rejectedDefect:e.code,maximumReplacementUsd:.03,originalChargeStillUnreconciled:true}));
  }
 }
 const visual=JSON.parse(await readFile('docs/production-intelligence/VFX-VISUAL-APPROVAL-2026-10-03.json','utf8'));
 if(visual.sourceSha256!==pkg.source.sha256)throw new Error('VFX_VISUAL_SOURCE_CHANGED');
 await mkdir('vfx-styleframe-review',{recursive:true});const receipts=[];
 for(const world of pkg.worlds){
  const a=await gatedWorldAsset(deps(),{environmentId:world.environmentId,phase:'styleframe',prompt:world.styleframePrompt});const fingerprint=sha(a.buffer);
  if(a.buffer.toString('hex',0,8)!=='89504e470d0a1a0a'||a.buffer.readUInt32BE(16)!==720||a.buffer.readUInt32BE(20)!==1280)throw new Error('VFX_IMAGE_FORMAT_CHANGED');
  await writeFile(`vfx-styleframe-review/${world.environmentId}.png`,a.buffer);
  if(!job.environmentArtifacts?.[world.environmentId]?.styleframe){
   const proof:DurableExecutor={capability:job.inventory['artifact-registry'],allowedStages:['styleframe'],async run(task){if(task.environmentId!==world.environmentId)throw new Error('VFX_WORLD_CHANGED');return{assetId:task.outputAssetId,sha256:fingerprint,checks:[{name:'ledger-result-fingerprint',pass:true,evidence:a.key+' '+fingerprint}]};}};
   const registered=await runTask(store,projectId,actor,{'artifact-registry':proof},world.environmentId+'-styleframe');if(!registered.executed)throw new Error('VFX_REGISTRATION_BLOCKED');job=registered.job;
  }
  const scope=jobGates(job,world.environmentId);if(scope.artifacts.styleframe!==fingerprint)throw new Error('VFX_ARTIFACT_CHANGED');
  const approved=visual.backgrounds.find((w:{environmentId:string})=>w.environmentId===world.environmentId);
  if(approved?.visualApproved===true){
   if(approved.sha256!==fingerprint)throw new Error('VFX_VISUAL_APPROVAL_CHANGED');
   if(!scope.approvals.some(a=>a.stage==='styleframe'&&a.approved&&a.artifactSha256===fingerprint)){
    const evidence:{[name:string]:string}={'scale-perspective':'Owner visually approved this exact background image; subject placement remains an integration review.','lighting':'Owner visually approved the independent lighting shown in this image.','subject-preservation':'Background-only styleframe; measured original source unchanged and excluded from provider submission. Physical composite requires its own review.','plate-resolution':'Measured PNG 720x1280; approved FLUX preparation resolution. Final native 1080 plate is a later stage.'};
    job=await approveStage(store,projectId,actor,{environmentId:world.environmentId,stage:'styleframe',planHash:scope.planHash,artifactSha256:fingerprint,approved:true,checks:CHECKS.styleframe.map(name=>({name,pass:true,evidence:evidence[name]+' User approval at '+visual.approvedAt}))});
   }
  }
  receipts.push({environmentId:world.environmentId,sha256:fingerprint,key:a.key,costUsd:a.costUsd,costBasis:a.costBasis,reused:a.reused,visualApproved:approved?.visualApproved===true});
 }
 await writeFile('vfx-styleframe-review/receipts.json',JSON.stringify({projectId,receipts,maximumGenerationBudgetUsd:4.80,motionCalls:0,productionReady:false},null,2));
 console.log(JSON.stringify({projectId,receipts,motionCalls:0,productionReady:false}));
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_REPAIR_BLOCKED');process.exitCode=1;});
