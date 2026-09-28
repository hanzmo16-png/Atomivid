/** Watch link for the Dulce master: rejoins the verified Storage parts (no re-encode, no paid calls),
 * uploads the whole MP4 for in-browser playback and writes 7-day signed URLs to a file (never to the
 * log: Actions masks JWT-shaped tokens). If the project's object size limit rejects the whole file,
 * falls back to a lossless HLS copy (-c copy) whose playlist points at signed segment URLs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../src/lib/supabase/service';

const FINAL='dulce-001/full-v1/final',WATCH='dulce-001/full-v1/watch',NAME='DULCE-What-Came-Home-final.mp4';
const EXPECTED='ecfb84452883123c71b7cf717ac5c3df5309798651749b3efcb223463f485eeb';
const TTL=7*24*3600;
const out=process.env.DULCE_OUT||'/tmp/dulce-watch';
const service=createServiceClient(),bucket=service.storage.from('videos');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const log=(tag:string,v:unknown)=>console.log(`@@DULCE_${tag} `+JSON.stringify(v));
const url=process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/,''),key=process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function read(p:string){const {data,error}=await bucket.download(p);if(error||!data)throw Error('Storage read failed '+p+': '+(error?.message||'empty'));return Buffer.from(await data.arrayBuffer());}
function run(cmd:string,args:string[]){return new Promise<void>((res,rej)=>{const p=spawn(cmd,args);let e='';p.stderr.on('data',c=>e+=c);p.on('close',c=>c===0?res():rej(Error(e.slice(-1500))));});}
async function sign(p:string,download=false){const {data,error}=await bucket.createSignedUrl(p,TTL,download?{download:NAME}:undefined);if(error||!data)throw Error('Sign failed '+p+': '+error?.message);return data.signedUrl;}

/** TUS resumable upload (Supabase Storage protocol) for objects above the standard upload size. */
async function tusUpload(objectName:string,bytes:Buffer,contentType:string){
  const b64=(s:string)=>Buffer.from(s).toString('base64');
  const auth={Authorization:`Bearer ${key}`,apikey:key,'Tus-Resumable':'1.0.0'};
  const create=await fetch(`${url}/storage/v1/upload/resumable`,{method:'POST',headers:{...auth,'x-upsert':'true','Upload-Length':String(bytes.length),
    'Upload-Metadata':`bucketName ${b64('videos')},objectName ${b64(objectName)},contentType ${b64(contentType)},cacheControl ${b64('3600')}`}});
  if(create.status!==201)throw Error(`TUS create HTTP ${create.status}: ${(await create.text()).slice(0,300)}`);
  const loc=create.headers.get('location');if(!loc)throw Error('TUS create returned no location');
  const chunk=6*1024*1024;
  for(let off=0;off<bytes.length;off+=chunk){
    const r=await fetch(loc,{method:'PATCH',headers:{...auth,'Upload-Offset':String(off),'Content-Type':'application/offset+octet-stream'},body:new Uint8Array(bytes.subarray(off,off+chunk))});
    if(r.status!==204)throw Error(`TUS patch at ${off} HTTP ${r.status}: ${(await r.text()).slice(0,300)}`);
  }
}

