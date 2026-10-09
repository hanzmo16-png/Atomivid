import { createClient } from '@supabase/supabase-js';
import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { getVoiceIdentity, synthesizeVoice } from '../../src/lib/ai/voice';
import { gatedVoiceSynthesize } from '../../src/lib/paid-calls/gated-providers';
import { supabaseLedgerStore } from '../../src/lib/paid-calls/supabase-ledger-store';
import { supabaseResultStore } from '../../src/lib/paid-calls/result-store';
import { ensureJobSupplyReady } from '../../src/lib/supply/readiness';

// Owner-requested season-two trailer. Reuse existing motion; one gated voice call.
// Nothing private is printed: delivery is authenticated AES-GCM + RSA-OAEP.
const project = 'cronicas-season2-teaser-15-v1';
const text = 'Hay historias que no te dejan dormir… Esta es una de ellas. Crónicas y Misterios del Universo. Segunda temporada. Próximamente.';
const usd = Math.ceil(text.length * 0.0002 * 10000) / 10000;
async function main() {
  if (usd > 0.04) throw Error('VOICE_CAP_EXCEEDED');
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const {data: identity, error: ie} = await db.from('podcast_episodes').select('voice_id,user_id').eq('id','a3b35bfb-6be5-4881-bd22-9a61a8598dfb').single();
  const {data: episode, error: ee} = await db.from('podcast_episodes').select('user_id').eq('id','922615a5-9673-42c0-8b6e-5f3a60193b18').single();
  if (ie || ee || !identity?.voice_id || episode?.user_id !== identity.user_id) throw Error('APPROVED_OWNER_VOICE_NOT_FOUND');
  const bucket = db.storage.from('videos');
  const prefix = `${episode.user_id}/podcasts/922615a5-9673-42c0-8b6e-5f3a60193b18/motion`;
  const clips: Record<string,string> = {};
  for (const name of ['ia01','ia02','ia03','ia04','ia05','ia08']) {
    const path = `${prefix}/${name}.mp4`;
    // Confirm source exists before generating any paid narration.
    const found = await bucket.list(prefix, {search: `${name}.mp4`, limit: 10});
    if (found.error || !found.data.some(x=>x.name===`${name}.mp4`)) throw Error('SOURCE_CLIP_MISSING');
    const r = await bucket.createSignedUrl(path, 7200);
    if (r.error || !r.data?.signedUrl) throw Error('SOURCE_SIGN_FAILED');
    clips[name] = r.data.signedUrl;
  }
  const ready = await ensureJobSupplyReady(db,[{provider:'elevenlabs',unit:'character',units:text.length,usd}],{refresh:true});
  if (!ready.ready) throw Error('VOICE_SUPPLY_NOT_READY');
  const {data: ops,error: oe} = await db.from('pi_paid_operations').select('status,reserved_usd,committed_usd').eq('project_id',project).neq('status','REFUNDED');
  if (oe || (ops??[]).reduce((n,o)=>n+Number(o.status==='COMMITTED'?o.committed_usd:o.reserved_usd),0)>0.04) throw Error('PROJECT_CAP_EXCEEDED');
  const voiceId=identity.voice_id;
  const result=await gatedVoiceSynthesize({ledger:supabaseLedgerStore(db),results:supabaseResultStore(db,'videos'),requestId:project,
    voiceIdentity:getVoiceIdentity('es',voiceId),estimatedCostUsd:usd,
    voiceProvider:{name:'elevenlabs',synthesize:async(t,l='es',speed)=>({...await synthesizeVoice(t,l,speed,voiceId),mimeType:'audio/mpeg',extension:'mp3'})}},text,'es');
  const payload=Buffer.from(JSON.stringify({clips,text,voice:result.audioBuffer.toString('base64'),words:result.words,voiceSeconds:result.durationSeconds,costUsd:result.costUsd,reused:result.reused}));
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const ct=Buffer.concat([cipher.update(payload),cipher.final()]);
  const ek=publicEncrypt({key:readFileSync('scripts/season2-teaser/delivery-public.pem'),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
  writeFileSync('season2-delivery.sealed',[ek,iv,cipher.getAuthTag(),ct].map(x=>x.toString('base64')).join('.'));
  console.log(JSON.stringify({ready:true,clips:Object.keys(clips).length,voiceSeconds:result.durationSeconds,costUsd:result.costUsd,reused:result.reused}));
}
main().catch(()=>{ console.error('TEASER_PREPARATION_FAILED: inspect private data and ledger; do not blindly retry paid calls'); process.exitCode=1; });
