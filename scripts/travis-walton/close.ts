/** Final avatar preparation. Private media stays in private Storage or encrypted exports. */
import { createClient } from '@supabase/supabase-js';
import { createHash, privateDecrypt, publicEncrypt, randomBytes, createCipheriv, createDecipheriv, constants } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { refreshProviderSnapshot } from '../../src/lib/supply/monitor';
import { ensureJobSupplyReady } from '../../src/lib/supply/readiness';

const ROOT='ops/travis-walton', WORK='/tmp/travis-close';
const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
const bucket=db.storage.from('videos');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const log=(tag:string,value:unknown)=>console.log(tag,JSON.stringify(value));
mkdirSync(WORK,{recursive:true});mkdirSync('sealed-out',{recursive:true});
async function get(path:string){const r=await bucket.download(path);if(r.error||!r.data)throw Error('ASSET_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());}
async function put(path:string,b:Buffer,mime:string){
 const old=await bucket.download(path);
 if(old.data){if(sha(Buffer.from(await old.data.arrayBuffer()))!==sha(b))throw Error('EXISTING_ASSET_MISMATCH');return;}
 const r=await bucket.upload(path,b,{contentType:mime,upsert:false});if(r.error)throw Error('STORE_FAILED');
 if(sha(await get(path))!==sha(b))throw Error('STORE_VERIFY_FAILED');
}
function seal(name:string,b:Buffer){
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),ct=Buffer.concat([c.update(b),c.final()]);
 const ek=publicEncrypt({key:readFileSync(`${ROOT}/export-public.pem`),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
 writeFileSync(`sealed-out/${name}.sealed`,[ek,iv,c.getAuthTag(),ct].map(x=>x.toString('base64')).join('.'));
}
async function config(){
 const pem=await get('ops/podcast-episode/runner-key.pem');
 const [ek,iv,tag,ct]=readFileSync(`${ROOT}/production.json.sealed`,'utf8').trim().split('.').map(x=>Buffer.from(x,'base64'));
 const key=privateDecrypt({key:pem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},ek);
 const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return JSON.parse(Buffer.concat([d.update(ct),d.final()]).toString());
}
type Word={text:string;startSeconds:number;endSeconds:number};
const normalize=(s:string)=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function locate(words:Word[],phrase:string){
 const wanted=normalize(phrase).split(' '),hits:number[]=[];
 for(let i=0;i<=words.length-wanted.length;i++) if(wanted.every((w,j)=>normalize(words[i+j].text)===w))hits.push(i);
 if(hits.length!==1)throw Error('PHRASE_NOT_UNIQUE');return {first:hits[0],last:hits[0]+wanted.length-1};
}
async function exportEditorInput(ownerId:string,episodeId:string){
 const u=await db.auth.admin.getUserById(ownerId);if(!u.data.user?.email)throw Error('OWNER_NOT_FOUND');
 const link=await db.auth.admin.generateLink({type:'magiclink',email:u.data.user.email});if(link.error)throw Error('OWNER_LINK_FAILED');
 const owner=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const signed=await owner.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});if(signed.error||!signed.data.session)throw Error('OWNER_SESSION_FAILED');
 try{
  const r=await owner.storage.from('podcast-editor').download(`episodios/${episodeId}/v3/entrada/montaje.json`);
  if(r.error||!r.data)throw Error('V3_MANIFEST_UNAVAILABLE');seal('v3-montaje.json',Buffer.from(await r.data.arrayBuffer()));
 }finally{const r=await db.auth.admin.signOut(signed.data.session.access_token,'local');if(r.error)throw Error('OWNER_LOGOUT_FAILED');}
}
async function main(){
 const cfg=await config();
 const prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}`,out=`${prefix}/avatar-final`;
 const bytes=await get(`${prefix}/narration-manifest.json`),m=JSON.parse(bytes.toString());
 if(m.episodeId!==cfg.episodeId||m.blocks.length!==6)throw Error('NARRATION_IDENTITY_MISMATCH');
 const sourceImage=await get(`${cfg.ownerId}/podcasts/${cfg.previousEpisodeId}/studio/composite-wide-2.png`);
 seal('studio.png',sourceImage);seal('narration-manifest.json',bytes);
 await exportEditorInput(cfg.ownerId,cfg.episodeId);
 const definitions=[
  {id:'presentacion',block:'n01',from:'Hoy vamos a seguir esa historia',to:'vamos a regresar a ese camino'},
  {id:'pregunta',block:'n02',from:'Aquí quiero detener la imagen un momento',to:'que antes ocupaba alguien'},
  {id:'giro',block:'n05',from:'Quiero hacerte una pregunta',to:'aunque no demuestra su respuesta'},
  {id:'cierre',block:'n06',from:'Ahora sí quiero leerte',to:'Soy Hans Gracias por escuchar'},
 ];
 let offset=0;const offsets=new Map<string,number>();for(const b of m.blocks){offsets.set(b.id,offset);offset+=b.seconds;}
 const cuts=[];let batchTime=0;
 for(const d of definitions){
  const b=m.blocks.find((x:any)=>x.id===d.block);if(!b)throw Error('BLOCK_MISSING');
  const a=locate(b.words,d.from),z=locate(b.words,d.to);if(a.first>=z.last)throw Error('CUT_ORDER');
  const globalStart=Math.floor((offsets.get(b.id)!+Math.max(0,b.words[a.first].startSeconds-.10))*25)/25;
  const globalEnd=Math.ceil((offsets.get(b.id)!+Math.min(b.seconds,b.words[z.last].endSeconds+.18))*25)/25;
  const start=globalStart-offsets.get(b.id)!,seconds=globalEnd-globalStart;
  const audio=await get(b.path);if(sha(audio)!==b.sha256)throw Error('NARRATION_HASH_MISMATCH');
  writeFileSync(`${WORK}/${b.id}.mp3`,audio);
  const path=`${WORK}/${d.id}.wav`;
  execFileSync('ffmpeg',['-nostdin','-v','error','-y','-i',`${WORK}/${b.id}.mp3`,'-ss',String(start),'-t',String(seconds),'-ar','16000','-ac','1','-c:a','pcm_s16le',path],{stdio:'pipe'});
  const wav=readFileSync(path);await put(`${out}/${d.id}.wav`,wav,'audio/wav');
  cuts.push({...d,sourceAudio:b.path,sourceSha256:b.sha256,start,seconds,globalStart,globalEnd,batchStart:batchTime,wavSha256:sha(wav)});
  batchTime+=seconds;
 }
 writeFileSync(`${WORK}/concat.txt`,cuts.map(c=>`file '${WORK}/${c.id}.wav'`).join('\n'));
 execFileSync('ffmpeg',['-nostdin','-v','error','-y','-f','concat','-safe','0','-i',`${WORK}/concat.txt`,'-c:a','pcm_s16le',`${WORK}/batch.wav`],{stdio:'pipe'});
 const batch=readFileSync(`${WORK}/batch.wav`);
 const seconds=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',`${WORK}/batch.wav`]).toString().trim());
 if(Math.abs(seconds-batchTime)>.02||seconds>168||batch.length>32*1024*1024)throw Error('BATCH_INVALID');
 const estimatedUsd=Math.ceil(seconds*.0385*100)/100;
 const plan={episodeId:cfg.episodeId,ownerId:cfg.ownerId,sourceVersion:3,version:4,cuts,seconds,estimatedUsd,maxAvatarUsd:6.5,batchPath:`${out}/batch.wav`,batchSha256:sha(batch),imagePath:`${out}/studio.png`,imageSha256:sha(sourceImage),resolution:'720p',outputResolution:'1920x1080',audioPolicy:'Preserve v3 final mix unchanged; discard avatar-generated audio.'};
 await put(plan.batchPath,batch,'audio/wav');await put(plan.imagePath,sourceImage,'image/png');
 const planBytes=Buffer.from(JSON.stringify(plan,null,2));await put(`${out}/plan.json`,planBytes,'application/json');seal('avatar-plan.json',planBytes);
 await refreshProviderSnapshot(db,'heygen');
 const ready=await ensureJobSupplyReady(db,[{provider:'heygen',unit:'usd',units:estimatedUsd,usd:estimatedUsd}]);
 log('AVATAR_PREPARED',{cuts:cuts.length,seconds,estimatedUsd,paidCalls:0,ready:ready.ready,failure:ready.failure??null});
}
main().catch(()=>{console.error('CLOSE_PREPARATION_FAILED: no paid calls submitted; inspect private outputs');process.exitCode=1;});
