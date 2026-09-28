/** Dulce final assembly + automatic QC. Zero paid calls: reads only the cached Brian
 * narration, the durable Runway clips recorded by dulce-full.ts, and licensed library
 * music, then renders 1920x1080/30 with FFmpeg (word-highlight subtitles burned in).
 * Never submits a generation; a missing or checksum-mismatched asset stops the render.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../src/lib/supabase/service';
import {getVoiceIdentity} from '../src/lib/ai/voice';
import {loadProductionCachedBeatNarration} from '../src/lib/video/long-form/production-tts-cache';
import {readAiVideoClipRecord} from '../src/lib/video/long-form/ai-video-storage';
import {buildContactSheet,frameAt,probeDuration} from './lib/contact-sheet';
import {FPS,buildAss,buildCues,clipInPoint,clipRecordKey,longestHold,musicSections,validateTimeline,type MeasuredBeat,type PlanShot,type TitleOverlay,type WordTiming} from './lib/dulce-edit';

const ID='dulce-001',PREFIX='dulce-001/full-v1',SCOPE='dulce-001-full-v1';
const MUSIC:[string,string,string]=['elevenlabs-tension-1','elevenlabs-tension-2','elevenlabs-reflective-1'];
const out=process.env.DULCE_OUT||'/tmp/dulce-full';
const work=path.join(out,'work');
const service=createServiceClient(),bucket=service.storage.from('videos');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const log=(tag:string,v:unknown)=>console.log(`@@DULCE_${tag} `+JSON.stringify(v));

async function read(p:string,b=bucket){const {data,error}=await b.download(p);if(error||!data)return null;return Buffer.from(await data.arrayBuffer());}
function run(cmd:string,args:string[],quiet=true):Promise<string>{return new Promise((resolve,reject)=>{
  const p=spawn(cmd,args);let err='';p.stderr.on('data',c=>{err+=c;if(err.length>4e6)err=err.slice(-2e6);});if(!quiet)p.stdout.pipe(process.stdout);
  p.on('error',reject);p.on('close',code=>code===0?resolve(err):reject(Error(`${cmd} exited ${code}: ${err.slice(-1500)}`)));});}
async function probe(file:string){const o=await new Promise<string>((res,rej)=>{const p=spawn('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,size,bit_rate','-of','json',file]);let s='';p.stdout.on('data',c=>s+=c);p.on('close',c=>c===0?res(s):rej(Error('ffprobe '+file)));});return JSON.parse(o);}
async function pool<T>(items:T[],n:number,fn:(t:T)=>Promise<void>){let i=0;const errs:unknown[]=[];await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const t=items[i++];try{await fn(t);}catch(e){errs.push(e);}}}));if(errs.length)throw errs[0];}

/** The two opening library clips were uploaded outside the shot pipeline; locate them read-only. */
async function findLibraryClip(fileName:string):Promise<{bucket:string;path:string}|null>{
  const want=fileName.toLowerCase();let calls=0;
  const {data:buckets}=await service.storage.listBuckets();
  const names=['videos',...(buckets||[]).map(b=>b.name).filter(n=>n!=='videos')];
  const interesting=/dulce|runway|librar|media|pilot|sample|upload|clip|asset|reference|archive|raw|manual/i;
  for(const name of names){
    const queue:[string,number][]=[['',0]];
    while(queue.length&&calls<400){
      const [dir,depth]=queue.shift()!;calls++;
      const {data,error}=await service.storage.from(name).list(dir,{limit:1000});if(error||!data)continue;
      for(const e of data){
        const full=dir?`${dir}/${e.name}`:e.name;
        if(e.id&&e.name.toLowerCase()===want)return {bucket:name,path:full};
        if(!e.id&&depth<5&&(depth===0||interesting.test(e.name))&&!/^state$|^claims$|^errors$|^tts$/.test(e.name))queue.push([full,depth+1]);
      }
    }
  }
  return null;
}

