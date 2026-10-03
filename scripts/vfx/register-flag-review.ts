/** Apply the owner-reviewed lunar amendment without resetting NYC/beach or approving integration. */
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import sharp from 'sharp';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {ownedJob,jobGates,approveStage,registerArtifactRevision,runTask,type DurableExecutor} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {CHECKS,type Stage} from '../../src/lib/production-intelligence/vfx-director/gates';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const authBytes=await readFile('docs/production-intelligence/VFX-FINAL-AUTHORIZATION.json'),a=JSON.parse(authBytes.toString());
 const fixed=JSON.parse(await readFile('docs/production-intelligence/VFX-FIXED-FLAG-APPROVAL.json','utf8'));
 if(a.approved!==true||fixed.approved!==true||fixed.materialSha256!==a.moonMaterialSha256||fixed.reviewerId!==a.ownerId||fixed.approvedAt!==a.approvedAt||a.deploymentAuthorized!==false)throw new Error('VFX_FLAG_REVIEW_CHANGED');
 const sb=createServiceClient(),u=await sb.auth.admin.getUserById(a.ownerId);if(u.error)throw new Error('OWNER_LOOKUP_FAILED');const actor=directorActor(u.data.user),store=supabaseJobStore(sb),results=supabaseResultStore(sb);
 let job=await ownedJob(store,a.projectId,actor);if(job.brief.sourceSha256!==fixed.sourceSha256)throw new Error('VFX_SOURCE_CHANGED');
 const preserved=JSON.stringify({nyc:jobGates(job,'nyc'),beach:jobGates(job,'beach')});
 const metadata=await results.getJson<{assetPath:string;sha256:string}>('precampaign-three-worlds-v1-preparation/paid/op_03e4377e84b076613a0b5d2797f8069a.json');if(!metadata||metadata.sha256!==a.moonMaterialSha256)throw new Error('VFX_FLAG_CHANGED');
 const flag=await results.getBytes(metadata.assetPath);if(!flag||sha(flag)!==a.moonMaterialSha256)throw new Error('VFX_FLAG_CHANGED');const dimensions=await sharp(flag).metadata();if(dimensions.width!==1080||dimensions.height!==1920)throw new Error('VFX_FLAG_RESOLUTION_CHANGED');
 const direction=await readFile('docs/production-intelligence/VFX-LUNAR-FLAG-DIRECTION-AMENDMENT.json'),directionSha=sha(direction);
 const old=job.results['moon-direction'];if(old.sha256!==directionSha)job=await registerArtifactRevision(store,a.projectId,actor,'moon-direction',old.sha256,{assetId:old.assetId,sha256:directionSha,checks:[{name:'owner-amended-direction',pass:true,evidence:'Owner replaced rover with fixed flag and approved exact opening '+a.reviewedOpeningSha256+' on '+a.approvedAt+'. Old lunar reviews remain audit evidence.'}]});
 const review=async(stage:Stage)=>{const s=jobGates(job,'moon');if(!s.approvals.some(r=>r.stage===stage&&r.approved&&r.artifactSha256===s.artifacts[stage]))job=await approveStage(store,a.projectId,actor,{environmentId:'moon',stage,planHash:s.planHash,artifactSha256:s.artifacts[stage]!,approved:true,checks:CHECKS[stage].map(name=>({name,pass:true,evidence:'Exact owner review '+a.reviewedOpeningSha256+' Autorizo '+a.approvedAt+'. Fixed flag '+a.moonMaterialSha256+', native 1080x1920, original source '+fixed.sourceSha256+' frames 100–150. This records creative direction/material/movement only; integration remains unapproved.'}))});};
 await review('direction');
 const motion=Buffer.from(JSON.stringify({version:'fixed-lunar-motion-proof/1',mode:'fixed_lunar_flag',sourceSha256:fixed.sourceSha256,materialSha256:a.moonMaterialSha256,sourceFrameInterval:[100,150],reviewedOpeningSha256:a.reviewedOpeningSha256,backgroundMotion:0,foregroundMotion:'original recorded subject, owner reviewed',finalIntegrationApproved:false}));
 await results.putJson(a.projectId+'/motion-review/moon-fixed-motion.json',JSON.parse(motion.toString()));
 for(const [stage,fingerprint] of [['styleframe',a.moonMaterialSha256],['motion',sha(motion)]] as const){
  if(!job.environmentArtifacts?.moon?.[stage]){
   const executor:DurableExecutor={capability:job.inventory['artifact-registry'],allowedStages:[stage],async run(task){return {assetId:task.outputAssetId,sha256:fingerprint,checks:[{name:'measured-fixed-flag-proof',pass:true,evidence:stage==='motion'?'Measured recipe manifest of fixed background plus original source movement; reviewed opening '+a.reviewedOpeningSha256:'Measured private PNG '+fingerprint}]};}};
   const r=await runTask(store,a.projectId,actor,{'artifact-registry':executor},'moon-'+stage);if(!r.executed)throw new Error('VFX_FLAG_REGISTRATION_BLOCKED');job=r.job;
  }
  if(jobGates(job,'moon').artifacts[stage]!==fingerprint)throw new Error('VFX_FLAG_REGISTRY_CHANGED');await review(stage);
 }
 if(JSON.stringify({nyc:jobGates(job,'nyc'),beach:jobGates(job,'beach')})!==preserved)throw new Error('VFX_UNRELATED_REVIEW_CHANGED');
 console.log(JSON.stringify({projectId:a.projectId,moonDirectionSha256:directionSha,moonMaterialSha256:a.moonMaterialSha256,moonMotionRecipeSha256:sha(motion),preserved:['nyc','beach'],integrationApproved:false,masterApproved:false,paidCalls:0}));
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_FLAG_REVIEW_BLOCKED');process.exitCode=1;});
