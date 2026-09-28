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
import {buildContactSheet,frameAt,probeDuration} from './lib/contact-sheet';
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
let mutationQueue:Promise<unknown>=Promise.resolve();
function serial<T>(fn:()=>Promise<T>):Promise<T>{const next=mutationQueue.then(fn);mutationQueue=next;return next;}
const committed=()=>ledger.entries.reduce((a,e)=>a+e.amount,0);
async function claim(key:string,amount:number,kind:string){return serial(async()=>{
 if(process.env.DULCE_ALLOW_PAID!=='true')throw Error('Paid authorization missing');
 if(!Number.isFinite(amount)||amount<=0||committed()+amount>CEILING-1)throw Error('Episode budget exceeded');
 if(ledger.entries.some(e=>e.key===key))throw Error('Existing paid claim: reconcile rather than resend '+key);
 await writeJson(`${PREFIX}/claims/${key}.json`,{key,amount,kind,time:new Date().toISOString()},false);
 ledger.entries.push({key,amount,status:'committed',kind});await writeJson(`${PREFIX}/ledger.json`,ledger);
});}
async function main(){
 await fs.mkdir(out,{recursive:true});
 const script=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-script.json','utf8')) as {meta:unknown;beats:{id:string;narration:string}[]};
 const spec=JSON.parse(await fs.readFile('content/long-form/dulce-001/full-shots.json','utf8'));
 const lb=await read(`${PREFIX}/ledger.json`);if(lb)ledger=JSON.parse(lb.toString());
 // A recorded explicit credit-balance rejection produced no asset and incurred no generation charge.
 let reconciledQuota=false;
 for(const e of ledger.entries.filter(e=>e.kind==='image'&&e.status==='committed')){
   const raw=await read(`${PREFIX}/errors/${e.key}.json`);if(!raw)continue;
   const failure=JSON.parse(raw.toString());let detail;try{detail=JSON.parse(failure.detail);}catch{continue;}
   if(failure.status===429&&detail?.error?.code==='credit_balance_exhausted'){
     e.amount=0;e.status='rejected_credit_balance_no_generation';reconciledQuota=true;
   }
 }
 if(reconciledQuota)await writeJson(`${PREFIX}/ledger.json`,ledger);
 const identity=getVoiceIdentity('en');if(identity.voiceId!=='nPczCjzI2devNBz1zQrb')throw Error('Brian identity mismatch');
 const reqs=script.beats.map(b=>({beat:b,key:computeTtsCacheKey({videoId:ID,beatId:b.id,text:b.narration,...identity,language:'en',providerName:'elevenlabs'})}));
 const narration=[];
 for(const r of reqs){const raw=await read(`long-form/${ID}/state/tts/${r.key}.json`);const record=raw?JSON.parse(raw.toString()):null;narration.push({...r,status:record?.status||'missing',chars:r.beat.narration.length});}
 const sub=await fetch('https://api.elevenlabs.io/v1/user/subscription',{headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY||''}});if(!sub.ok)throw Error('Cannot verify voice quota HTTP '+sub.status);
 const quota=await sub.json() as {character_count:number;character_limit:number};
 const remain=quota.character_limit-quota.character_count;
 const needed=narration.filter(r=>r.status!=='COMPLETED').reduce((a,r)=>a+r.chars,0);
 if(narration[0].status!=='COMPLETED')throw Error('Approved pilot narration missing: do not regenerate');
 const references:{id:string;path:string;sha256:string}[]=[];
 for(const id of ['d01','d02','d03','d04']){const p=`dulce-001/samples/pilot/ai/dulce-${id}-v1-still.png`;const b=await read(p);if(!b)throw Error('Reference missing '+id);await fs.writeFile(path.join(out,`${id}.png`),b);references.push({id,path:p,sha256:sha(b)});}
 const report={stage,voice:identity.voiceId,narration:narration.map(r=>({id:r.beat.id,status:r.status,chars:r.chars})),neededCharacters:needed,voiceCharactersRemaining:remain,committedUsd:committed(),newCeiling:CEILING,references,shots:spec.shots.length};
 await fs.writeFile(path.join(out,'preflight.json'),JSON.stringify(report,null,2));console.log('@@DULCE_PREFLIGHT '+JSON.stringify({stage,pilotCached:true,neededCharacters:needed,quotaSufficient:remain>=needed,references:references.length,shots:spec.shots.length}));
 if(stage==='preflight'){
   const ids=(process.env.DULCE_SHOTS||'').split(',').filter(Boolean);const inspection=[];
   if(ids.length>12)throw Error('At most 12 existing references');
   for(const id of ids){if(!spec.shots.some((s:{shotId:string})=>s.shotId===id))throw Error('Unknown reference');const b=await read(`${PREFIX}/refs/${id}.png`);if(!b)throw Error('Reference not yet generated '+id);await fs.writeFile(path.join(out,id+'.jpg'),await sharp(b).jpeg({quality:95}).toBuffer());inspection.push({shotId:id,sha256:sha(b)});}
   await fs.writeFile(path.join(out,'inspected-references.json'),JSON.stringify(inspection,null,2));
   if(ids.length)for(const id of ['elevenlabs-tension-1','elevenlabs-tension-2','elevenlabs-reflective-1']){const {data,error}=await service.storage.from('music-library').download(id+'.mp3');if(error||!data)throw Error('Music missing '+id);await fs.writeFile(path.join(out,id+'.mp3'),Buffer.from(await data.arrayBuffer()));}
   return;
 }
 if(['images','animate','music','approve'].includes(stage))for(const r of references)await fs.unlink(path.join(out,r.id+'.png'));
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
 if(['approve','images','animate'].includes(stage)){
   const approvals=JSON.parse(await fs.readFile('content/long-form/dulce-001/approved-references.json','utf8')) as {shotId:string;sha256:string;note:string}[];
   for(const a of approvals){const b=await read(`${PREFIX}/refs/${a.shotId}.png`);if(!b||sha(b)!==a.sha256)throw Error('Review checksum mismatch '+a.shotId);await writeJson(`${PREFIX}/reviews/${a.shotId}.json`,{...a,status:'approved',reviewer:'assistant visual inspection',at:new Date().toISOString()});}
   console.log('@@DULCE_APPROVED '+approvals.length);if(stage==='approve')return;
 }
 if(stage==='images'){
   const wanted=(process.env.DULCE_SHOTS||'').split(',').filter(Boolean);
   if(!wanted.length||wanted.length>12)throw Error('Select 1-12 reference images for review');
   const tiles:{image:Buffer;label:string}[]=[];
   let nextIndex=0;
   const make=async(id:string)=>{
     const shot=spec.shots.find((s:{shotId:string})=>s.shotId===id);
     if(!shot?.newImageRequired)throw Error('Invalid new reference '+id);
     const dest=`${PREFIX}/refs/${id}.png`,metaPath=`${PREFIX}/refs/${id}.json`;
     let bytes=await read(dest);
     if(bytes&&shot.replaceReferenceSha256===sha(bytes)){await put(`${PREFIX}/refs/superseded/${id}-${sha(bytes)}.png`,bytes,'image/png');bytes=null;}
     if(!bytes){
       const refs:Buffer[]=[];
       const keys:string[]=[];
       for(const key of shot.referenceKeys as string[]){
         const original=references.find(r=>r.id===key);
         if(original){const b=await read(original.path);if(!b)throw Error('Missing original '+key);refs.push(b);keys.push(key);}
         else {
           const approved=await read(`${PREFIX}/reviews/${key}.json`);
           const b=await read(`${PREFIX}/refs/${key}.png`);
           if(!approved||!b||JSON.parse(approved.toString()).status!=='approved'||JSON.parse(approved.toString()).sha256!==sha(b))throw Error('Reference requires visual review '+key);
           refs.push(b);keys.push(key);
         }
       }
       const prompt=shot.imagePrompt+'\nRELEVANT CHARACTERS AND SETS:\n'+(shot.contextKeys as string[]).map(k=>k+': '+spec.visualBible[k]).join('\n')+'\n'+shot.imagePromptExtra+'\nAttached references in order: '+keys.join(', ')+'. Use each only for the relevant identity or setting. Depict only the requested people and objects. Single cinematic starting frame, not a collage. No text, no watermark. Natural anatomy.';
       const key='image-'+id+'-'+(shot.imageRevision||'v1');await claim(key,.30,'image');
       const form=new FormData();form.set('model','gpt-image-2');form.set('prompt',prompt);form.set('size','1536x1024');form.set('quality','medium');form.set('n','1');
       refs.forEach((b,i)=>form.append('image[]',new Blob([new Uint8Array(b)],{type:'image/png'}),`reference-${i}.png`));
       const endpoint=refs.length?'edits':'generations';
       const headers:Record<string,string>={Authorization:`Bearer ${process.env.OPENAI_API_KEY}`};
       const body=refs.length?form:JSON.stringify({model:'gpt-image-2',prompt,size:'1536x1024',quality:'medium',n:1});if(!refs.length)headers['Content-Type']='application/json';
       const response=await fetch('https://api.openai.com/v1/images/'+endpoint,{method:'POST',headers,body,signal:AbortSignal.timeout(180000)});
       if(!response.ok){const detail=await response.text();await writeJson(`${PREFIX}/errors/${key}.json`,{status:response.status,detail,requestId:response.headers.get('x-request-id')});await fs.writeFile(path.join(out,key+'-error.json'),JSON.stringify({status:response.status,detail}));throw Error('Image request '+id+' HTTP '+response.status+'; preserve claim, no automatic resend');}
       const result=await response.json() as {data?:{b64_json?:string}[];usage?:{input_tokens?:number;output_tokens?:number;input_tokens_details?:{text_tokens?:number;image_tokens?:number}}};if(!result.data?.[0]?.b64_json)throw Error('Image response missing bytes; cost uncertain');
       bytes=Buffer.from(result.data[0].b64_json,'base64');const dims=await sharp(bytes).metadata();if(!dims.width||!dims.height)throw Error('Invalid image');
       await fs.writeFile(path.join(out,id+'.png'),bytes);
       await put(dest,bytes,'image/png');
       const u=result.usage;
       // Deliberately conservative upper estimate; retained usage permits billing reconciliation.
       const upper=u&&Number.isFinite(u.output_tokens)?((u.input_tokens_details?.text_tokens??u.input_tokens??0)*5+(u.input_tokens_details?.image_tokens??0)*10+u.output_tokens!*40)/1e6:null;
       await writeJson(metaPath,{shotId:id,sha256:sha(bytes),width:dims.width,height:dims.height,references:keys,usage:u,reservedUsd:.30,upperEstimateUsd:upper,costBasis:'conservative_usage_estimate_not_invoice',review:'pending'});
       await serial(async()=>{const entry=ledger.entries.find(e=>e.key===key)!;entry.amount=upper??entry.amount;entry.status='completed';await writeJson(`${PREFIX}/ledger.json`,ledger);});
       if(committed()>CEILING||upper===null)throw Error('Image saved; reconcile usage before next batch');
     }
     await fs.writeFile(path.join(out,id+'.png'),bytes);tiles.push({image:bytes,label:id});
     console.log('@@DULCE_IMAGE '+JSON.stringify({id,sha256:sha(bytes)}));
   };
   const workers=Array.from({length:Math.min(3,wanted.length)},async()=>{while(nextIndex<wanted.length){const id=wanted[nextIndex++];await make(id);}});
   const completed=await Promise.allSettled(workers);
   tiles.sort((a,b)=>a.label.localeCompare(b.label));
   await fs.writeFile(path.join(out,'references-review.jpg'),await buildContactSheet(tiles,{columns:2,tileWidth:640,tileHeight:360,title:'Dulce - references awaiting visual review'}));
   await fs.writeFile(path.join(out,'ledger.json'),JSON.stringify(ledger,null,2));
   for(const r of completed)if(r.status==='rejected')throw r.reason;return;
 }

 if(stage==='animate'){
   const wanted=(process.env.DULCE_SHOTS||'').split(',').filter(Boolean);
   if(!wanted.length||wanted.length>12||new Set(wanted).size!==wanted.length)throw Error('Select 1-12 unique clips');
   const provider=getVideoProvider('runway');if(provider.name!=='runway')throw Error('Runway provider unavailable');
   const durable=wrapDurableVideoProvider(provider,{supabase:service,scopeId:'dulce-001-full-v1',executionMode:'real',maxInAttemptResumes:2,beforeSubmit:async(req)=>{await claim(req.metadata!.claimKey,.5,'video');return true;}});
   const tiles:{image:Buffer;label:string}[]=[];let nextIndex=0;
   const make=async(id:string)=>{
     const shot=spec.shots.find((s:{shotId:string})=>s.shotId===id);
     if(!shot||shot.reuse||shot.requestSeconds!==10)throw Error('Invalid animation '+id);
     const ref=await read(shot.newImageRequired?`${PREFIX}/refs/${id}.png`:shot.existingStillPath);if(!ref)throw Error('Missing image '+id);
     if(shot.newImageRequired){const review=await read(`${PREFIX}/reviews/${id}.json`);if(!review||JSON.parse(review.toString()).sha256!==sha(ref)||JSON.parse(review.toString()).status!=='approved')throw Error('Image not visually approved '+id);}
     const jpeg=await sharp(ref).resize(1280,720,{fit:'cover',position:'centre'}).jpeg({quality:92}).toBuffer();
     const rev=shot.animationRevision||'v1',claimKey='video-'+id+'-'+rev;
     const asset=await durable.generateVideo({prompt:shot.animationPrompt,aspectRatio:'16:9',durationSeconds:10,maxCostUsd:.5,referenceImageUrl:'data:image/jpeg;base64,'+jpeg.toString('base64'),metadata:{shotId:rev==='v1'?id:id+'-'+rev,videoId:ID,claimKey}});
     const file=path.join(out,id+'.mp4');await fs.writeFile(file,asset.buffer);
     const duration=await probeDuration(file);if(duration<shot.editSeconds+.2)throw Error('Clip too short '+id);
     const meta={shotId:id,sha256:sha(asset.buffer),providerJobId:asset.providerJobId,durationSeconds:duration,referenceSha256:sha(ref),model:asset.model,review:'pending'};
     await writeJson(`${PREFIX}/clips/${id}.json`,meta);await fs.writeFile(path.join(out,id+'.json'),JSON.stringify(meta,null,2));
     await serial(async()=>{const entry=ledger.entries.find(e=>e.key===claimKey);if(entry)entry.status='completed';await writeJson(`${PREFIX}/ledger.json`,ledger);});
     for(const t of [0.5,4.5,8.5])tiles.push({image:await frameAt(file,t,640),label:id+' @ '+t+'s'});
     console.log('@@DULCE_CLIP '+JSON.stringify(meta));
   };
   const completed=await Promise.allSettled(Array.from({length:Math.min(3,wanted.length)},async()=>{while(nextIndex<wanted.length)await make(wanted[nextIndex++]);}));
   tiles.sort((a,b)=>a.label.localeCompare(b.label));await fs.writeFile(path.join(out,'clips-review.jpg'),await buildContactSheet(tiles,{columns:3,tileWidth:480,tileHeight:270,title:'Dulce - generated motion review'}));
   await fs.writeFile(path.join(out,'ledger.json'),JSON.stringify(ledger,null,2));
   for(const r of completed)if(r.status==='rejected')throw r.reason;return;
 }
 if(stage==='music'){
   for(const id of ['elevenlabs-tension-1','elevenlabs-tension-2','elevenlabs-reflective-1']){const {data,error}=await service.storage.from('music-library').download(id+'.mp3');if(error||!data)throw Error('Missing licensed music '+id);await fs.writeFile(path.join(out,id+'.mp3'),Buffer.from(await data.arrayBuffer()));}return;
 }
 throw Error('Unimplemented stage '+stage);
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Dulce stopped');process.exitCode=1;});
