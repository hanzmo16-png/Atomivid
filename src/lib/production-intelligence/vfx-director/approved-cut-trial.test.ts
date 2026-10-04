import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryResultStore } from '@/lib/paid-calls/result-store';
import { approvedCutTrialExecutor, assertTrialSource, type ApprovedCutTrial } from './approved-cut-trial';
import { CHECKS, STAGES } from './gates';
import { environmentHash, type Job } from './jobs';
const exec=promisify(execFile),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const fixture=()=>{
 const environments=['nyc','beach','moon'].map((id,i)=>({id,kind:['city','beach','moon'][i],lighting:['night_practical','daylight_soft','sun_hard'][i],startFrame:i*2,endFrame:(i+1)*2,materialAssetId:id+'-plate',materialSha256:'a'.repeat(64),light:id,continuityIn:'source',continuityOut:'cut'}));
 const tasks=environments.flatMap(e=>STAGES.slice(0,4).map(stage=>({id:`${e.id}-${stage}`,stage,environmentId:e.id,executor:'registry',dependsOn:[],inputAssetIds:[e.materialAssetId],outputAssetId:`${e.id}-${stage}-out`,instruction:'reviewed',acceptance:['review']})));
 const source={id:'precampaign-three-worlds-v1-preparation',ownerId:'owner',revision:53,status:'REVIEW_REQUIRED',brief:{projectId:'precampaign-three-worlds-v1-preparation',frames:6,fps:30,width:16,height:16,sourceSha256:'a'.repeat(64),environments},plan:{environments,tasks},assets:[],inventory:{},approvals:[],artifacts:{},environmentArtifacts:Object.fromEntries(environments.map(e=>[e.id,Object.fromEntries(STAGES.slice(0,4).map(s=>[s,'b'.repeat(64)]))])),results:{}} as unknown as Job;
 source.approvals=environments.flatMap(e=>STAGES.slice(0,4).map(stage=>({environmentId:e.id,stage,planHash:environmentHash(source,e.id),artifactSha256:'b'.repeat(64),reviewerId:'owner',approved:true,checks:CHECKS[stage].map(name=>({name,pass:true,evidence:'human-reviewed'}))})));
 const trial={...structuredClone(source),id:'trial',revision:0,planHash:'c'.repeat(64),brief:{...source.brief,projectId:'trial'},approvals:[],results:{}};
 return {source,trial};
};
const config:ApprovedCutTrial={kind:'approved-cut-trial',sourceJobId:'precampaign-three-worlds-v1-preparation',sourceRevision:53,nativeSha256:'d'.repeat(64),grainStrength:1};
test('trial requires exact owner/version and all source-world reviews; a beach rejection blocks it',()=>{
 const {source,trial}=fixture();assert.doesNotThrow(()=>assertTrialSource(source,trial,config));
 for(const change of [{revision:54},{ownerId:'other'},{status:'BLOCKED' as const}])assert.throws(()=>assertTrialSource({...source,...change},trial,config));
 const beach=source.approvals.find(a=>a.environmentId==='beach'&&a.stage==='integration')!;
 source.approvals.push({...beach,approved:false});assert.throws(()=>assertTrialSource(source,trial,config));
});
test('real FFmpeg cut/grain render persists privately and recovers with a fresh local directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'vfx-cut-test-'));
 try{
 const {source,trial}=fixture(),store=memoryResultStore();
 const native=join(root,'native.mp4');
 await exec('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=16x16:rate=30','-frames:v','6','-c:v','libx264','-pix_fmt','yuv420p',native]);
 const bytes=await readFile(native),spec={...config,nativeSha256:hash(bytes)};
 const path=source.id+'/review/'+spec.nativeSha256+'.mp4';await store.putBytes(path,bytes,'video/mp4');
 const bindings=[];
 for(const [i,e] of source.plan.environments.entries()){
 const pixels=join(root,`pixels${i}`);
 await exec('ffmpeg',['-v','error','-i',native,'-vf',`trim=start_frame=${e.startFrame}:end_frame=${e.endFrame},setpts=PTS-STARTPTS`,'-an','-f','rawvideo','-pix_fmt','rgb24',pixels]);
 const fingerprint=hash(await readFile(pixels));source.environmentArtifacts![e.id].integration=fingerprint;
 const a=source.approvals.find(a=>a.environmentId===e.id&&a.stage==='integration')!;a.artifactSha256=fingerprint;
 bindings.push({ownerId:source.ownerId,environmentId:e.id,stage:'integration',planHash:environmentHash(source,e.id),artifactSha256:fingerprint,assetPath:path,sha256:spec.nativeSha256,startFrame:e.startFrame,endFrame:e.endFrame});
 }
 await store.putJson(source.id+'/review/bindings.json',bindings);
 const deps={results:store,currentJob:async()=>trial,sourceJob:async()=>source,root:join(root,'first')};
 const task={id:'assemble',stage:'master' as const,executor:'cut',dependsOn:[],inputAssetIds:['source'],outputAssetId:'trial-master',instruction:'cut',acceptance:['measured']};
 const ex=approvedCutTrialExecutor(spec,deps),result=await ex.run(task,trial.brief,'stable-key');
 assert.equal(result.assetId,'trial-master');assert.equal(result.checks[0].pass,true);
 const receipt=JSON.parse(result.checks[0].evidence);assert.equal(receipt.grainPasses,1);assert.equal(receipt.transition,'cut');assert.equal(receipt.frames,6);
 const fresh=approvedCutTrialExecutor(spec,{...deps,root:join(root,'fresh')});assert.deepEqual(await fresh.recover(task,trial.brief,'stable-key'),result);
 const outputPath='trial/execution/rendered/'+hash(Buffer.from('stable-key'))+'.mp4';store.objects.set(outputPath,Buffer.from('changed'));
 await assert.rejects(fresh.recover(task,trial.brief,'stable-key'),/STORED_OUTPUT_CHANGED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
