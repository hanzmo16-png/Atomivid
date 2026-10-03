/** Explicit owner-approved first-image batch only. Cannot invoke LTX or render a master. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../../src/lib/supabase/service';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {createJob,runTask,approveStage,jobGates,type DurableExecutor} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {DIRECTOR_VERSION,type Plan} from '../../src/lib/production-intelligence/vfx-director';
import {parseShotContract} from '../../src/lib/production-intelligence/contract';
import {CHECKS} from '../../src/lib/production-intelligence/vfx-director/gates';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {gatedWorldAsset} from '../../src/lib/paid-calls/gated-world-assets';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {officialWorldPort} from '../../src/lib/providers/vfx-worlds/official';
import {type ConnectionEvidence} from '../../src/lib/production-intelligence/vfx-director/production-preflight';
const OWNER='d2064950-7a95-4208-8dfb-d93b470d141d';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
type World={environmentId:'nyc'|'beach'|'moon';kind:'city'|'beach'|'moon';lighting:'night_practical'|'daylight_soft'|'sun_hard';sourceStartFrame:number;sourceEndFrame:number;directionSha256:string;styleframePrompt:string;motionPrompt:string};
async function main(){
 if(process.env.VFX_STYLEFRAMES_AUTHORIZED!=='1')throw new Error('NOT_AUTHORIZED');
 const raw=await readFile('docs/production-intelligence/VFX-CAMPAIGN-MATERIALS.json');
 const authorization=JSON.parse(await readFile('docs/production-intelligence/VFX-DIRECTION-APPROVAL.json','utf8'));
 if(authorization.packageSha256!==hash(raw)||authorization.ownerId!==OWNER||authorization.maximumBatchUsd!==0.09||authorization.stage!=='direction'||authorization.approved!==true)throw new Error('DIRECTION_NOT_BOUND');
 const pkg=JSON.parse(raw.toString());const worlds=pkg.worlds as World[];
 if(worlds.map(w=>w.environmentId).join(',')!=='nyc,beach,moon'||pkg.source.frames!==150||pkg.source.fps!==30)throw new Error('CAMPAIGN_CHANGED');
 const measurement=JSON.parse(await readFile('vfx-source-metadata.json','utf8'));
 if(measurement.sourceSha256!==pkg.source.sha256||measurement.frames!==150||measurement.width!==1080||measurement.height!==1920||measurement.fps!=='30/1')throw new Error('SOURCE_CHANGED');
 const evidence=JSON.parse(await readFile('vfx-provider-preflight.json','utf8'));
 if(Date.now()-Date.parse(evidence.checkedAt)>60*60_000)throw new Error('PREFLIGHT_EXPIRED');
 const bfl=evidence.connections.find((e:ConnectionEvidence)=>e.provider==='bfl');
 if(!bfl?.dns||!bfl.https||!bfl.authenticated||!bfl.creditsVerified||!bfl.enoughForBaseQuote)throw new Error('BFL_CONNECTION_OR_BALANCE_NOT_VERIFIED');
 // This entrypoint submits only BFL images; LTX balance must be rechecked before motion.
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(OWNER);
 if(user.error)throw new Error('OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user),store=supabaseJobStore(sb),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb);
 const projectId=pkg.projectId+'-preparation';
 await mkdir('vfx-styleframe-review',{recursive:true});
 const committed=await sb.from('pi_paid_operations').select('shot_id,result_ref').eq('project_id',projectId).eq('status','COMMITTED').eq('method','text-to-image');
 if(committed.error)throw new Error('COMMITTED_ASSET_READ_FAILED');
 for(const row of committed.data??[]){
  const world=worlds.find(w=>row.shot_id===`world:${w.environmentId}:styleframe`);
  if(!world||!row.result_ref)continue;
  const meta=await results.getJson<{assetPath:string;sha256:string;bytes:number}>(row.result_ref);
  if(!meta)throw new Error('VFX_STORED_RESULT_MISSING');
  const bytes=await results.getBytes(meta.assetPath);
  if(!bytes||bytes.length!==meta.bytes||hash(bytes)!==meta.sha256)throw new Error('VFX_STORED_RESULT_CHANGED');
  await writeFile(`vfx-styleframe-review/${world.environmentId}.png`,bytes);
 }
 // One-time read-only reconciliation of the pre-receipt NYC operation. Only documented
 // official global/US/EU API hosts are queried; never POST or guess additional regions.
 for(const legacyWorld of worlds){
 const legacy=await sb.from('pi_paid_operations').select('idempotency_key,provider_job_id,result_ref,status').eq('project_id',projectId).eq('shot_id',`world:${legacyWorld.environmentId}:styleframe`).eq('status','PROVIDER_JOB_RECORDED').maybeSingle();
 if(legacy.error)throw new Error('LEGACY_RECEIPT_READ_FAILED');
 if(legacy.data&&!legacy.data.result_ref){
  const id=legacy.data.provider_job_id;
  if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,160}$/.test(id))throw new Error('LEGACY_ID_INVALID');
  let recovered=false;
  for(const host of ['api.us.bfl.ai','api.eu.bfl.ai']){
   const url:string=`https://${host}/v1/get_result?id=${encodeURIComponent(id)}`;
   try{
    // Credential-free GET may follow official regional routing; finish validates the final URL.
    const response:Response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(15_000)});
    if(!response.ok){console.log(JSON.stringify({reconciliationWorld:legacyWorld.environmentId,region:host,httpStatus:response.status}));continue;}
    const data:{id?:string;status?:string}=await response.json();
    console.log(JSON.stringify({reconciliationWorld:legacyWorld.environmentId,region:host,status:data.status??'missing',responseIncludesId:data.id!==undefined}));
    const returnedUrl=new URL(response.url);
    if(returnedUrl.protocol!=='https:'||!/^api(?:\.[a-z0-9-]+)?\.bfl\.ai$/.test(returnedUrl.hostname)||returnedUrl.pathname!=='/v1/get_result'||returnedUrl.searchParams.get('id')!==id||(data.id!==undefined&&data.id!==id)||!['Ready','Pending'].includes(data.status??''))continue;
    if(!await ledger.update(legacy.data.idempotency_key,'PROVIDER_JOB_RECORDED',{resultRef:'provider-receipt:'+JSON.stringify({id,pollingUrl:response.url}),updatedAt:new Date().toISOString()}))throw new Error('LEGACY_RECEIPT_CONCURRENT_UPDATE');
    recovered=true;break;
   }catch(e){if(e instanceof Error&&e.message==='LEGACY_RECEIPT_CONCURRENT_UPDATE')throw e;}
  }
  if(!recovered)throw new Error('VFX_LEGACY_POLLING_RECEIPT_REQUIRED');
 }
 }
 const brief={projectId,intent:'Approved three-world background preparation; original Hans pixels preserved',emotion:'wonder',frames:150,fps:30,width:1080,height:1920,sourceSha256:pkg.source.sha256,subjectLock:'identity_with_relight',budgetUsd:4.77,environments:worlds.map(w=>({id:w.environmentId,kind:w.kind,lighting:w.lighting}))};
 const stages=['direction','styleframe','motion','integration'] as const;
 // This is an artifact registry plan, not the physical compositor plan. Its material is the
 // measured source. Integration/master are never executed by this preparation entrypoint.
 const plan:Plan={version:DIRECTOR_VERSION,sourceSha256:pkg.source.sha256,
 contract:parseShotContract({shotId:'opening',shotClass:'talking_head',narrationIntent:brief.intent,visualIntent:'Three independent backgrounds with hard cuts',motionRequirement:'simple',motionLeverage:'HIGH',riskClass:'HIGH',desiredDuration:5,maxGeneratedDuration:6,qualityTier:'hero'}),
 world:{scaleMeters:1.8,physics:'Original subject geometry unchanged; background-only preparation',light:'Independent approved world lighting',optics:'Source viewpoint; actual plate perspective requires visual review',continuityIn:'Original recorded person',continuityOut:'Original recorded person'},
 layersFrontToBack:['original-subject','world-plate'],beats:[{frame:0,action:'nyc'},{frame:50,action:'beach'},{frame:100,action:'moon'}],requiredChecks:['source-fingerprint','direction','styleframe-review'],
 environments:worlds.map(w=>({id:w.environmentId,kind:w.kind,lighting:w.lighting,startFrame:w.sourceStartFrame,endFrame:w.sourceEndFrame,materialAssetId:'measured-source',materialSha256:pkg.source.sha256,light:w.lighting,continuityIn:'Preserve source position and movement',continuityOut:'Hard cut; independent next-world lighting'})),
 tasks:[...stages.flatMap((stage,i)=>worlds.map(w=>({stage,environmentId:w.environmentId,id:`${w.environmentId}-${stage}`,executor:'artifact-registry',dependsOn:i?[`${w.environmentId}-${stages[i-1]}`]:[],inputAssetIds:['measured-source',...(i?[`${w.environmentId}-${stages[i-1]}-out`]:[])],outputAssetId:`${w.environmentId}-${stage}-out`,instruction:`Register measured ${stage} artifact for ${w.environmentId}; no implied visual approval`,acceptance:['Measured immutable artifact']}))),
 {stage:'master',id:'master',executor:'artifact-registry',dependsOn:worlds.map(w=>`${w.environmentId}-integration`),inputAssetIds:worlds.map(w=>`${w.environmentId}-integration-out`),outputAssetId:'master-out',instruction:'Register only a separately rendered and reviewed physical master',acceptance:['All world reviews']} ]};
 const capability={available:true,paid:false,preservesOriginalPixels:true,recipeVersion:'artifact-registry/approved-styleframes-1'};
 let job=await createJob(store,actor,actor,brief,plan,{'artifact-registry':capability},['measured-source']);
 const directions:DurableExecutor={capability,allowedStages:['direction'],async run(task){const w=worlds.find(w=>task.environmentId===w.environmentId);if(!w)throw new Error('WORLD_MISSING');return{assetId:task.outputAssetId,sha256:w.directionSha256,checks:[{name:'owner-approved-direction',pass:true,evidence:authorization.approvalMessage+'; package '+hash(raw)}]};}};
 for(const w of worlds){
  if(!job.environmentArtifacts?.[w.environmentId]?.direction){const r=await runTask(store,projectId,actor,{'artifact-registry':directions});if(!r.executed)throw new Error('DIRECTION_REGISTRATION_BLOCKED');job=r.job;}
  const scope=jobGates(job,w.environmentId);
  if(!scope.approvals.some(a=>a.stage==='direction'&&a.approved))job=await approveStage(store,projectId,actor,{environmentId:w.environmentId,stage:'direction',planHash:scope.planHash,artifactSha256:w.directionSha256,approved:true,checks:CHECKS.direction.map(name=>({name,pass:true,evidence:'Owner explicitly approved the concrete three-world direction, including lunar rover, in chat on 2026-10-03 at 12:49 Cancun; package '+hash(raw)}))});
 }
 await mkdir('vfx-styleframe-review',{recursive:true});const receipts=[];const blocked=[];
 for(const w of worlds){
  try{
  const a=await gatedWorldAsset({ledger,results,port:officialWorldPort(),projectId,actorId:actor,job,maxCostUsd:0.03,projectBudgetUsd:4.77,connectionsVerified:true},{environmentId:w.environmentId,phase:'styleframe',prompt:w.styleframePrompt});
  const sha=hash(a.buffer);await writeFile(`vfx-styleframe-review/${w.environmentId}.png`,a.buffer);
  if(!job.environmentArtifacts?.[w.environmentId]?.styleframe&&worlds.slice(0,worlds.indexOf(w)).every(previous=>job.environmentArtifacts?.[previous.environmentId]?.styleframe)){
   const proof:DurableExecutor={capability,allowedStages:['styleframe'],async run(task){if(task.environmentId!==w.environmentId)throw new Error('WORLD_ORDER_CHANGED');return {assetId:task.outputAssetId,sha256:sha,checks:[{name:'ledger-result-fingerprint',pass:true,evidence:a.key+' '+sha}]};}};
   const r=await runTask(store,projectId,actor,{'artifact-registry':proof});if(!r.executed)throw new Error('STYLEFRAME_REGISTRATION_BLOCKED');job=r.job;
  }else if(job.environmentArtifacts?.[w.environmentId]?.styleframe&&job.environmentArtifacts[w.environmentId].styleframe!==sha)throw new Error('STYLEFRAME_CHANGED');
  receipts.push({environmentId:w.environmentId,key:a.key,sha256:sha,costUsd:a.costUsd,costBasis:a.costBasis,reused:a.reused,review:'REQUIRED',registered:job.environmentArtifacts?.[w.environmentId]?.styleframe===sha});
  }catch(e){const code=e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_WORLD_PREPARATION_BLOCKED';blocked.push({environmentId:w.environmentId,code});console.log(JSON.stringify({environmentId:w.environmentId,blocked:code}));}
 }
 await writeFile('vfx-styleframe-review/receipts.json',JSON.stringify({projectId,receipts,blocked,productionReady:false,motionCalls:0},null,2));
 console.log(JSON.stringify({projectId,receipts,blocked,motionCalls:0,productionReady:false}));
 if(blocked.length)throw new Error('VFX_PARTIAL_MATERIALS_REVIEW_REQUIRED');
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_STYLEFRAME_BATCH_BLOCKED');process.exitCode=1;});