type Source={shotId:string;kind:'runway'|'library'|'still-motion';file:string;sha256:string;origin:string;inSeconds:number;note?:string};

async function main(){
  await fs.mkdir(work,{recursive:true});
  const spec=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-shots.json','utf8')) as {shots:PlanShot[];measuredBeats:(MeasuredBeat&{sha256:string})[]};
  const script=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-script.json','utf8')) as {meta:{title:string;disclaimer:string};beats:{id:string;narration:string}[]};
  const {totalFrames}=validateTimeline(spec.shots,spec.measuredBeats);const total=totalFrames/FPS;
  const qc:Record<string,unknown>={videoId:ID,commit:process.env.GITHUB_SHA||null,runId:process.env.GITHUB_RUN_ID||null,paidCallsThisRun:0,plannedSeconds:total,shots:spec.shots.length};

  // 1) Narration: cached Brian audio only (throws on cache miss; never synthesizes).
  const identity=getVoiceIdentity('en');if(identity.voiceId!=='nPczCjzI2devNBz1zQrb')throw Error('Brian identity mismatch');
  const words:WordTiming[]=[];const narration=[];
  for(const beat of script.beats){
    const mb=spec.measuredBeats.find(b=>b.beatId===beat.id)!;
    const n=await loadProductionCachedBeatNarration(service,'elevenlabs',beat,'en',{videoId:ID,voiceIdentity:identity});
    const file=path.join(work,`${beat.id}.${n.extension}`);await fs.writeFile(file,n.audioBuffer);
    const measured=await probeDuration(file);const offset=mb.startFrame/FPS+mb.voiceOffsetSeconds;
    if(Math.abs(measured-mb.audioDurationSeconds)>0.15)throw Error(`Narration ${beat.id} duration ${measured} differs from measured ${mb.audioDurationSeconds}`);
    for(const w of n.words)words.push({text:w.text,startSeconds:w.startSeconds+offset,endSeconds:w.endSeconds+offset});
    narration.push({beatId:beat.id,file,offset,durationSeconds:measured,sha256:sha(n.audioBuffer),matchesMeasuredSha:sha(n.audioBuffer)===mb.sha256,words:n.words.length});
  }
  log('NARRATION',{beats:narration.length,words:words.length,seconds:narration.reduce((a,n)=>a+n.durationSeconds,0)});
  qc.narration=narration.map(({file:_f,...r})=>r);

  // 2) Picture sources: current Runway revision per shot, verified by checksum.
  const sources=new Map<string,Source>();
  await pool(spec.shots,6,async shot=>{
    const file=path.join(work,`src-${shot.shotId}.mp4`);
    if(shot.reuse){
      let bytes:Buffer|null=null,origin='';
      if(shot.reuse.storagePath){bytes=await read(shot.reuse.storagePath);origin='videos/'+shot.reuse.storagePath;if(bytes&&shot.reuse.sha256&&sha(bytes)!==shot.reuse.sha256)throw Error('Checksum mismatch '+shot.shotId);}
      if(!bytes){const found=await findLibraryClip(shot.reuse.libraryFileName);if(found){bytes=await read(found.path,service.storage.from(found.bucket));origin=`${found.bucket}/${found.path}`;}}
      if(bytes){await fs.writeFile(file,bytes);sources.set(shot.shotId,{shotId:shot.shotId,kind:'library',file,sha256:sha(bytes),origin,inSeconds:shot.reuse.inSeconds});return;}
      // Approved pilot still for the same composition, with continuous camera motion (no freeze).
      const still=shot.shotId==='D01-01'?'d01':shot.shotId==='D01-03'?'d03':null;
      const sb=still?await read(`dulce-001/samples/pilot/ai/dulce-${still}-v1-still.png`):null;
      if(!sb)throw Error('Missing library clip and approved still for '+shot.shotId);
      const sf=path.join(work,`still-${shot.shotId}.png`);await fs.writeFile(sf,sb);
      sources.set(shot.shotId,{shotId:shot.shotId,kind:'still-motion',file:sf,sha256:sha(sb),origin:`videos/dulce-001/samples/pilot/ai/dulce-${still}-v1-still.png`,inSeconds:0,note:`library file ${shot.reuse.libraryFileName} not found in Storage`});return;
    }
    const key=clipRecordKey(shot);
    const record=await readAiVideoClipRecord(service,'videos',SCOPE,key);
    if(record?.status!=='COMPLETED'||!record.storagePath)throw Error(`No completed Runway clip for ${shot.shotId} (${key}): ${record?.status||'no record'}`);
    const bytes=await read(record.storagePath);if(!bytes||sha(bytes)!==record.checksumSha256)throw Error('Clip missing or checksum mismatch '+key);
    const metaRaw=await read(`${PREFIX}/clips/${shot.shotId}.json`);const meta=metaRaw?JSON.parse(metaRaw.toString()):null;
    if(meta&&meta.sha256!==record.checksumSha256)throw Error(`Latest reviewed clip for ${shot.shotId} is not revision ${key}`);
    await fs.writeFile(file,bytes);
    sources.set(shot.shotId,{shotId:shot.shotId,kind:'runway',file,sha256:record.checksumSha256!,origin:'videos/'+record.storagePath,inSeconds:0});
  });

  // 3) Normalize each shot to exact frame count at 1920x1080/30.
  const segs:string[]=[];const shotReport=[];
  for(const shot of spec.shots){
    const s=sources.get(shot.shotId)!;const seg=path.join(work,`seg-${shot.shotId}.mp4`);const edit=shot.editFrames/FPS;
    let args:string[];let clipSeconds:number|null=null;
    if(s.kind==='still-motion'){
      const n=shot.editFrames;
      args=['-y','-loop','1','-framerate',String(FPS),'-i',s.file,'-vf',`scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan=z='1.0+0.10*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=${FPS},setsar=1,format=yuv420p`];
    }else{
      clipSeconds=await probeDuration(s.file);
      s.inSeconds=s.kind==='library'?Math.min(s.inSeconds,Math.max(0,clipSeconds-edit-0.05)):clipInPoint(clipSeconds,edit);
      const pad=clipSeconds-s.inSeconds<edit?`,tpad=stop_mode=clone:stop_duration=${(edit-(clipSeconds-s.inSeconds)+0.1).toFixed(3)}`:'';
      args=['-y','-ss',s.inSeconds.toFixed(3),'-i',s.file,'-vf',`scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,format=yuv420p${pad}`];
    }
    await run('ffmpeg',[...args,'-frames:v',String(shot.editFrames),'-an','-c:v','libx264','-preset','veryfast','-crf','14','-r',String(FPS),seg]);
    segs.push(seg);
    shotReport.push({shotId:shot.shotId,beatId:shot.beatId,kind:s.kind,origin:s.origin,sha256:s.sha256,inSeconds:s.inSeconds,editSeconds:edit,clipSeconds,frozenFillSeconds:clipSeconds!==null?Math.max(0,edit-(clipSeconds-s.inSeconds)):0,note:s.note});
  }
  qc.sources=shotReport;
  await fs.writeFile(path.join(work,'concat.txt'),segs.map(f=>`file '${f}'`).join('\n'));
  const picture=path.join(work,'picture.mp4');
  await run('ffmpeg',['-y','-f','concat','-safe','0','-i',path.join(work,'concat.txt'),'-c','copy',picture]);
  log('PICTURE',{seconds:await probeDuration(picture)});

  // 4) Audio: narration at measured offsets, licensed music ducked under voice, loudness to -14 LUFS.
  const music=musicSections(spec.measuredBeats,MUSIC);const inputs:string[]=[];const f:string[]=[];
  narration.forEach((n,i)=>{inputs.push('-i',n.file);const d=Math.round(n.offset*1000);f.push(`[${i}]aresample=48000,aformat=channel_layouts=stereo,adelay=${d}|${d}[n${i}]`);});
  f.push(`${narration.map((_,i)=>`[n${i}]`).join('')}amix=inputs=${narration.length}:normalize=0:duration=longest,apad,atrim=0:${total},asplit[voice][key]`);
  for(const [j,m] of music.entries()){
    const {data,error}=await service.storage.from('music-library').download(m.trackId+'.mp3');if(error||!data)throw Error('Missing licensed music '+m.trackId);
    const mf=path.join(work,m.trackId+'.mp3');await fs.writeFile(mf,Buffer.from(await data.arrayBuffer()));
    const len=m.endSeconds-m.startSeconds,d=Math.round(m.startSeconds*1000);
    // Trim the cue's silent head/tail, then join loops with 3 s crossfades so a loop point never drops out.
    const trimmed=path.join(work,m.trackId+'-trimmed.wav');
    await run('ffmpeg',['-y','-i',mf,'-af','aresample=48000,aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',trimmed]);
    const copies=Math.ceil(len/Math.max(10,(await probeDuration(trimmed))-3))+1;
    const first=inputs.filter(x=>x==='-i').length;
    for(let k=0;k<copies;k++)inputs.push('-i',trimmed);
    let chain=`[${first}]`;
    for(let k=1;k<copies;k++){f.push(`${chain}[${first+k}]acrossfade=d=3[m${j}x${k}]`);chain=`[m${j}x${k}]`;}
    f.push(`${chain}atrim=0:${len.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=${m.fadeInSeconds},afade=t=out:st=${(len-m.fadeOutSeconds).toFixed(3)}:d=${m.fadeOutSeconds},adelay=${d}|${d}[m${j}]`);
  }
  f.push(`${music.map((_,j)=>`[m${j}]`).join('')}amix=inputs=${music.length}:normalize=0:duration=longest,apad,atrim=0:${total},volume=0.32[bed]`);
  f.push(`[bed][key]sidechaincompress=threshold=0.015:ratio=4:attack=30:release=600[ducked]`);
  f.push(`[voice]volume=0.94[v]`,`[v][ducked]amix=inputs=2:normalize=0:duration=first,afade=t=out:st=${(total-2.5).toFixed(3)}:d=2.5[mix]`);
  const mix=path.join(work,'mix.wav');
  await run('ffmpeg',['-y',...inputs,'-filter_complex',f.join(';'),'-map','[mix]','-t',String(total),'-c:a','pcm_s16le',mix]);
  const pass1=await run('ffmpeg',['-i',mix,'-af','loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json','-f','null','-']);
  const ln=JSON.parse(pass1.slice(pass1.lastIndexOf('{'),pass1.lastIndexOf('}')+1));
  const mastered=path.join(work,'mastered.wav');
  await run('ffmpeg',['-y','-i',mix,'-af',`loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${ln.input_i}:measured_TP=${ln.input_tp}:measured_LRA=${ln.input_lra}:measured_thresh=${ln.input_thresh}:offset=${ln.target_offset}:linear=true,aresample=48000`,'-c:a','pcm_s16le',mastered]);
  qc.music=music;

  // 5) Subtitles + title overlays (over moving picture, never on black).
  const b1=spec.measuredBeats[0],last=spec.measuredBeats[spec.measuredBeats.length-1];
  const b1VoiceEnd=b1.voiceOffsetSeconds+b1.audioDurationSeconds,lastVoiceEnd=last.startFrame/FPS+last.voiceOffsetSeconds+last.audioDurationSeconds;
  const overlays:TitleOverlay[]=[
    {start:b1VoiceEnd+0.1,end:b1VoiceEnd+3.6,lines:['DULCE','WHAT CAME HOME'],style:'Title'},
    {start:lastVoiceEnd+0.2,end:total-0.2,lines:['DULCE','WHAT CAME HOME'],style:'Title'},
    {start:lastVoiceEnd+0.2,end:total-0.2,lines:[script.meta.disclaimer],style:'Note'},
  ];
  const cues=buildCues(words);const ass=path.join(work,'dulce.ass');
  await fs.writeFile(ass,buildAss(cues,overlays));await fs.copyFile(ass,path.join(out,'dulce-001-subtitles.ass'));
  await fs.writeFile(path.join(out,'dulce-001-subtitles.srt'),cues.map((c,i)=>{const t=(s:number)=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};return `${i+1}\n${t(c.start)} --> ${t(c.end)}\n${c.words.map(w=>w.text).join(' ')}\n`;}).join('\n'));
  qc.subtitles={cues:cues.length,words:cues.reduce((a,c)=>a+c.words.length,0),expectedWords:words.length,firstStart:cues[0].start,lastEnd:cues[cues.length-1].end};

  // 6) Final encode.
  const final=path.join(out,'DULCE-What-Came-Home-final.mp4');
  await run('ffmpeg',['-y','-i',picture,'-i',mastered,'-vf',`subtitles=${ass}:fontsdir=/usr/share/fonts/truetype/dejavu,fade=t=out:st=${(total-1).toFixed(3)}:d=1`,
    '-map','0:v','-map','1:a','-c:v','libx264','-preset','medium','-crf','19','-maxrate','9M','-bufsize','18M','-pix_fmt','yuv420p','-r',String(FPS),'-g','60',
    '-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-metadata','title='+script.meta.title,'-t',String(total),final]);

  // 7) Automatic QC on the delivered file.
  const pr=await probe(final);const v=pr.streams.find((s:{codec_type:string})=>s.codec_type==='video'),a=pr.streams.find((s:{codec_type:string})=>s.codec_type==='audio');
  const det=await run('ffmpeg',['-i',final,'-vf','blackdetect=d=0.5:pic_th=0.97:pix_th=0.04,freezedetect=n=-55dB:d=2','-af','silencedetect=n=-45dB:d=1.2,ebur128=peak=true','-f','null','-']);
  const spans=(re:RegExp)=>[...det.matchAll(re)].map(m=>m.slice(1).map(Number));
  const black=spans(/black_start:([\d.]+) black_end:([\d.]+)/g).filter(([s])=>s<total-1.3);
  const fs0=[...det.matchAll(/freeze_start: ([\d.]+)/g)].map(m=>Number(m[1])),fe=[...det.matchAll(/freeze_end: ([\d.]+)/g)].map(m=>Number(m[1]));
  const frozen=fs0.map((s,i)=>[s,fe[i]??total]).filter(([s])=>s<total-1.3);
  const silS=[...det.matchAll(/silence_start: ([\d.]+)/g)].map(m=>Number(m[1])),silE=[...det.matchAll(/silence_end: ([\d.]+)/g)].map(m=>Number(m[1]));
  const silence=silS.map((s,i)=>[s,silE[i]??total]).filter(([s])=>s<total-3);
  const summary=det.slice(det.lastIndexOf('Summary:'));const num=(re:RegExp)=>Number(re.exec(summary)?.[1]);
  const kinds=shotReport.reduce((m:Record<string,number>,s)=>{m[s.kind]=(m[s.kind]||0)+1;return m;},{});
  const hookShots=shotReport.filter(s=>spec.shots.find(x=>x.shotId===s.shotId)!.startFrame<30*FPS);
  const duration=Number(pr.format.duration);
  const checks={
    durationNearPlan:Math.abs(duration-total)<0.5,
    durationInTarget:duration>=540&&duration<=610,
    resolution1080p:v?.width===1920&&v?.height===1080,
    fps30:v?.r_frame_rate==='30/1',
    audioPresent:!!a&&a.channels===2,
    noAccidentalBlack:black.length===0,
    noFrozenPicture:frozen.length===0,
    noSilentGaps:silence.length===0,
    loudnessNear14:Math.abs(num(/I:\s+(-?[\d.]+) LUFS/)+14)<=1,
    truePeakSafe:num(/Peak:\s+(-?[\d.]+) dBFS/)<=-1,
    allShotsSourced:shotReport.length===spec.shots.length,
    noFrozenFill:shotReport.every(s=>s.frozenFillSeconds<0.05),
    subtitlesCoverAllWords:(qc.subtitles as {words:number}).words===words.length,
    maxHoldUnder10s:longestHold(spec.shots).seconds<10,
    hookAllMoving:hookShots.every(s=>s.kind!=='still-motion')||hookShots.filter(s=>s.kind==='still-motion').length<=2,
  };
  Object.assign(qc,{final:{file:path.basename(final),bytes:Number(pr.format.size),sha256:sha(await fs.readFile(final)),durationSeconds:duration,width:v?.width,height:v?.height,fps:v?.r_frame_rate,videoCodec:v?.codec_name,audioCodec:a?.codec_name,bitRate:Number(pr.format.bit_rate)},
    loudness:{integratedLufs:num(/I:\s+(-?[\d.]+) LUFS/),lra:num(/LRA:\s+(-?[\d.]+) LU/),truePeakDbfs:num(/Peak:\s+(-?[\d.]+) dBFS/)},
    black,frozen,silence,shotKinds:kinds,cuts:spec.shots.length-1,averageShotSeconds:total/spec.shots.length,longestHold:longestHold(spec.shots),
    hook:{shots:hookShots.map(s=>({shotId:s.shotId,kind:s.kind,editSeconds:s.editSeconds})),firstVoiceSeconds:narration[0].offset,titleAt:overlays[0].start},checks});
  await fs.writeFile(path.join(out,'qc.json'),JSON.stringify(qc,null,2));

  // Visual review sheets: every second of the hook, then every 10 s.
  const hook=[];for(let t=0.5;t<30;t+=1)hook.push({image:await frameAt(final,t,480),label:`${t.toFixed(1)}s`});
  await fs.writeFile(path.join(out,'qc-hook-0-30s.jpg'),await buildContactSheet(hook,{columns:5,tileWidth:480,tileHeight:270,title:'DULCE final - first 30 s, 1 frame/s'}));
  const body=[];for(let t=5;t<total;t+=10)body.push({image:await frameAt(final,t,384),label:`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`});
  await fs.writeFile(path.join(out,'qc-episode-every-10s.jpg'),await buildContactSheet(body,{columns:6,tileWidth:384,tileHeight:216,title:'DULCE final - every 10 s'}));

  // Durable copy in Storage (split under the object size limit; reassemble with cat, verify sha256).
  const bytes=await fs.readFile(final);const part=45*1024*1024;const parts=[];
  try{
    for(let i=0;i*part<bytes.length;i++){const p=`${PREFIX}/final/DULCE-What-Came-Home-final.mp4.part${String(i).padStart(2,'0')}`;const {error}=await bucket.upload(p,bytes.subarray(i*part,(i+1)*part),{contentType:'application/octet-stream',upsert:true});if(error)throw Error(error.message);parts.push(p);}
    await bucket.upload(`${PREFIX}/final/manifest.json`,Buffer.from(JSON.stringify({file:path.basename(final),bytes:bytes.length,sha256:sha(bytes),parts,qc:checks,runId:process.env.GITHUB_RUN_ID,commit:process.env.GITHUB_SHA},null,2)),{contentType:'application/json',upsert:true});
    qc.storage={parts};
  }catch(e){qc.storage={error:e instanceof Error?e.message:String(e)};}
  await fs.writeFile(path.join(out,'qc.json'),JSON.stringify(qc,null,2));
  log('FINAL',{...(qc.final as object),checks});
  const failed=Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k);
  log('QC',{passed:failed.length===0,failed,black,frozen,silence,loudness:qc.loudness,shotKinds:kinds});
  await fs.rm(work,{recursive:true,force:true});
}
main().catch(e=>{console.error(e instanceof Error?e.stack||e.message:'Dulce render stopped');process.exitCode=1;});
