/** Private runner measurement only. Never exports source media, frames or signed URLs. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServiceClient} from '../../src/lib/supabase/service';
async function main(){
 const dir=await mkdtemp(join(tmpdir(),'vfx-private-source-'));
 try {
  const storage=createServiceClient().storage.from('videos');
  const prefix='precampaign-teaser-v1/v2';
  const listed=await storage.list(prefix,{limit:100});
  if(listed.error)throw new Error('SOURCE_LIST_FAILED');
  const files=(listed.data??[]).filter(f=>f.name.startsWith('vfx-001-source-')&&f.name.endsWith('.mp4'));
  if(files.length!==1)throw new Error('SOURCE_AMBIGUOUS');
  const downloaded=await storage.download(`${prefix}/${files[0].name}`);
  if(downloaded.error||!downloaded.data)throw new Error('SOURCE_DOWNLOAD_FAILED');
  const bytes=Buffer.from(await downloaded.data.arrayBuffer()),path=join(dir,'source.mp4');
  await writeFile(path,bytes);
  const {stdout}=await promisify(execFile)(process.env.FFPROBE_BINARY??'ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',path]);
  const probe=JSON.parse(stdout),video=probe.streams.find((s:{codec_type:string})=>s.codec_type==='video');
  if(!video)throw new Error('SOURCE_VIDEO_MISSING');
  const report={checkedAt:new Date().toISOString(),sourceSha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,width:video.width,height:video.height,fps:video.avg_frame_rate,frames:Number(video.nb_read_frames),durationSeconds:Number(probe.format.duration),hasAudio:probe.streams.some((s:{codec_type:string})=>s.codec_type==='audio'),paidCalls:0,sourceExported:false,framesExported:false};
  if(!Number.isInteger(report.frames)||report.frames<3)throw new Error('SOURCE_FRAMES_UNMEASURED');
  await writeFile('vfx-source-metadata.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await rm(dir,{recursive:true,force:true});}
}
main().catch(()=>{console.error('VFX_SOURCE_MEASUREMENT_BLOCKED');process.exitCode=1;});
