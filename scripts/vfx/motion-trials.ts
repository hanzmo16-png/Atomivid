/** Owner-approved Fast trials only. Reuses paid receipts; never approves generated movement. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {ownedJob,runTask,approveStage,jobGates,type DurableExecutor} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {CHECKS} from '../../src/lib/production-intelligence/vfx-director/gates';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {gatedWorldAsset} from '../../src/lib/paid-calls/gated-world-assets';
import {officialWorldPort} from '../../src/lib/providers/vfx-worlds/official';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const auth=JSON.parse(await readFile('docs/production-intelligence/VFX-MOTION-TRIAL-AUTHORIZATION.json','utf8'));
 const pkgBytes=await readFile('docs/production-intelligence/VFX-CAMPAIGN-MATERIALS.json'),pkg=JSON.parse(pkgBytes.toString());
 const proofBytes=await readFile('docs/production-intelligence/VFX-MATERIAL-COMPOSITE-PROOF.json');
 if(auth.approved!==true||auth.packageSha256!==sha(pkgBytes)||auth.proofSha256!==sha(proofBytes)||auth.maximumTrialBatchUsd!==1.62||auth.maximumPerCallUsd!==.54||auth.maximumProjectGenerationUsd!==4.80||auth.model!=='ltx-2-5-fast'||auth.seconds!==6||auth.fps!==25||auth.audio!==false||auth.finalCallsAuthorized!==false||auth.deploymentAuthorized!==false)throw new Error('VFX_TRIAL_AUTHORIZATION_CHANGED');
 const preflight=JSON.parse(await readFile('vfx-provider-preflight.json','utf8'));
 if(Date.now()-Date.parse(preflight.checkedAt)>3600000||!preflight.connections.find((c:{provider:string;authenticated:boolean})=>c.provider==='ltx')?.authenticated)throw new Error('VFX_LTX_NOT_AUTHENTICATED');
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(auth.ownerId);if(user.error)throw new Error('OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user),store=supabaseJobStore(sb),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb),port=officialWorldPort();
 const projectId=pkg.projectId+'-preparation';let job=await ownedJob(store,projectId,actor);
 const budget=await sb.from('pi_paid_operations').select('provider,reserved_usd,committed_usd,status').eq('project_id',projectId);
 if(budget.error)throw new Error('VFX_LEDGER_READ_FAILED');
 const held=budget.data.reduce((n,o)=>n+(o.status==='COMMITTED'?Number(o.committed_usd??o.reserved_usd):['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED'].includes(o.status)?Number(o.reserved_usd):0),0);
 const ltxHeld=budget.data.filter(o=>o.provider==='ltx').reduce((n,o)=>n+Number(o.committed_usd??o.reserved_usd),0);
 if(auth.ltxBalanceEvidence.source!=='owner-console-screenshot'||auth.ltxBalanceEvidence.apiBalanceVerified!==false||auth.ltxBalanceEvidence.balanceUsd-ltxHeld<1.62||held+1.62>4.80+1e-9)throw new Error('VFX_TRIAL_BUDGET_BLOCKED');
 await mkdir('vfx-motion-review',{recursive:true});const receipts=[];let failed=false;
 for(const world of pkg.worlds){
  try{
   const approved=auth.worlds.find((w:{environmentId:string})=>w.environmentId===world.environmentId);if(!approved)throw new Error('VFX_WORLD_NOT_APPROVED');
   // Only retrieve committed BFL results; this runner cannot submit any new still image.
   const stillPort={...port,async submit(){throw new Error('VFX_STILL_SUBMISSION_FORBIDDEN');},async finish(){throw new Error('VFX_STILL_RECOVERY_FORBIDDEN');}};
   const base={ledger,results,projectId,actorId:actor,job,projectBudgetUsd:4.80,connectionsVerified:true};
   const still=await gatedWorldAsset({...base,port:stillPort,maxCostUsd:.03},{environmentId:world.environmentId,phase:'styleframe',prompt:world.styleframePrompt});
   const fingerprint=sha(still.buffer),scope=jobGates(job,world.environmentId);
   if(fingerprint!==approved.plateSha256||scope.artifacts.styleframe!==fingerprint)throw new Error('VFX_APPROVED_PLATE_CHANGED');
   if(!scope.approvals.some(a=>a.stage==='styleframe'&&a.approved&&a.artifactSha256===fingerprint))job=await approveStage(store,projectId,actor,{environmentId:world.environmentId,stage:'styleframe',planHash:scope.planHash,artifactSha256:fingerprint,approved:true,checks:CHECKS.styleframe.map(name=>({name,pass:true,evidence:'Owner approval '+auth.approvedAt+' of exact background '+fingerprint+'; 720x1280 PNG preparation only, original person excluded. Physical integration remains a separate review.'}))});
   const a=await gatedWorldAsset({...base,job,port,maxCostUsd:.54},{environmentId:world.environmentId,phase:'motion',prompt:world.motionPrompt,reference:{bytes:still.buffer,sha256:fingerprint,mimeType:'image/png'}});
   const path=`vfx-motion-review/${world.environmentId}.mp4`;await writeFile(path,a.buffer);
   const info=JSON.parse(execFileSync(process.env.FFPROBE_BINARY??'ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',path],{encoding:'utf8'}));
   const v=info.streams.find((s:{codec_type:string})=>s.codec_type==='video');
   if(info.streams.some((s:{codec_type:string})=>s.codec_type==='audio')||!v||v.width!==720||v.height!==1280||v.avg_frame_rate!=='25/1'||Number(v.nb_read_frames)!==150||Math.abs(Number(info.format.duration)-6)>.05)throw new Error('VFX_MOTION_FORMAT_REJECTED');
   const motionSha=sha(a.buffer);
   if(!job.environmentArtifacts?.[world.environmentId]?.motion){
    const proof:DurableExecutor={capability:job.inventory['artifact-registry'],allowedStages:['motion'],async run(task){if(task.environmentId!==world.environmentId)throw new Error('VFX_WORLD_CHANGED');return {assetId:task.outputAssetId,sha256:motionSha,checks:[{name:'ledger-result-fingerprint',pass:true,evidence:a.key+' '+motionSha}]};}};
    const registered=await runTask(store,projectId,actor,{'artifact-registry':proof},world.environmentId+'-motion');if(!registered.executed)throw new Error('VFX_MOTION_REGISTRATION_BLOCKED');job=registered.job;
   }
   if(jobGates(job,world.environmentId).artifacts.motion!==motionSha)throw new Error('VFX_REGISTERED_MOTION_CHANGED');
   receipts.push({environmentId:world.environmentId,key:a.key,providerJobId:a.providerJobId,sha256:motionSha,costUsd:a.costUsd,costBasis:a.costBasis,reused:a.reused,motionApproved:false});
   console.log(JSON.stringify(receipts.at(-1)));
  }catch(e){failed=true;const code=e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_TRIAL_BLOCKED';receipts.push({environmentId:world.environmentId,error:code});console.error(JSON.stringify({environmentId:world.environmentId,error:code}));}
 }
 await writeFile('vfx-motion-review/receipts.json',JSON.stringify({projectId,receipts,maximumTrialBatchUsd:1.62,ltxBalanceEvidence:auth.ltxBalanceEvidence,finalCalls:0,deployment:false,productionReady:false},null,2));
 if(failed)process.exitCode=1;
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_TRIAL_BLOCKED');process.exitCode=1;});
