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
 await fs.writeFile(path.join(out,'preflight.json'),JSON.stringify(report,null,2));console.log('@@DULCE_PREFLIGHT '+JSON.stringify({stage,pilotCached:true,neededCharacters:needed,quotaSufficient:remain>=needed,references:references.length,shots:spec.shots.length}));
 if(stage==='preflight')return;
 if(stage==='narrate'){
   // The approved full episode may use its included quota. No automatic retries.
   if(remain<needed)throw Error('Insufficient quota for approved narration');
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
 if(stage==='images'){
   const wanted=(process.env.DULCE_SHOTS||'').split(',').filter(Boolean);
   if(!wanted.length||wanted.length>12)throw Error('Select 1-12 reference images for review');
   const tiles=[];
   for(const id of wanted){
     const shot=spec.shots.find((s:{shotId:string})=>s.shotId===id);
     if(!shot?.newImageRequired)throw Error('Invalid new reference '+id);
     const dest=`${PREFIX}/refs/${id}.png`,metaPath=`${PREFIX}/refs/${id}.json`;
     let bytes=await read(dest);
     if(!bytes){
       const refs:Buffer[]=[];
       const keys:string[]=[];
       for(const key of shot.referenceKeys as string[]){
         const original=references.find(r=>r.id===key);
         if(original){const b=await read(original.path);if(b){refs.push(b);keys.push(key);}}
       }
       // Family master is an existing planned shot, not an extra paid design.
       // Its approval must be durable before any dependent family image.
       if(id!=='D09-06' && (Number(id.slice(1,3))>=9||id.startsWith('D02-'))){
         const approved=await read(`${PREFIX}/reviews/D09-06.json`);
         if(!approved||JSON.parse(approved.toString()).status!=='approved')throw Error('Family master requires human-visible review first');
         const b=await read(`${PREFIX}/refs/D09-06.png`);if(!b)throw Error('Missing family master');refs.push(b);keys.push('family-master');
       }
       const prompt=shot.imagePrompt+'\nCHARACTERS AND SETS:\n'+Object.entries(spec.visualBible).map(([k,v])=>k+': '+v).join('\n')+'\nDepict only people and objects called for in this shot, not a collage or character sheet. Castello is the man in the attached d02 reference. No duplicate people. No threatening or disturbing content involving the child.';
       const key='image-'+id+'-v1';await claim(key,.15,'image');
       const form=new FormData();form.set('model','gpt-image-2');form.set('prompt',prompt);form.set('size','1536x1024');form.set('quality','medium');form.set('n','1');
       refs.slice(0,3).forEach((b,i)=>form.append('image[]',new Blob([new Uint8Array(b)],{type:'image/png'}),`reference-${i}.png`));
       const endpoint=refs.length?'edits':'generations';
       const headers:Record<string,string>={Authorization:`Bearer ${process.env.OPENAI_API_KEY}`};
       const body=refs.length?form:JSON.stringify({model:'gpt-image-2',prompt,size:'1536x1024',quality:'medium',n:1});if(!refs.length)headers['Content-Type']='application/json';
       const response=await fetch('https://api.openai.com/v1/images/'+endpoint,{method:'POST',headers,body,signal:AbortSignal.timeout(180000)});
       if(!response.ok)throw Error('Image request HTTP '+response.status+'; preserve claim, no automatic resend');
       const result=await response.json() as {data?:{b64_json?:string}[];usage?:unknown};if(!result.data?.[0]?.b64_json)throw Error('Image response missing bytes; cost uncertain');
       bytes=Buffer.from(result.data[0].b64_json,'base64');const dims=await sharp(bytes).metadata();if(!dims.width||!dims.height)throw Error('Invalid image');
       await fs.writeFile(path.join(out,id+'.png'),bytes);
       await put(dest,bytes,'image/png');await writeJson(metaPath,{shotId:id,sha256:sha(bytes),width:dims.width,height:dims.height,references:keys,usage:result.usage,reservedUsd:.15,costBasis:'reserve_not_invoice',review:'pending'});
     }
     await fs.writeFile(path.join(out,id+'.png'),bytes);tiles.push({image:bytes,label:id});
     console.log('@@DULCE_IMAGE '+JSON.stringify({id,sha256:sha(bytes)}));
   }
   await fs.writeFile(path.join(out,'references-review.jpg'),await buildContactSheet(tiles,{columns:2,tileWidth:640,tileHeight:360,title:'Dulce - references awaiting visual review'}));return;
 }
 throw Error('Unimplemented stage '+stage);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Dulce stopped');process.exitCode=1;});
