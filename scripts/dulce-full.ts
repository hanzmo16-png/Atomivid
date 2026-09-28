/** Isolated, explicitly authorized Dulce production. Paid operations require stage + flag.
 * Unique durable claims prevent blind resubmissions after interruption.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServiceClient} from '../src/lib/supabase/service';
import {getVoiceIdentity} from '../src/lib/ai/voice';
import {getVoiceProvider} from '../src/lib/providers/voice';
import {computeTtsCacheKey} from '../src/lib/video/long-form/tts-cache';
import {loadProductionCachedBeatNarration,synthesizeBeatNarrationProductionCached} from '../src/lib/video/long-form/production-tts-cache';
import {getVideoProvider} from '../src/lib/providers/video-gen';
import {wrapDurableVideoProvider} from '../src/lib/video/long-form/ai-video-durable-provider';
import {buildContactSheet} from './lib/contact-sheet';
import sharp from 'sharp';

const ID='dulce-001', PREFIX='dulce-001/full-v1', CEILING=55;
const out=process.env.DULCE_OUT||'/tmp/dulce-full';
const stage=process.env.DULCE_STAGE||'preflight';
const service=createServiceClient(),bucket=service.storage.from('videos');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const read=async(p:string)=>{const {data,error}=await bucket.download(p,{cacheNonce:randomUUID()},{cache:'no-store'});if(error){if(String(error.statusCode)==='404'||error.message.includes('not found'))return null;throw Error('Storage read failed '+p+': '+error.message);}return data?Buffer.from(await data.arrayBuffer()):null;};
const put=async(p:string,b:Buffer,type:string,upsert=true)=>{const {error}=await bucket.upload(p,b,{contentType:type,upsert,cacheControl:'0'});if(error)throw Error('Storage write failed '+p+': '+error.message);};
const writeJson=async(p:string,v:unknown,upsert=true)=>put(p,Buffer.from(JSON.stringify(v,null,2)),'application/json',upsert);
type Entry={key:string;amount:number;status:string;kind:string};
let ledger:{entries:Entry[]}={entries:[]};
const committed=()=>ledger.entries.reduce((a,e)=>a+e.amount,0);
async function claim(key:string,amount:number,kind:string){
 if(process.env.DULCE_ALLOW_PAID!=='true')throw Error('Paid authorization missing');
 if(!Number.isFinite(amount)||amount<=0||committed()+amount>CEILING)throw Error('Episode budget exceeded');
 if(ledger.entries.some(e=>e.key===key))throw Error('Existing paid claim: reconcile rather than resend '+key);
 await writeJson(`${PREFIX}/claims/${key}.json`,{key,amount,kind,time:new Date().toISOString()},false);
 ledger.entries.push({key,amount,status:'committed',kind});await writeJson(`${PREFIX}/ledger.json`,ledger);
}
async function main(){
 await fs.mkdir(out,{recursive:true});
 const script=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-script.json','utf8')) as {meta:unknown;beats:{id:string;narration:string}[]};
 const spec=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-shots.json','utf8'));
 const lb=await read(`${PREFIX}/ledger.json`);if(lb)ledger=JSON.parse(lb.toString());
 const identity=getVoiceIdentity('en');if(identity.voiceId!=='nPczCjzI2devNBz1zQrb')throw Error('Brian identity mismatch');
 const reqs=script.beats.map(b=>({beat:b,key:computeTtsCacheKey({videoId:ID,beatId:b.id,text:b.narration,...identity,language:'en',providerName:'elevenlabs'})}));
 const narration=[];
 for(const r of reqs){const raw=await read(`long-form/${ID}/state/tts/${r.key}.json`);const record=raw?JSON.parse(raw.toString()):null;narration.push({...r,status:record?.status||'missing',chars:r.beat.narration.length});}
 const sub=await fetch('https://api.elevenlabs.io/v1/user/subscription',{headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY||''}});if(!sub.ok)throw Error('Cannot verify voice quota HTTP '+sub.status);
 const quota=await sub.json() as {character_count:number;character_limit:number};
 const remain=quota.character_limit-quota.character_count;
 const needed=narration.filter(r=>r.status!=='COMPLETED').reduce((a,r)=>a+r.chars,0);
 if(narration[0].status!=='COMPLETED')throw Error('Approved pilot narration missing: do not regenerate');
 const references=[];
 for(const id of ['d01','d02','d03','d04']){const p=`dulce-001/samples/pilot/ai/dulce-${id}-v1-still.png`;const b=await read(p);if(!b)throw Error('Reference missing '+id);await fs.writeFile(path.join(out,`${id}.png`),b);references.push({id,path:p,sha256:sha(b)});}
 const report={stage,voice:identity.voiceId,narration:narration.map(r=>({id:r.beat.id,status:r.status,chars:r.chars})),neededCharacters:needed,voiceCharactersRemaining:remain,committedUsd:committed(),newCeiling:CEILING,references,shots:spec.shots.length};
 await fs.writeFile(path.join(out,'preflight.json'),JSON.stringify(report,null,2));console.log('@@DULCE_PREFLIGHT '+JSON.stringify({stage,pilotCached:true,neededCharacters:needed,quotaSufficient:remain>=needed+3000,references:references.length,shots:spec.shots.length}));
 if(stage==='preflight')return;
 if(stage==='narrate'){
   if(remain<needed+3000)throw Error('Insufficient quota plus reserve');
   if(narration.some(r=>r.status==='STARTED'))throw Error('Unresolved voice generation; do not resend');
   const provider=getVoiceProvider();if(provider.name!=='elevenlabs')throw Error('Real voice unavailable');
   const results=[];
   for(const r of narration){
     let n;
     if(r.status==='COMPLETED')n=await loadProductionCachedBeatNarration(service,'elevenlabs',r.beat,'en',{videoId:ID,voiceIdentity:identity});
     else{await claim('tts-'+r.key,Math.ceil(r.chars*.0003*10000)/10000,'voice');n=await synthesizeBeatNarrationProductionCached(service,provider,r.beat,'en',{videoId:ID,voiceIdentity:identity});}
     await fs.writeFile(path.join(out,r.beat.id+'.'+n.extension),n.audioBuffer);
     const meta={beatId:r.beat.id,durationSeconds:n.durationSeconds,words:n.words,sha256:sha(n.audioBuffer),key:r.key};
     await writeJson(`${PREFIX}/narration/${r.beat.id}.json`,meta);results.push(meta);
     console.log('@@DULCE_VOICE '+JSON.stringify({id:r.beat.id,seconds:n.durationSeconds,reused:r.status==='COMPLETED'}));
   }
   await fs.writeFile(path.join(out,'narration.json'),JSON.stringify(results,null,2));
   console.log('@@DULCE_DURATION '+results.reduce((a,n)=>a+n.durationSeconds,0));return;
 }
 throw Error('Unimplemented stage '+stage);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Dulce stopped');process.exitCode=1;});
