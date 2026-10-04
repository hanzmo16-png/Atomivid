/** Isolated review render from exact, already-reviewed integration pixels. No new world render. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PaidResultStore } from '@/lib/paid-calls/result-store';
import { stableHash } from '../canonical';
import { assertBeforeTask } from './gates';
import { jobGates, type Job, type TaskResult } from './jobs';
import { currentReviewBinding } from './review-bindings';
import { cutMasterExecutor } from './sequence-compositor';
const exec = promisify(execFile);
const hash = (b:Buffer) => createHash('sha256').update(b).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ApprovedCutTrialSchema = z.object({ kind:z.literal('approved-cut-trial'), sourceJobId:z.literal('precampaign-three-worlds-v1-preparation'),
 sourceRevision:z.literal(53), nativeSha256:sha, grainStrength:z.literal(1) }).strict();
export type ApprovedCutTrial = z.infer<typeof ApprovedCutTrialSchema>;
const ResultSchema=z.object({assetId:z.string(),sha256:sha,checks:z.array(z.object({name:z.string(),pass:z.literal(true),evidence:z.string().min(1)})).min(1)}).strict();
export function assertTrialSource(source:Job, trial:Job, config:ApprovedCutTrial) {
 if(source.id!==config.sourceJobId||source.ownerId!==trial.ownerId||source.revision!==config.sourceRevision||source.status==='RUNNING'||source.status==='BLOCKED'||source.status==='FAILED') throw Error('VFX_TRIAL_SOURCE_CHANGED');
 if(source.plan.environments.length!==3) throw Error('VFX_TRIAL_WORLD_COUNT');
 assertBeforeTask('master',jobGates(source));
}
export function approvedCutTrialExecutor(config:ApprovedCutTrial,deps:{results:PaidResultStore;currentJob:()=>Promise<Job>;sourceJob:()=>Promise<Job>;root:string}) {
 const c=ApprovedCutTrialSchema.parse(config);
 const capability={available:true,paid:false,preservesOriginalPixels:false,recipeVersion:`approved-cut-trial/1:${stableHash(c,64)}`};
 async function preflight() {
  const trial=await deps.currentJob(), source=await deps.sourceJob(); assertTrialSource(source,trial,c);
  const raw=await deps.results.getJson<unknown[]>(`${source.id}/review/bindings.json`);
  const bindings=source.plan.environments.map(env=>(Array.isArray(raw)?raw:[]).map(v=>currentReviewBinding(v,source)).find(b=>b?.stage==='integration'&&b.environmentId===env.id&&b.sha256===c.nativeSha256));
  if(bindings.some(b=>!b)||new Set(bindings.map(b=>b!.assetPath)).size!==1) throw Error('VFX_TRIAL_BINDING_CHANGED');
  const bytes=await deps.results.getBytes(bindings[0]!.assetPath);
  if(!bytes||hash(bytes)!==c.nativeSha256)throw Error('VFX_TRIAL_MEDIA_CHANGED');
  return {trial,source,bindings,bytes};
 }
 async function publishReview(result:TaskResult,bytes:Buffer) {
  const trial=await deps.currentJob();
  const reviewPath=`${trial.id}/review/${result.sha256}.mp4`;
  await deps.results.putBytes(reviewPath,bytes,'video/mp4');
  const stored=await deps.results.getBytes(reviewPath);
  if(!stored||hash(stored)!==result.sha256)throw Error('VFX_TRIAL_REVIEW_NOT_PERSISTED');
  await deps.results.putJson(`${trial.id}/review/bindings.json`,[{ownerId:trial.ownerId,stage:'preview',planHash:trial.planHash,artifactSha256:result.sha256,assetPath:reviewPath,sha256:result.sha256,startFrame:0,endFrame:trial.brief.frames}]);
 }
 async function recovered(task:Job['plan']['tasks'][number],key:string):Promise<TaskResult|null> {
  const path=`${(await deps.currentJob()).id}/execution/rendered/${hash(Buffer.from(key))}`;
  const raw=await deps.results.getJson<{key:string;result:TaskResult}>(`${path}.json`);
  if(!raw)return null;
  const result=ResultSchema.parse(raw.result), bytes=await deps.results.getBytes(`${path}.mp4`);
  if(raw.key!==key||result.assetId!==task.outputAssetId||!bytes||hash(bytes)!==result.sha256)throw Error('VFX_TRIAL_STORED_OUTPUT_CHANGED');
  await publishReview(result,bytes);
  return result;
 }
 return {capability,allowedStages:['preview'] as Job['plan']['tasks'][number]['stage'][],
  async preflight(){await preflight();},
  async run(task:Job['plan']['tasks'][number],brief:Job['brief'],key:string) {
   if(task.stage!=='preview'||brief.projectId!==(await deps.currentJob()).id)throw Error('VFX_TRIAL_TASK_MISMATCH');
   const input=await preflight();
   if(brief.frames!==input.source.brief.frames||brief.fps!==input.source.brief.fps||brief.width!==input.source.brief.width||brief.height!==input.source.brief.height||brief.sourceSha256!==input.source.brief.sourceSha256)throw Error('VFX_TRIAL_FORMAT_CHANGED');
   const old=await recovered(task,key);if(old)return old;
   const dir=join(deps.root,hash(Buffer.from(key)));await mkdir(dir,{recursive:true});
   const native=join(dir,'native.mp4');await writeFile(native,input.bytes);
   const segments=[];
   for(const [i,env] of input.source.plan.environments.entries()) {
    const filter=`trim=start_frame=${env.startFrame}:end_frame=${env.endFrame},setpts=PTS-STARTPTS`;
    // Decode exact interval before any re-encoding. Match the owner-reviewed RGB24 fingerprint.
    const pixels=join(dir,`pixels-${i}.rgb`);
    await exec('ffmpeg',['-v','error','-y','-i',native,'-vf',filter,'-an','-f','rawvideo','-pix_fmt','rgb24',pixels],{timeout:120000});
    if(hash(await readFile(pixels))!==input.bindings[i]!.artifactSha256)throw Error('VFX_TRIAL_REVIEWED_PIXELS_CHANGED');
    const path=join(dir,`segment-${i}.mkv`);
    await exec('ffmpeg',['-v','error','-y','-i',native,'-vf',filter,'-an','-c:v','ffv1',path],{timeout:120000});
    const integration=input.source.plan.tasks.find(t=>t.stage==='integration'&&t.environmentId===env.id)!;
    segments.push({path,sha256:hash(await readFile(path)),assetId:integration.outputAssetId,environmentId:env.id,startFrame:env.startFrame,endFrame:env.endFrame});
   }
   const root=join(dir,'assembled');
   const master=cutMasterExecutor({kind:'cut-master',root,segments,grainStrength:c.grainStrength});
   const innerTask={...task,stage:"master" as const,inputAssetIds:segments.map(s=>s.assetId)};
   const assembled=await master.run(innerTask,input.source.brief,key);
   const result={...assembled,checks:[...assembled.checks,{name:"approved-source-pixels",pass:true,evidence:JSON.stringify({sourceJobId:input.source.id,revision:input.source.revision,nativeSha256:c.nativeSha256,intervals:input.bindings.map(b=>({environmentId:b!.environmentId,startFrame:b!.startFrame,endFrame:b!.endFrame,pixelSha256:b!.artifactSha256}))})}]};
   // Recheck approvals immediately before publishing the measured output.
   await preflight();
   const output=await readFile(join(root,hash(Buffer.from(key)),'master.mp4'));
   if(hash(output)!==result.sha256)throw Error('VFX_TRIAL_OUTPUT_CHANGED');
   const path=`${brief.projectId}/execution/rendered/${hash(Buffer.from(key))}`;
   await deps.results.putBytes(`${path}.mp4`,output,'video/mp4');
   const stored=await deps.results.getBytes(`${path}.mp4`);
   if(!stored||hash(stored)!==result.sha256)throw Error('VFX_TRIAL_OUTPUT_NOT_PERSISTED');
   await deps.results.putJson(`${path}.json`,{key,result});
   await publishReview(result,stored);
   return result;
  },
  async recover(task:Job['plan']['tasks'][number],_brief:Job['brief'],key:string){await preflight();return recovered(task,key);}
 };
}