async function main(){
  await fs.mkdir(out,{recursive:true});
  const {data:info}=await service.storage.getBucket('videos');
  log('BUCKET',{public:info?.public,fileSizeLimit:info?.file_size_limit??null});

  // 1) Lossless rejoin, verified against the manifest and the reviewed master checksum.
  const manifest=JSON.parse((await read(`${FINAL}/manifest.json`)).toString()) as {bytes:number;sha256:string;parts:string[]};
  if(manifest.sha256!==EXPECTED)throw Error('Storage manifest is not the reviewed master: '+manifest.sha256);
  const parts:Buffer[]=[];for(const p of manifest.parts)parts.push(await read(p));
  const master=Buffer.concat(parts);
  if(master.length!==manifest.bytes||sha(master)!==EXPECTED)throw Error('Rejoined file does not match the master checksum');
  log('REJOINED',{parts:parts.length,bytes:master.length,sha256:EXPECTED});

  const target=`${WATCH}/${NAME}`;const result:Record<string,unknown>={sha256:EXPECTED,bytes:master.length,expiresInDays:7,expiresAt:new Date(Date.now()+TTL*1000).toISOString()};
  // 2) Whole MP4: standard upload, then resumable if the standard endpoint refuses the size.
  let whole=false;
  const {error}=await bucket.upload(target,master,{contentType:'video/mp4',upsert:true,cacheControl:'3600'});
  if(!error)whole=true;else{log('STANDARD_UPLOAD_REFUSED',{message:error.message});try{await tusUpload(target,master,'video/mp4');whole=true;}catch(e){log('TUS_UPLOAD_REFUSED',{message:e instanceof Error?e.message:String(e)});}}
  if(whole){
    const check=await read(target);if(sha(check)!==EXPECTED)throw Error('Uploaded MP4 checksum mismatch');
    Object.assign(result,{mode:'mp4',path:'videos/'+target,watchUrl:await sign(target),downloadUrl:await sign(target,true)});
  }else{
    // 3) Fallback: same streams, stream-copied into HLS segments under the object limit.
    const src=path.join(out,NAME);await fs.writeFile(src,master);const hls=path.join(out,'hls');await fs.mkdir(hls,{recursive:true});
    await run('ffmpeg',['-y','-i',src,'-c','copy','-f','hls','-hls_time','30','-hls_playlist_type','vod','-hls_segment_filename',path.join(hls,'seg%03d.ts'),path.join(hls,'index.m3u8')]);
    const lines=(await fs.readFile(path.join(hls,'index.m3u8'),'utf8')).split('\n');const signed:string[]=[];
    for(const l of lines){if(!l.endsWith('.ts')){signed.push(l);continue;}const p=`${WATCH}/hls/${l}`;const {error:e}=await bucket.upload(p,await fs.readFile(path.join(hls,l)),{contentType:'video/mp2t',upsert:true});if(e)throw Error('Segment upload '+l+': '+e.message);signed.push(await sign(p));}
    const pl=`${WATCH}/hls/index.m3u8`;const {error:e}=await bucket.upload(pl,Buffer.from(signed.join('\n')),{contentType:'application/vnd.apple.mpegurl',upsert:true});if(e)throw Error('Playlist upload: '+e.message);
    Object.assign(result,{mode:'hls',watchUrl:await sign(pl),note:'Whole-file upload refused by the object size limit; HLS plays natively in Safari/iOS.'});
  }
  // 4) Play the signed link anonymously, as a phone would: full duration and decodable picture and sound.
  const probe=await new Promise<string>((res,rej)=>{const p=spawn('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',result.watchUrl as string]);let s='',e='';p.stdout.on('data',c=>s+=c);p.stderr.on('data',c=>e+=c);p.on('close',c=>c===0?res(s):rej(Error('Anonymous playback probe failed: '+e.slice(-500))));});
  const pj=JSON.parse(probe);const duration=Number(pj.format.duration);
  for(const t of ['5','280','565'])await run('ffmpeg',['-v','error','-ss',t,'-i',result.watchUrl as string,'-t','2','-f','null','-']);
  result.playbackCheck={anonymous:true,durationSeconds:duration,streams:pj.streams,decodedAt:[5,280,565]};
  if(Math.abs(duration-570)>1)throw Error('Signed link duration '+duration);
  await fs.writeFile(path.join(out,'watch-link.json'),JSON.stringify(result,null,2));
  await fs.rm(path.join(out,NAME),{force:true});await fs.rm(path.join(out,'hls'),{recursive:true,force:true});
  log('WATCH',{mode:result.mode,expiresAt:result.expiresAt});
}
main().catch(e=>{console.error(e instanceof Error?e.message:'watch link failed');process.exitCode=1;});
