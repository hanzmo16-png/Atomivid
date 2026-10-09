import { createClient } from '@supabase/supabase-js';
import { createHash, privateDecrypt, publicEncrypt, randomBytes, createCipheriv, createDecipheriv, constants } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { refreshProviderSnapshot } from '../../src/lib/supply/monitor';
import { ensureJobSupplyReady } from '../../src/lib/supply/readiness';
import { gatedVoiceSynthesize } from '../../src/lib/paid-calls/gated-providers';
import { supabaseLedgerStore } from '../../src/lib/paid-calls/supabase-ledger-store';
import { supabaseResultStore } from '../../src/lib/paid-calls/result-store';
import { getVoiceIdentity, synthesizeVoice } from '../../src/lib/ai/voice';

const ROOT='ops/travis-walton';
const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
const bucket=db.storage.from('videos');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const log=(tag:string,value:unknown)=>console.log(tag,JSON.stringify(value));
mkdirSync('sealed-out',{recursive:true});
async function get(path:string){const r=await bucket.download(path);if(r.error||!r.data)throw Error('ASSET_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());}
function seal(name:string,b:Buffer){
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);
 const ct=Buffer.concat([c.update(b),c.final()]);
 const ek=publicEncrypt({key:readFileSync(`${ROOT}/export-public.pem`),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
 writeFileSync(`sealed-out/${name}.sealed`,[ek,iv,c.getAuthTag(),ct].map(x=>x.toString('base64')).join('.'));
}
async function unseal(path:string){
 const pem=await get('ops/podcast-episode/runner-key.pem');
 const [ek,iv,tag,ct]=readFileSync(path,'utf8').trim().split('.').map(x=>Buffer.from(x,'base64'));
 const key=privateDecrypt({key:pem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},ek);
 const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]);
}
type Chapter={id:string;title:string;text:string};
type Config={episodeId:string;ownerId:string;voiceId:string;previousEpisodeId:string;chapters:Chapter[];maxCharacters:number;maxVoiceUsd:number};
async function main(){
 const cfg=JSON.parse((await unseal(`${ROOT}/production.json.sealed`)).toString()) as Config;
 const mode=readFileSync(`${ROOT}/mode`,'utf8').split('\n')[0].trim();
 const prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}`,project=`podcast-${cfg.episodeId}`;
 const total=cfg.chapters.reduce((a,c)=>a+c.text.length,0)+cfg.chapters.length*2;
 if(cfg.chapters.length!==12||total>cfg.maxCharacters||total*0.0002>cfg.maxVoiceUsd)throw Error('SCRIPT_BUDGET_INVALID');
 const {data:v,error:ve}=await db.from('podcast_episodes').select('voice_id,user_id').eq('id','a3b35bfb-6be5-4881-bd22-9a61a8598dfb').single();
 if(ve||v?.user_id!==cfg.ownerId||v?.voice_id!==cfg.voiceId)throw Error('APPROVED_VOICE_MISMATCH');
 for(const provider of ['elevenlabs','runway','heygen'] as const) await refreshProviderSnapshot(db,provider);
 const voiceReady=await ensureJobSupplyReady(db,[{provider:'elevenlabs',unit:'character',units:total,usd:Math.ceil(total*.0002*10000)/10000}]);
 const motionReady=await ensureJobSupplyReady(db,[{provider:'runway',unit:'usd',units:4,usd:4}]);
 const avatarReady=await ensureJobSupplyReady(db,[{provider:'heygen',unit:'usd',units:5,usd:5}]);
 log('PREFLIGHT',{voice:voiceReady,motion:motionReady,avatar:avatarReady,characters:total,voiceCapUsd:cfg.maxVoiceUsd});
 if(mode==='preflight'){seal('studio.png',await get(`${cfg.ownerId}/podcasts/${cfg.previousEpisodeId}/studio/composite-wide-2.png`));return;}
 if(mode!=='narrate')throw Error('UNKNOWN_MODE');
 if(!voiceReady.ready)throw Error('VOICE_CAPACITY_UNAVAILABLE');
 const {error:ee}=await db.from('podcast_episodes').upsert({id:cfg.episodeId,user_id:cfg.ownerId,title:'Crónicas y Misterios del Universo — Ep. 2: Travis Walton',language:'es',source:'upload',status:'draft'},{onConflict:'id',ignoreDuplicates:true});
 if(ee)throw Error('EPISODE_CREATE_FAILED');
 const identity=getVoiceIdentity('es',cfg.voiceId);
 const provider={name:'elevenlabs',synthesize:async(text:string,language:'es'|'en'='es',speed?:number)=>({...await synthesizeVoice(text,language,speed,cfg.voiceId),mimeType:'audio/mpeg',extension:'mp3'})};
 const deps={ledger:supabaseLedgerStore(db),results:supabaseResultStore(db,'videos'),voiceProvider:provider,voiceIdentity:identity,requestId:project};
 const manifest=[];
 for(let i=0;i<cfg.chapters.length;i+=2){
  const chapters=cfg.chapters.slice(i,i+2),id=`n${String(i/2+1).padStart(2,'0')}`,text=chapters.map(c=>c.text).join('\n\n');
  const {data:ops,error:oe}=await db.from('pi_paid_operations').select('status,reserved_usd,committed_usd').eq('project_id',project).eq('provider','elevenlabs').neq('status','REFUNDED');
  if(oe)throw Error('LEDGER_UNAVAILABLE');
  const spent=(ops??[]).reduce((a,o)=>a+Number(o.status==='COMMITTED'?o.committed_usd:o.reserved_usd),0);
  // Worst-case envelope remains below cap even if no block is reusable.
  if(spent+text.length*.0002>cfg.maxVoiceUsd)throw Error('VOICE_CAP_REACHED');
  const r=await gatedVoiceSynthesize({...deps,estimatedCostUsd:Math.ceil(text.length*.0002*10000)/10000},text,'es');
  const path=`${prefix}/narration/${id}.mp3`;
  const up=await bucket.upload(path,r.audioBuffer,{contentType:'audio/mpeg',upsert:true});if(up.error)throw Error('AUDIO_STORE_FAILED');
  const block={id,chapters,seconds:r.durationSeconds,words:r.words,path,sha256:hash(r.audioBuffer)};
  const meta=await bucket.upload(`${prefix}/narration/${id}.json`,Buffer.from(JSON.stringify(block)),{contentType:'application/json',upsert:true});if(meta.error)throw Error('TIMINGS_STORE_FAILED');
  manifest.push(block);seal(`${id}.mp3`,r.audioBuffer);seal(`${id}.json`,Buffer.from(JSON.stringify(block)));
  log('NARRATED',{id,seconds:r.durationSeconds,characters:text.length,reused:r.reused});
 }
 const bytes=Buffer.from(JSON.stringify({episodeId:cfg.episodeId,blocks:manifest}));
 const m=await bucket.upload(`${prefix}/narration-manifest.json`,bytes,{contentType:'application/json',upsert:true});if(m.error)throw Error('MANIFEST_STORE_FAILED');
 seal('manifest.json',bytes);log('NARRATION_COMPLETE',{blocks:manifest.length,seconds:manifest.reduce((s,b)=>s+b.seconds,0)});
}
main().catch(e=>{console.error('STOP',e instanceof Error?e.message.slice(0,180):'unknown');process.exitCode=1;});
