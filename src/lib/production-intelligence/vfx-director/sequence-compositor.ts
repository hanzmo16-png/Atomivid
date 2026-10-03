import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { stableHash } from '../canonical';
import type { Brief, Environment, Plan } from './index';
import type { DurableExecutor, Job } from './jobs';
const exec = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const File = z.object({ path: z.string().min(1), sha256: sha }).strict();
const PlateMotion = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('moving')}).strict(),
  z.object({mode:z.literal('fixed_lunar_flag'),authorization:File}).strict(),
]);
const FixedFlagApproval = z.object({approved:z.literal(true),stage:z.literal('fixed-background-direction'),
  projectId:z.string().min(1),environmentId:z.literal('moon'),materialSha256:sha,sourceSha256:sha,
  reviewerId:z.string().uuid(),approvedAt:z.string().datetime()}).strict();
export const WorldCompositeSchema = z.object({ kind: z.literal('world-composite'),
  source: File, plate: File, matte: File, room: File, look: File,
  environmentId: z.string().min(1), lighting: z.enum(['night_practical','daylight_soft','sun_hard']),
  worldKind: z.enum(['city','beach','moon']), root: z.string().min(1),
  plateStartFrame: z.number().int().nonnegative().default(0),
  plateMotion:PlateMotion.default({mode:'moving'}),
}).strict().refine(c => ({city:'night_practical',beach:'daylight_soft',moon:'sun_hard'}[c.worldKind] === c.lighting), 'VFX_WORLD_LIGHT_PAIR')
  .refine(c=>c.plateMotion.mode==='moving'||(c.worldKind==='moon'&&c.environmentId==='moon'),'VFX_FIXED_FLAG_LUNAR_ONLY');
