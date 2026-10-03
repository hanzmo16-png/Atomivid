/** Deterministic frame duplication/drop only: native 1080p remains 1080p, no upscale or invented motion.
 * Usage: node --import tsx scripts/vfx/normalize-plate.ts input.mp4 expectedSHA256 output.mp4
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const exec=promisify(execFile);
async function main(){
 const [input,sha,output]=process.argv.slice(2);
 if(!input||!output||! /^[a-f0-9]{64}$/.test(sha??''))throw new Error('VFX_NORMALIZE_ARGUMENTS');
 if(createHash('sha256').update(await readFile(input)).digest('hex')!==sha)throw new Error('VFX_INPUT_CHANGED');
 try{await access(output);throw new Error('VFX_OUTPUT_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',input]);
 const m=JSON.parse(stdout),v=m.streams.find((s:{codec_type:string})=>s.codec_type==='video');
 if(!v||v.width!==1080||v.height!==1920||v.r_frame_rate!=='25/1'||Math.abs(Number(m.format.duration)-6)>.04||m.streams.some((s:{codec_type:string})=>s.codec_type==='audio'))throw new Error('VFX_FINAL_PLATE_FORMAT');
 await exec('ffmpeg',['-v','error','-n','-i',input,'-vf','fps=30:round=near','-frames:v','180','-an','-c:v','libx264','-crf','14','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',output],{timeout:5*60_000,maxBuffer:1024*1024});
 const result=await exec('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_read_frames','-of','json',output]);
 const p=JSON.parse(result.stdout).streams[0];
 if(p.width!==1080||p.height!==1920||p.r_frame_rate!=='30/1'||Number(p.nb_read_frames)!==180)throw new Error('VFX_NORMALIZATION_FAILED');
 console.log(JSON.stringify({sha256:createHash('sha256').update(await readFile(output)).digest('hex'),frames:180,fps:30,method:'nearest-frame duplication/drop; no spatial scaling or generated frames'}));
}
main().catch(()=>{console.error('VFX_NORMALIZATION_BLOCKED');process.exitCode=1;});
