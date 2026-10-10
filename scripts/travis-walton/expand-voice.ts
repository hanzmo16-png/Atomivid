/** Additional narration only; preserves the existing voice, limits and paid-call ledger. */
import { createClient } from '@supabase/supabase-js';
import { createHash, privateDecrypt, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { refreshProviderSnapshot } from '../../src/lib/supply/monitor';
import { ensureJobSupplyReady } from '../../src/lib/supply/readiness';
import { gatedVoiceSynthesize } from '../../src/lib/paid-calls/gated-providers';
import { supabaseLedgerStore } from '../../src/lib/paid-calls/supabase-ledger-store';
import { supabaseResultStore } from '../../src/lib/paid-calls/result-store';
import { getVoiceIdentity, synthesizeVoice } from '../../src/lib/ai/voice';

export async function expandVoice(cfg:any,seal:(name:string,b:Buffer)=>void){
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const bucket=db.storage.from('videos'),project=`podcast-${cfg.episodeId}`;
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const get=async(path:string)=>{const r=await bucket.download(path);if(r.error||!r.data)throw Error('EXPANSION_SOURCE_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());};
 const put=async(path:string,b:Buffer)=>{
  const old=await bucket.download(path);if(old.data){if(sha(Buffer.from(await old.data.arrayBuffer()))!==sha(b))throw Error('EXPANSION_IMMUTABLE_MISMATCH');return;}
  const r=await bucket.upload(path,b,{contentType:path.endsWith('.mp3')?'audio/mpeg':'application/json',upsert:false});if(r.error)throw Error('EXPANSION_STORE_FAILED');
  if(sha(await get(path))!==sha(b))throw Error('EXPANSION_STORE_VERIFY_FAILED');
 };
 const pem=await get('ops/podcast-episode/runner-key.pem');
 const [ek,iv,tag,ct]=readFileSync('ops/travis-walton/expansion.json.sealed','utf8').trim().split('.').map(x=>Buffer.from(x,'base64'));
 const key=privateDecrypt({key:pem,oaepHash:'sha256'},ek),d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);
 const bytes=Buffer.concat([d.update(ct),d.final()]),plan=JSON.parse(bytes.toString());
 if(plan.episodeId!==cfg.episodeId||plan.targetVersion!==5||plan.targetSeconds!==1800||plan.chapters.length!==8)throw Error('EXPANSION_PLAN_INVALID');
 const total=plan.chapters.reduce((s:number,c:any)=>s+c.text.length,0),cost=total*.0002;
 if(total>17000||cost>plan.maxNewVoiceUsd||plan.maxNewVoiceUsd>4)throw Error('EXPANSION_BUDGET_INVALID');
 const {data:v,error:ve}=await db.from('podcast_episodes').select('voice_id,user_id').eq('id','a3b35bfb-6be5-4881-bd22-9a61a8598dfb').single();
 if(ve||v?.user_id!==cfg.ownerId||v?.voice_id!==cfg.voiceId)throw Error('EXPANSION_VOICE_MISMATCH');
 const {data:ops,error:oe}=await db.from('pi_paid_operations').select('status,reserved_usd,committed_usd').eq('project_id',project).eq('provider','elevenlabs').neq('status','REFUNDED');
 if(oe)throw Error('EXPANSION_LEDGER_UNAVAILABLE');
 const spent=(ops??[]).reduce((a,o)=>a+Number(o.status==='COMMITTED'?o.committed_usd:o.reserved_usd),0);
 const prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}/expansion-30/${sha(bytes).slice(0,16)}`;
 const completed:any[]=[];
 for(const c of plan.chapters){const old=await bucket.download(`${prefix}/${c.id}.json`);if(old.data){const m=JSON.parse(await old.data.text());if(m.textSha256!==sha(Buffer.from(c.text)))throw Error('EXPANSION_TEXT_MISMATCH');completed.push(m);}}
 const todo=plan.chapters.filter((c:any)=>!completed.some(m=>m.id===c.id));
 const remaining=todo.reduce((s:number,c:any)=>s+c.text.length*.0002,0);
 console.log('EXPANSION_VOICE_PREFLIGHT',JSON.stringify({characters:total,newVoiceEstimateUsd:cost,spentVoiceUsd:spent,originalVoiceCapUsd:cfg.maxVoiceUsd,remainingEstimateUsd:remaining,reusableBlocks:completed.length}));
 if(spent+remaining>cfg.maxVoiceUsd+.00001)throw Error('ORIGINAL_VOICE_CAP_WOULD_BE_EXCEEDED');
 await refreshProviderSnapshot(db,'elevenlabs');
 const ready=await ensureJobSupplyReady(db,[{provider:'elevenlabs',unit:'character',units:todo.reduce((s:number,c:any)=>s+c.text.length,0),usd:remaining}]);
 if(todo.length&&!ready.ready)throw Error('EXPANSION_SUPPLY_UNAVAILABLE');
 await put(`${prefix}/plan.json`,bytes);
 const provider={name:'elevenlabs',synthesize:async(text:string,language:'es'|'en'='es',speed?:number)=>({...await synthesizeVoice(text,language,speed,cfg.voiceId),mimeType:'audio/mpeg',extension:'mp3'})};
 const deps={ledger:supabaseLedgerStore(db),results:supabaseResultStore(db,'videos'),voiceProvider:provider,voiceIdentity:getVoiceIdentity('es',cfg.voiceId),requestId:project};
 const blocks=[];
 for(const c of plan.chapters){
  const prior=completed.find(m=>m.id===c.id);
  if(prior){if(sha(await get(prior.path))!==prior.sha256)throw Error('EXPANSION_PRIOR_HASH');blocks.push(prior);continue;}
  const r=await gatedVoiceSynthesize({...deps,estimatedCostUsd:Math.ceil(c.text.length*.0002*10000)/10000},c.text,'es');
  const path=`${prefix}/${c.id}.mp3`;await put(path,r.audioBuffer);
  const block={...c,path,seconds:r.durationSeconds,words:r.words,sha256:sha(r.audioBuffer),textSha256:sha(Buffer.from(c.text))};
  await put(`${prefix}/${c.id}.json`,Buffer.from(JSON.stringify(block)));blocks.push(block);
  console.log('EXPANSION_NARRATED',JSON.stringify({id:c.id,seconds:r.durationSeconds,reused:r.reused}));
 }
 const manifest={...plan,privatePrefix:prefix,blocks,totalSeconds:blocks.reduce((s,b)=>s+b.seconds,0),estimatedVoiceUsd:cost};
 const output=Buffer.from(JSON.stringify(manifest));await put(`${prefix}/manifest.json`,output);seal('expansion-voice-manifest.json',output);
 console.log('EXPANSION_VOICE_COMPLETE',JSON.stringify({blocks:blocks.length,seconds:manifest.totalSeconds,newVoiceEstimateUsd:cost,capUnchanged:true}));
}