export function assertFixedFlagApproval(config:z.infer<typeof WorldCompositeSchema>,brief:Brief,evidence:unknown){
  if(config.plateMotion.mode!=='fixed_lunar_flag')throw new Error('VFX_FIXED_FLAG_NOT_DECLARED');
  const a=FixedFlagApproval.parse(evidence);
  if(a.projectId!==brief.projectId||a.sourceSha256!==config.source.sha256||a.materialSha256!==config.plate.sha256)throw new Error('VFX_FIXED_FLAG_APPROVAL_CHANGED');
}
export const CutMasterSchema = z.object({ kind: z.literal('cut-master'), root: z.string().min(1),
  segments: z.array(File.extend({ assetId: z.string().min(1), environmentId: z.string().min(1),
    startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }).strict()).min(1),
  grainStrength: z.number().int().min(0).max(10).default(0),
}).strict();
type Task = Plan['tasks'][number];
const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
async function verify(file: z.infer<typeof File>) {
  if (await hash(file.path) !== file.sha256) throw new Error('VFX_INPUT_CHANGED');
}
async function probe(path: string) {
  const { stdout } = await exec('ffprobe', ['-v','error','-select_streams','v:0','-count_frames',
    '-show_entries','stream=width,height,r_frame_rate,nb_read_frames','-of','json',path]);
  const s = JSON.parse(stdout).streams[0];
  const [num, den] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, fps: num/den, frames: Number(s.nb_read_frames) };
}
function format(m: Awaited<ReturnType<typeof probe>>, b: Brief, frames?: number) {
  if (m.width !== b.width || m.height !== b.height || m.fps !== b.fps || !Number.isInteger(m.frames) || (frames !== undefined && m.frames !== frames)) throw new Error('VFX_MEDIA_FORMAT_OR_FRAMES');
}
const outputDir = (root: string, key: string) => resolve(root, createHash('sha256').update(key).digest('hex'));
export function assertWorld(config: z.infer<typeof WorldCompositeSchema>, task: Task, brief: Brief, env?: Environment) {
  if (task.stage !== 'integration' || !env || task.environmentId !== env.id || env.id !== config.environmentId || env.kind !== config.worldKind || env.lighting !== config.lighting) throw new Error('VFX_WORLD_OR_LIGHT_MISMATCH');
  if (brief.subjectLock !== 'identity_with_relight' || brief.sourceSha256 !== config.source.sha256 || env.materialSha256 !== config.plate.sha256 || env.startFrame < 0 || env.endFrame > brief.frames || env.endFrame-env.startFrame < 2) throw new Error('VFX_SOURCE_MATERIAL_OR_INTERVAL');
  if (!task.inputAssetIds.includes(env.materialAssetId)) throw new Error('VFX_MATERIAL_NOT_BOUND');
}
/** One executor per world: its frozen data fingerprints invalidate only that world's scope. */
export function worldCompositeExecutor(raw: z.input<typeof WorldCompositeSchema>): DurableExecutor {
  const c = WorldCompositeSchema.parse(raw);
  const script = resolve('scripts/vfx/sequence_render.py');
  async function validate(task: Task, brief: Brief, env?: Environment) {
    assertWorld(c,task,brief,env);
    await Promise.all([c.source,c.plate,c.matte,c.room,c.look].map(verify));
    if(c.plateMotion.mode==='fixed_lunar_flag'){
      await verify(c.plateMotion.authorization);
      assertFixedFlagApproval(c,brief,JSON.parse(await readFile(c.plateMotion.authorization.path,'utf8')));
    }
    format(await probe(c.source.path),brief,brief.frames);
    const p = await probe(c.plate.path); format(p,brief);
    if (p.frames-c.plateStartFrame < env!.endFrame-env!.startFrame) throw new Error('VFX_PLATE_TOO_SHORT');
  }
  async function result(task: Task, brief: Brief, key: string, env: Environment) {
    const dir = outputDir(c.root,key), path = join(dir,'composite.mp4');
    const r = JSON.parse(await readFile(join(dir,'report.json'),'utf8'));
    format(await probe(path),brief,env.endFrame-env.startFrame);
    const motionPass=c.plateMotion.mode==='moving'?r.plateMotionMeanAbsFrameDiff>.1:
      r.plateMotionMode==='fixed_lunar_flag'&&r.plateMotionMeanAbsFrameDiff===0&&r.sourceMotionMeanAbsFrameDiff>.1;
    if (r.environmentId !== env.id || r.frames !== env.endFrame-env.startFrame || r.grainPasses !== 0 || r.transition !== 'cut' || r.subjectInteriorPixels <= 0 || r.subjectMaxDifference !== 0 || !motionPass) throw new Error('VFX_COMPOSITE_QA_FAILED');
    const fingerprint = await hash(path);
    const receipt = JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));
    if (receipt.sha256 !== fingerprint || receipt.operationKey !== key) throw new Error('VFX_OUTPUT_CHANGED');
    return { assetId: task.outputAssetId, sha256: fingerprint, checks: [{ name:'technical-pixels',pass:true,evidence:JSON.stringify(r) }] };
  }
  return { capability: { available:true,paid:false,preservesOriginalPixels:false,
    recipeVersion:`world-cut/2:${stableHash(c,64)}`, environments:[{ kind:c.worldKind,lighting:c.lighting }] }, allowedStages:['integration'],
    async run(task,brief,key,env) {
      await validate(task,brief,env);
      const dir = outputDir(c.root,key); await mkdir(dir,{ recursive:true });
      try { await access(join(dir,'receipt.json')); return await result(task,brief,key,env!); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const manifest = join(dir,'inputs.json');
      await writeFile(manifest,JSON.stringify({ ...c,width:brief.width,height:brief.height,fps:brief.fps,frames:brief.frames,startFrame:env!.startFrame,endFrame:env!.endFrame }));
      await exec('python',[script,manifest,dir],{ timeout:15*60_000,maxBuffer:1024*1024 });
      await writeFile(join(dir,'receipt.json'),JSON.stringify({ operationKey:key,sha256:await hash(join(dir,'composite.mp4')) }));
      return result(task,brief,key,env!);
    },
    async recover(task,brief,key,env) {
      await validate(task,brief,env);
      try { return await result(task,brief,key,env!); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    } };
}
export function assertCuts(c: z.infer<typeof CutMasterSchema>, task: Task, brief: Brief) {
  if (task.stage !== 'master' || task.environmentId || c.segments.length !== brief.environments.length || task.inputAssetIds.length !== c.segments.length) throw new Error('VFX_MASTER_BINDING');
  let frame = 0;
  for (const [i,s] of c.segments.entries()) {
    if (s.environmentId !== brief.environments[i]?.id || s.startFrame !== frame || s.endFrame <= frame || !task.inputAssetIds.includes(s.assetId)) throw new Error('VFX_CUT_GAP_OVERLAP_OR_ORDER');
    frame = s.endFrame;
  }
  if (frame !== brief.frames || new Set(c.segments.map(s=>s.assetId)).size !== c.segments.length) throw new Error('VFX_CUT_COVERAGE');
}
export function assertReviewedSegments(c: z.infer<typeof CutMasterSchema>, job: Pick<Job,'plan'|'results'>) {
  for (const segment of c.segments) {
    const env = job.plan.environments.find(e => e.id === segment.environmentId);
    const task = job.plan.tasks.find(t => t.stage === 'integration' && t.environmentId === segment.environmentId);
    if (!env || !task || env.startFrame !== segment.startFrame || env.endFrame !== segment.endFrame || task.outputAssetId !== segment.assetId || job.results[task.id]?.sha256 !== segment.sha256) throw new Error('VFX_REVIEWED_SEGMENT_MISMATCH');
  }
}
/** Durable worker checks every world's reviews before calling this assembler. */
export function cutMasterExecutor(raw: z.input<typeof CutMasterSchema>): DurableExecutor {
  const c = CutMasterSchema.parse(raw);
  async function validate(task: Task,brief: Brief) {
    assertCuts(c,task,brief);
    for (const s of c.segments) { await verify(s); format(await probe(s.path),brief,s.endFrame-s.startFrame); }
  }
  async function result(task: Task,brief: Brief,key: string) {
    const dir = outputDir(c.root,key), path = join(dir,'master.mp4');
    format(await probe(path),brief,brief.frames);
    const r = JSON.parse(await readFile(join(dir,'receipt.json'),'utf8'));
    const fingerprint = await hash(path);
    if (r.sha256 !== fingerprint || r.operationKey !== key) throw new Error('VFX_OUTPUT_CHANGED');
    return { assetId:task.outputAssetId,sha256:fingerprint,checks:[{ name:'cut-sequence',pass:true,evidence:JSON.stringify({ frames:brief.frames,transition:'cut',grainPasses:c.grainStrength ? 1:0,segments:c.segments.map(s=>s.environmentId) }) }] };
  }
  return { capability:{ available:true,paid:false,preservesOriginalPixels:false,recipeVersion:`cut-master/1:${stableHash(c,64)}` },allowedStages:['master'],
    async run(task,brief,key) {
      await validate(task,brief);
      const dir = outputDir(c.root,key); await mkdir(dir,{ recursive:true });
      try { await access(join(dir,'receipt.json')); return await result(task,brief,key); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const labels = c.segments.map((_,i)=>`[${i}:v]setpts=PTS-STARTPTS[v${i}]`).join(';');
      const concat = c.segments.map((_,i)=>`[v${i}]`).join('')+`concat=n=${c.segments.length}:v=1:a=0`;
      const grain = c.grainStrength ? `,noise=alls=${c.grainStrength}:allf=t:all_seed=29` : '';
      const tmp = join(dir,'master.partial.mp4');
      await exec('ffmpeg',['-v','error','-n',...c.segments.flatMap(s=>['-i',s.path]),'-filter_complex',`${labels};${concat}${grain}[out]`,'-map','[out]','-an','-c:v','libx264','-crf','14','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',tmp],{ timeout:15*60_000,maxBuffer:1024*1024 });
      format(await probe(tmp),brief,brief.frames);
      await rename(tmp,join(dir,'master.mp4'));
      await writeFile(join(dir,'receipt.json'),JSON.stringify({operationKey:key,sha256:await hash(join(dir,'master.mp4'))}));
      return result(task,brief,key);
    },
    async recover(task,brief,key) { await validate(task,brief); try {return await result(task,brief,key);} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT') return null; throw e;} }
  };
}
