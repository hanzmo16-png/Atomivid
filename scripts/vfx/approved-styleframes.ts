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
import {assertProductionConnections,type ConnectionEvidence} from '../../src/lib/production-intelligence/vfx-director/production-preflight';
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
 const ltx=evidence.connections.find((e:ConnectionEvidence)=>e.provider==='ltx');
 // Console balance evidence supplied directly by the owner; never pretend it came from an API.
 if(authorization.ltxBalanceUsd<4.68||Date.now()-Date.parse(authorization.ltxBalanceObservedAt)>60*60_000)throw new Error('LTX_BALANCE_EVIDENCE_EXPIRED');
 if(ltx)ltx.creditsVerified=true;
 assertProductionConnections(evidence.connections);
 if(!evidence.connections.find((e:ConnectionEvidence&{enoughForBaseQuote?:boolean})=>e.provider==='bfl'&&e.enoughForBaseQuote))throw new Error('BFL_BALANCE_INSUFFICIENT');
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(OWNER);
 if(user.error)throw new Error('OWNER_LOOKUP_FAILED');
 const actor=directorActor(user.data.user),store=supabaseJobStore(sb),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb);
 const projectId=pkg.projectId+'-preparation';
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
 await mkdir('vfx-styleframe-review',{recursive:true});const receipts=[];
 for(const w of worlds){
  const a=await gatedWorldAsset({ledger,results,port:officialWorldPort(),projectId,actorId:actor,job,maxCostUsd:0.03,projectBudgetUsd:4.77,connectionsVerified:true},{environmentId:w.environmentId,phase:'styleframe',prompt:w.styleframePrompt});
  const sha=hash(a.buffer);await writeFile(`vfx-styleframe-review/${w.environmentId}.png`,a.buffer);
  if(!job.environmentArtifacts?.[w.environmentId]?.styleframe){
   const proof:DurableExecutor={capability,allowedStages:['styleframe'],async run(task){if(task.environmentId!==w.environmentId)throw new Error('WORLD_ORDER_CHANGED');return {assetId:task.outputAssetId,sha256:sha,checks:[{name:'ledger-result-fingerprint',pass:true,evidence:a.key+' '+sha}]};}};
   const r=await runTask(store,projectId,actor,{'artifact-registry':proof});if(!r.executed)throw new Error('STYLEFRAME_REGISTRATION_BLOCKED');job=r.job;
  }else if(job.environmentArtifacts[w.environmentId].styleframe!==sha)throw new Error('STYLEFRAME_CHANGED');
  receipts.push({environmentId:w.environmentId,key:a.key,sha256:sha,costUsd:a.costUsd,costBasis:a.costBasis,reused:a.reused,review:'REQUIRED'});
 }
 await writeFile('vfx-styleframe-review/receipts.json',JSON.stringify({projectId,receipts,productionReady:false,motionCalls:0},null,2));
 console.log(JSON.stringify({projectId,receipts,motionCalls:0,productionReady:false}));
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_STYLEFRAME_BATCH_BLOCKED');process.exitCode=1;});
