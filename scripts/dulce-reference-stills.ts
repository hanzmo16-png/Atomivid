/** Isolated pilot: six staged references, durable write-ahead ledger, no retries.
 * Existing sample renderer consumes these exact cache paths after visual review.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServiceClient} from '../src/lib/supabase/service';
import {reservePaid, settlePaid, committedUsd, type PaidLedger} from '../src/lib/video/long-form/sample-manifest';
import {buildContactSheet} from './lib/contact-sheet';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function main() {
  const budget = Number(process.env.SAMPLE_PAID_BUDGET_USD);
  if (process.env.SAMPLE_ALLOW_PAID !== 'true' || !(budget > 0 && budget <= 10)) throw Error('Explicit pilot authorization and cumulative cap <= 10 required');
  if (!process.env.OPENAI_API_KEY || process.env.VEO_API_KEY || process.env.ELEVENLABS_API_KEY) throw Error('Stills stage requires only the image provider key');
  const spec = JSON.parse(await fs.readFile('docs/quality/dulce-001/stills.json','utf8')) as {requestId:string;outputPrefix:string;model:string;scenes:{id:string;key:string;references:string[];prompt:string}[]};
  if (spec.requestId !== 'dulce-001' || spec.outputPrefix !== 'dulce-001/samples/pilot' || spec.model !== 'gpt-image-2' || spec.scenes.length !== 6) throw Error('Unexpected pilot scope');
  const service=createServiceClient(), bucket=service.storage.from('videos');
  const prefix=spec.outputPrefix, out=process.env.SAMPLE_OUT_DIR!;
  await fs.mkdir(out,{recursive:true});
  const download=async(p:string,optional=false)=>{
    const {data,error}=await bucket.download(p);
    if(data)return Buffer.from(await data.arrayBuffer());
    if(optional && error && ['404','400'].includes(String((error as unknown as {statusCode?:string}).statusCode)) && /not found/i.test(error.message))return null;
    throw Error(`Storage read failed: ${p}: ${error?.message}`);
  };
  const put=async(p:string,b:Buffer,mime:string)=>{const {error}=await bucket.upload(p,b,{contentType:mime,upsert:true});if(error)throw Error(`Storage write: ${error.message}`);};
  const ledgerPath=`${prefix}/state/paid-ledger.json`;
  const raw=await download(ledgerPath,true);
  let ledger:PaidLedger=raw?JSON.parse(raw.toString()):{entries:[]};
  const save=async()=>{await fs.writeFile(path.join(out,'paid-ledger.json'),JSON.stringify(ledger,null,2));await put(ledgerPath,Buffer.from(JSON.stringify(ledger)), 'application/json');};
  const frames=new Map<string,Buffer>();const tiles=[];
  for(const scene of spec.scenes){
    if(!/^d0[1-6]$/.test(scene.id)||scene.key!==`dulce-${scene.id}-v1`||scene.prompt.length>4000||scene.references.length>2)throw Error('Invalid scene');
    const key=`${scene.key}:still`, stillPath=`${prefix}/ai/${scene.key}-still.png`, metaPath=`${prefix}/ai/${scene.key}-still.json`;
    let bytes=await download(stillPath,true);
    if(bytes){
      const meta=JSON.parse((await download(metaPath))!.toString());
      if(meta.sha256!==sha(bytes)||meta.prompt!==scene.prompt)throw Error('Existing reference identity mismatch; do not regenerate');
      if(!ledger.entries.some(e=>e.key===key&&e.status==='spent'))throw Error('Cached reference has unresolved ledger; reconcile without generation');
    }else{
      const refBuffers=scene.references.map(id=>{const b=frames.get(id);if(!b)throw Error(`Missing reference ${id}`);return b;});
      const imagesCommitted=ledger.entries.filter(e=>e.provider==='openai-image'&&e.status!=='released').reduce((s,e)=>s+(e.actualUsd??e.estimateUsd),0);
      if(imagesCommitted+0.30>2+1e-8)throw Error('Image sub-budget exhausted');
      ledger=reservePaid(ledger,{key,sceneId:scene.id,provider:'openai-image',estimateUsd:0.30,prompt:scene.prompt},budget,new Date().toISOString());
      await save(); // No paid request is sent until durable reservation succeeds.
      try{
        let body:BodyInit;let endpoint='generations';const headers:Record<string,string>={Authorization:`Bearer ${process.env.OPENAI_API_KEY}`};
        if(refBuffers.length){
          endpoint='edits';const form=new FormData();
          form.set('model',spec.model);form.set('prompt',scene.prompt);form.set('size','1536x1024');form.set('quality','medium');form.set('n','1');
          refBuffers.forEach((b,i)=>form.append('image[]',new Blob([new Uint8Array(b)],{type:'image/png'}),`reference-${i}.png`));body=form;
        }else{headers['Content-Type']='application/json';body=JSON.stringify({model:spec.model,prompt:scene.prompt,size:'1536x1024',quality:'medium',n:1});}
        // Exactly one submission. A timeout or ambiguous response stops the entire stage.
        const response=await fetch(`https://api.openai.com/v1/images/${endpoint}`,{method:'POST',headers,body,signal:AbortSignal.timeout(180000)});
        if(!response.ok)throw Error(`Image provider HTTP ${response.status}; no automatic retry`);
        const result=await response.json() as {data?:{b64_json?:string}[];usage?:unknown};
        if(!result.data?.[0]?.b64_json)throw Error('Image missing from successful response; charge uncertain');
        bytes=Buffer.from(result.data[0].b64_json,'base64');
        const sharp=(await import('sharp')).default;const dimensions=await sharp(bytes).metadata();
        if(!dimensions.width||!dimensions.height||bytes.length<1000)throw Error('Invalid image bytes');
        const meta={provider:'openai-image',model:spec.model,endpoint,prompt:scene.prompt,references:scene.references,usage:result.usage,sha256:sha(bytes),width:dimensions.width,height:dimensions.height,storagePath:stillPath,costBasis:'conservative_reserved_estimate_not_invoice',reservedUsd:0.30,generatedAtIso:new Date().toISOString()};
        await fs.writeFile(path.join(out,`${scene.id}.png`),bytes);
        await fs.writeFile(path.join(out,`${scene.id}.json`),JSON.stringify(meta,null,2));
        await put(stillPath,bytes,'image/png');await put(metaPath,Buffer.from(JSON.stringify(meta)),'application/json');
        // Keep the full conservative valuation until billing is reconciled; do not invent actual cost.
        ledger=settlePaid(ledger,key,{status:'spent',note:'Usage recorded in still metadata; estimate retained, not an invoice'},new Date().toISOString());await save();
      }catch(err){
        if(ledger.entries.some(e=>e.key===key&&e.status==='reserved')){ledger=settlePaid(ledger,key,{status:'failed',note:err instanceof Error?err.message.slice(0,180):'Unknown outcome'},new Date().toISOString());await save();}
        throw err;
      }
    }
    frames.set(scene.id,bytes);tiles.push({image:bytes,label:scene.id});await fs.writeFile(path.join(out,`${scene.id}.png`),bytes);
    console.log(`@@DULCE_STILL ${JSON.stringify({id:scene.id,sha256:sha(bytes),committedUsd:committedUsd(ledger)})}`);
  }
  await fs.writeFile(path.join(out,'Dulce-reference-sheet.jpg'),await buildContactSheet(tiles,{columns:2,tileWidth:640,tileHeight:360,title:'Dulce — references for visual review'}));
  console.log('References ready; no video calls made. Visual review required before animation.');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Reference stage failed');process.exitCode=1;});
