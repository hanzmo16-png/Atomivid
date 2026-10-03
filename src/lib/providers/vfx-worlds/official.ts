/** Official APIs only. This module is server-only and called exclusively by the paid preparation gate.
 * Primary contracts: BFL OpenAPI (2026-10-03); LTX /v2/image-to-video and /async-jobs docs.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
export const WorldRequestSchema = z.object({
  environmentId:z.enum(['nyc','beach','moon']), phase:z.enum(['styleframe','motion','final']),
  prompt:z.string().trim().min(1).max(5000),
  reference:z.object({ bytes:z.instanceof(Buffer),sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.enum(['image/png','image/jpeg']) }).optional(),
}).strict();
export type WorldRequest=z.infer<typeof WorldRequestSchema>;
export type OfficialAsset={buffer:Buffer;mimeType:string;extension:string;model:string;costUsd:number;costBasis:'provider_usage'|'published_rate';providerJobId:string};
export type Submitted={id:string;costUsd?:number;pollingUrl?:string};
export interface OfficialPort {
  submit(request:WorldRequest):Promise<Submitted>;
  finish(job:Submitted,request:WorldRequest):Promise<OfficialAsset>;
}
export function worldRecipe(raw:WorldRequest) {
 const r=WorldRequestSchema.parse(raw);
 if(r.phase==='styleframe') {
  if(r.reference)throw new Error('VFX_STYLEFRAME_REFERENCE_NOT_PRICED');
  return {provider:'bfl',sku:'flux-2-pro',width:720,height:1280,fps:0,seconds:0,reservedUsd:0.03,
   payload:{prompt:r.prompt,width:720,height:1280,output_format:'png'}};
 }
 if(!r.reference || r.reference.bytes.length===0 || r.reference.bytes.length>7*1024*1024 || createHash('sha256').update(r.reference.bytes).digest('hex')!==r.reference.sha256) throw new Error('VFX_FROZEN_REFERENCE_INVALID');
 const final=r.phase==='final';
 return {provider:'ltx',sku:final?'ltx-2-5-pro':'ltx-2-5-fast',width:final?1080:720,height:final?1920:1280,fps:25,seconds:6,reservedUsd:final?1.02:0.54,
  payload:{prompt:r.prompt,image_uri:`data:${r.reference.mimeType};base64,${r.reference.bytes.toString('base64')}`,model:final?'ltx-2-5-pro':'ltx-2-5-fast',duration:6,resolution:final?'1080x1920':'720x1280',fps:25,generate_audio:false}};
}
export class OfficialCallError extends Error {
 constructor(public readonly code:string,public readonly jobId?:string) {super(code);}
}
export function officialWorldPort(options:{fetch?:typeof fetch;sleep?:(ms:number)=>Promise<void>;bflKey?:string;ltxKey?:string;maxPolls?:number}={}):OfficialPort {
 const http=options.fetch??fetch;
 const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 function headers(provider:string):Record<string,string> {
  const key=provider==='bfl'?(options.bflKey??process.env.BFL_API_KEY):(options.ltxKey??process.env.LTX_API_KEY);
  if(!key?.trim())throw new OfficialCallError('VFX_KEY_MISSING');
  return provider==='bfl'?{'x-key':key,'Content-Type':'application/json'}:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
 }
 function id(value:unknown):string {
  if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,160}$/.test(value))throw new OfficialCallError('VFX_JOB_ID_INVALID');
  return value;
 }
 async function json(url:string,init:RequestInit,jobId?:string) {
  try {
   const response=await http(url,{...init,redirect:'error',signal:AbortSignal.timeout(30_000)});
   if(!response.ok)throw new OfficialCallError(`VFX_HTTP_${response.status}`,jobId);
   return await response.json() as Record<string,unknown>;
  }catch(error){if(error instanceof OfficialCallError)throw error;throw new OfficialCallError('VFX_NETWORK_OR_RESPONSE_UNCERTAIN',jobId);}
 }
 return {
  async submit(r) {
   const recipe=worldRecipe(r), h=headers(recipe.provider);
   const url=recipe.provider==='bfl'?'https://api.bfl.ai/v1/flux-2-pro':'https://api.ltx.io/v2/image-to-video';
   const data=await json(url,{method:'POST',headers:h,body:JSON.stringify(recipe.payload)});
   const jobId=id(data.id);
   // BFL explicitly returns cost in credits when available; never silently turn missing usage into actual billing.
   const cost=recipe.provider==='bfl'&&typeof data.cost==='number'&&Number.isFinite(data.cost)&&data.cost>=0?data.cost/100:undefined;
   return {id:jobId,...(cost===undefined?{}:{costUsd:cost}),...(recipe.provider==='bfl'&&typeof data.polling_url==='string'?{pollingUrl:data.polling_url}:{})};
  },
  async finish(job,r) {
   const jobId=id(job.id),recipe=worldRecipe(r),h=recipe.provider==='bfl'?undefined:headers(recipe.provider);
   let poll=`https://api.ltx.io/v2/image-to-video/${encodeURIComponent(jobId)}`;
   if(recipe.provider==='bfl') {
    if(!job.pollingUrl)throw new OfficialCallError('VFX_POLLING_RECEIPT_MISSING',jobId);
    const u=new URL(job.pollingUrl);
    if(u.protocol!=='https:'||u.username||u.password||!/^api(?:\.[a-z0-9-]+)?\.bfl\.ai$/.test(u.hostname)||u.pathname!=='/v1/get_result'||u.searchParams.get('id')!==jobId)throw new OfficialCallError('VFX_POLLING_RECEIPT_INVALID',jobId);
    poll=u.toString();
   }
   for(let n=0;n<(options.maxPolls??120);n++) {
    const data=await json(poll,{method:'GET',headers:h},jobId);
    const done=recipe.provider==='bfl'?data.status==='Ready':data.status==='completed';
    if(done) {
     const result=data.result as Record<string,unknown>|undefined;
     const raw=recipe.provider==='bfl'?result?.sample:result?.video_url;
     if(typeof raw!=='string')throw new OfficialCallError('VFX_RESULT_URL_MISSING',jobId);
     const url=new URL(raw);
     if(url.protocol!=='https:'||url.username||url.password)throw new OfficialCallError('VFX_RESULT_URL_INVALID',jobId);
     // Output URLs are provider-produced; API credentials never leave the official API host.
     let response:Response;
     try {response=await http(url,{redirect:'error',signal:AbortSignal.timeout(60_000)});} catch {throw new OfficialCallError('VFX_DOWNLOAD_FAILED',jobId);}
     if(!response.ok)throw new OfficialCallError('VFX_DOWNLOAD_FAILED',jobId);
     const buffer=Buffer.from(await response.arrayBuffer());
     if(!buffer.length)throw new OfficialCallError('VFX_EMPTY_RESULT',jobId);
     const reported=recipe.provider==='bfl'&&typeof data.cost==='number'&&Number.isFinite(data.cost)&&data.cost>=0?data.cost/100:job.costUsd;
     return {buffer,mimeType:recipe.provider==='bfl'?'image/png':'video/mp4',extension:recipe.provider==='bfl'?'png':'mp4',model:recipe.sku,
      costUsd:reported??recipe.reservedUsd,costBasis:reported===undefined?'published_rate':'provider_usage',providerJobId:jobId};
    }
    if(!['Pending','Request Moderated','Content Moderated','Task not found','Error','pending','processing'].includes(String(data.status)))throw new OfficialCallError('VFX_STATUS_UNKNOWN',jobId);
    if(!['Pending','pending','processing'].includes(String(data.status)))throw new OfficialCallError('VFX_PROVIDER_FAILED',jobId);
    await sleep(5000);
   }
   throw new OfficialCallError('VFX_POLL_TIMEOUT',jobId);
  }
 };
}
