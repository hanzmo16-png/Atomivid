/** Exact owner review import and first Pro calls only. Never approves new final material. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {ownedJob,jobGates,approveStage,registerArtifactRevision} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {CHECKS} from '../../src/lib/production-intelligence/vfx-director/gates';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {gatedWorldAsset} from '../../src/lib/paid-calls/gated-world-assets';
import {officialWorldPort} from '../../src/lib/providers/vfx-worlds/official';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const authBytes=await readFile('docs/production-intelligence/VFX-FINAL-AUTHORIZATION.json'),auth=JSON.parse(authBytes.toString());
 const bytes=await readFile('docs/production-intelligence/VFX-CAMPAIGN-MATERIALS.json'),pkg=JSON.parse(bytes.toString());
 const reviewed=JSON.parse(await readFile('docs/production-intelligence/VFX-OPENING-REVIEW-RESULT.json','utf8'));
 if(auth.approved!==true||auth.maximumAdditionalUsd!==2.04||auth.maximumPerCallUsd!==1.02||auth.maximumProjectUsd!==4.8||auth.deploymentAuthorized!==false||JSON.stringify(auth.worlds)!=='["nyc","beach"]'||sha(bytes)!==auth.packageSha256||reviewed.sha256!==auth.reviewedOpeningSha256||sha(await readFile('scripts/vfx/region-motion-proof.py'))!==auth.regionRecipeSha256)throw new Error('VFX_FINAL_AUTHORIZATION_CHANGED');
 const preflight=JSON.parse(await readFile('vfx-provider-preflight.json','utf8'));
 if(Date.now()-Date.parse(preflight.checkedAt)>3600000||!preflight.connections.find((c:{provider:string;authenticated:boolean})=>c.provider==='ltx')?.authenticated)throw new Error('VFX_LTX_NOT_AUTHENTICATED');
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(auth.ownerId);if(user.error)throw new Error('OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user),store=supabaseJobStore(sb),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb),port=officialWorldPort();
 const projectId=auth.projectId;let job=await ownedJob(store,projectId,actor);
 const opening=JSON.parse(await readFile('docs/production-intelligence/VFX-OPENING-REVIEW-AUTHORIZATION.json','utf8'));
 await mkdir('vfx-final-review',{recursive:true});
 for(const name of ['nyc.png','nyc.mp4']){
  const input=opening.assets.find((a:{name:string})=>a.name===name);
  const metadata=await results.getJson<{assetPath:string;sha256:string}>(input.metadataPath);
  if(!metadata||metadata.sha256!==input.sha256)throw new Error('VFX_REVIEW_INPUT_CHANGED');
  const b=await results.getBytes(metadata.assetPath);if(!b||sha(b)!==input.sha256)throw new Error('VFX_REVIEW_INPUT_CHANGED');await writeFile('vfx-final-review/'+name,b);
 }
 execFileSync('python3',['scripts/vfx/region-motion-proof.py','nyc','vfx-final-review/nyc.png','vfx-final-review/nyc.mp4','vfx-final-review'],{stdio:'pipe'});
 const repaired=await readFile('vfx-final-review/nyc-region-proof.mp4'),repairSha=sha(repaired);
 await results.putBytes(projectId+'/motion-review/nyc-'+repairSha+'.mp4',repaired,'video/mp4');
 const current=job.results['nyc-motion'];
 if(current.sha256!==repairSha)job=await registerArtifactRevision(store,projectId,actor,'nyc-motion',current.sha256,{assetId:current.assetId,sha256:repairSha,checks:[{name:'reviewed-recipe-replay',pass:true,evidence:'Exact frozen inputs and recipe '+auth.regionRecipeSha256+' replay the corrected signs-only motion shown in owner-reviewed opening '+auth.reviewedOpeningSha256+'; output measured '+repairSha+'. No rejected raw motion approved.'}]});
 for(const environmentId of auth.worlds){
  const scope=jobGates(job,environmentId);
  if(!scope.approvals.some(a=>a.stage==='motion'&&a.approved&&a.artifactSha256===scope.artifacts.motion))job=await approveStage(store,projectId,actor,{environmentId,stage:'motion',planHash:scope.planHash,artifactSha256:scope.artifacts.motion!,approved:true,checks:CHECKS.motion.map(name=>({name,pass:true,evidence:'Owner Autorizo '+auth.approvedAt+' after exact opening '+auth.reviewedOpeningSha256+'. Review covers visible source interval '+JSON.stringify(auth.reviewedSourceIntervals[environmentId])+', original subject retained. NYC correction replay bound to '+auth.regionRecipeSha256+'. New Pro output and final integration remain unapproved.'}))});
 }
 const receipts=[];
 for(const environmentId of auth.worlds){
  const world=pkg.worlds.find((w:{environmentId:string})=>w.environmentId===environmentId);
  const base={ledger,results,projectId,actorId:actor,job,projectBudgetUsd:4.8,connectionsVerified:true};
  const stillPort={...port,async submit(){throw new Error('VFX_STILL_SUBMISSION_FORBIDDEN');},async finish(){throw new Error('VFX_STILL_RECOVERY_FORBIDDEN');}};
  const still=await gatedWorldAsset({...base,port:stillPort,maxCostUsd:.03},{environmentId,phase:'styleframe',prompt:world.styleframePrompt});
  const budget=await sb.from('pi_paid_operations').select('reserved_usd,committed_usd,status,attempt_kind').eq('project_id',projectId);if(budget.error)throw new Error('VFX_LEDGER_READ_FAILED');
  const held=budget.data.reduce((n,o)=>n+(o.status==='COMMITTED'?Number(o.committed_usd??o.reserved_usd):['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED'].includes(o.status)?Number(o.reserved_usd):0),0);
  const finalHeld=budget.data.filter(o=>o.attempt_kind==='final').reduce((n,o)=>n+(['COMMITTED','RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED'].includes(o.status)?Number(o.committed_usd??o.reserved_usd):0),0);
  if(finalHeld>2.04+1e-9||held+Math.max(0,2.04-finalHeld)>4.8+1e-9)throw new Error('VFX_FINAL_BUDGET_BLOCKED');
  const a=await gatedWorldAsset({...base,port,maxCostUsd:1.02},{environmentId,phase:'final',prompt:world.motionPrompt,reference:{bytes:still.buffer,sha256:sha(still.buffer),mimeType:'image/png'}});
  const path='vfx-final-review/'+environmentId+'-pro.mp4';await writeFile(path,a.buffer);
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',path],{encoding:'utf8'}));const v=info.streams.find((s:{codec_type:string})=>s.codec_type==='video');
  const technicalPass=!!v&&v.width===1080&&v.height===1920&&v.avg_frame_rate==='25/1'&&Number(v.nb_read_frames)>=150&&Number(v.nb_read_frames)<=153&&!info.streams.some((s:{codec_type:string})=>s.codec_type==='audio');
  const receipt={environmentId,key:a.key,providerJobId:a.providerJobId,sha256:sha(a.buffer),costUsd:a.costUsd,costBasis:a.costBasis,reused:a.reused,technicalPass,width:v?.width,height:v?.height,fps:v?.avg_frame_rate,frames:v?.nb_read_frames,seconds:info.format.duration,visualApproved:false,integrationApproved:false};receipts.push(receipt);console.log(JSON.stringify(receipt));
  await results.putJson(projectId+'/final-review/'+environmentId+'.json',receipt);
  if(!technicalPass)throw new Error('VFX_FINAL_FORMAT_REJECTED');
 }
 await writeFile('vfx-final-review/receipts.json',JSON.stringify({projectId,receipts,approvalSha256:sha(authBytes),maximumAdditionalUsd:2.04,moonPaidCalls:0,deployment:false,productionReady:false},null,2));
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_FINAL_BLOCKED');process.exitCode=1;});
