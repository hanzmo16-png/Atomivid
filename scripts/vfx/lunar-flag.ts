/** One owner-authorized replacement direction, not a repeated motion trial. Official BFL + existing ledger. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {ownedJob} from '../../src/lib/production-intelligence/vfx-director/jobs';
import {supabaseJobStore} from '../../src/lib/production-intelligence/vfx-director/store';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore,paidResultPath} from '../../src/lib/paid-calls/result-store';
import {executePaidOperation,idempotencyKey} from '../../src/lib/production-intelligence/ledger';
import {officialWorldPort,type Submitted} from '../../src/lib/providers/vfx-worlds/official';
import {stableHash} from '../../src/lib/production-intelligence/canonical';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const auth=JSON.parse(await readFile('docs/production-intelligence/VFX-LUNAR-FLAG-GENERATION.json','utf8'));
 const amendment=await readFile('docs/production-intelligence/VFX-LUNAR-FLAG-DIRECTION-AMENDMENT.json');
 const direction=JSON.parse(amendment.toString());
 if(auth.directionSha256!==sha(amendment)||auth.maximumCallUsd!==.075||auth.maximumProjectUsd!==4.8||auth.maximumCalls!==1||auth.provider!=='bfl'||auth.sku!=='flux-2-pro'||auth.width!==1088||auth.height!==1920||auth.approved!==true)throw new Error('VFX_FLAG_AUTHORIZATION_CHANGED');
 if(sha(await readFile(direction.brandSource))!==direction.brandSourceSha256)throw new Error('VFX_BRAND_CHANGED');
 const pf=JSON.parse(await readFile('vfx-provider-preflight.json','utf8'));const bfl=pf.connections.find((p:{provider:string})=>p.provider==='bfl');
 if(Date.now()-Date.parse(pf.checkedAt)>3600000||!bfl?.authenticated||!bfl.creditsVerified||!bfl.enoughForBaseQuote)throw new Error('VFX_BFL_NOT_READY');
 const sb=createServiceClient(),owner=await sb.auth.admin.getUserById(direction.ownerMessage?auth.ownerId:'');if(owner.error)throw new Error('VFX_OWNER_LOOKUP_FAILED');
 const actor=directorActor(owner.data.user),projectId='precampaign-three-worlds-v1-preparation';
 await ownedJob(supabaseJobStore(sb),projectId,actor);
 const ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb);
 const policyKey='vfx_world_policy_'+stableHash({projectId,environmentId:'moon'},32);
 const policy=JSON.stringify({ownerId:actor,environmentId:'moon',background:'fixed_lunar_flag',allowImageToVideo:false,authorizationSha256:auth.directionSha256});
 await ledger.insert({idempotencyKey:policyKey,projectId,shotId:'world:moon:payment-policy',provider:'internal',model:'world-payment-policy/1',method:'world_payment_policy',attemptKind:'direction-change',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:policy,updatedAt:new Date().toISOString()});
 if((await ledger.get(policyKey))?.resultRef!==policy)throw new Error('VFX_WORLD_PAYMENT_POLICY_CHANGED');
 const key=idempotencyKey({projectId,shotId:'world:moon:flag-direction-20261003',provider:'bfl',model:'flux-2-pro',method:'image-edit',inputFingerprint:sha(Buffer.from(JSON.stringify({directionSha256:auth.directionSha256,prompt:auth.prompt,width:1088,height:1920,referenceSha256:auth.referenceSha256,brandSourceSha256:direction.brandSourceSha256}))),attemptOrdinal:0});
 const slot='vfx_lunar_flag_direction_20261003';await ledger.insert({idempotencyKey:slot,projectId,shotId:'world:moon:flag-direction-20261003',provider:'internal',model:'direction-slot/1',method:'generation_slot',attemptKind:'direction-change',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:key,updatedAt:new Date().toISOString()});
 if((await ledger.get(slot))?.resultRef!==key)throw new Error('VFX_FLAG_ALREADY_FROZEN');
 const rows=await sb.from('pi_paid_operations').select('reserved_usd,committed_usd,status,idempotency_key').eq('project_id',projectId);if(rows.error)throw new Error('VFX_LEDGER_READ_FAILED');
 const held=rows.data.filter(r=>r.idempotency_key!==key&&r.status!=='REFUNDED').reduce((s,r)=>s+Number(r.committed_usd??r.reserved_usd),0);
 if(held+.075+2.04>auth.maximumProjectUsd+1e-9)throw new Error('VFX_FLAG_PROJECT_BUDGET_BLOCKED');
 const port=officialWorldPort();
 const op=await executePaidOperation(ledger,{idempotencyKey:key,projectId,shotId:'world:moon:flag-direction-20261003',provider:'bfl',model:'flux-2-pro',method:'image-edit',attemptKind:'direction-change',reservedUsd:.075},{
  async submit(){
   const moon=await results.getJson<{assetPath:string;sha256:string}>(auth.referenceMetadataPath);if(!moon||moon.sha256!==auth.referenceSha256)throw new Error('VFX_LUNAR_REFERENCE_CHANGED');
   const bytes=await results.getBytes(moon.assetPath);if(!bytes||sha(bytes)!==moon.sha256)throw new Error('VFX_LUNAR_REFERENCE_CHANGED');
   // Exact existing vector mark; no AI-designed substitute and no source person uploaded.
   const svg='<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320" viewBox="0 0 512 320"><rect width="512" height="320" fill="#8f7ff5"/><g transform="translate(184 35) scale(6)" stroke="white" fill="none" stroke-width="1.3"><ellipse cx="12" cy="12" rx="10" ry="4.1"/><ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.1" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="2.6" fill="white" stroke="none"/></g><text x="256" y="257" text-anchor="middle" font-family="sans-serif" font-size="56" font-weight="600" fill="white">Atomivid</text></svg>';
   const brand=await sharp(Buffer.from(svg)).png().toBuffer();const brandPath=projectId+'/flag-direction/brand-'+sha(brand)+'.png';await results.putBytes(brandPath,brand,'image/png');
   const refs=[];for(const path of [moon.assetPath,brandPath]){const signed=await sb.storage.from('videos').createSignedUrl(path,3600);if(signed.error||!signed.data?.signedUrl)throw new Error('VFX_REFERENCE_URL_FAILED');refs.push(signed.data.signedUrl);}
   const response=await fetch('https://api.bfl.ai/v1/flux-2-pro',{method:'POST',headers:{'x-key':process.env.BFL_API_KEY??'','Content-Type':'application/json'},body:JSON.stringify({prompt:auth.prompt,width:1088,height:1920,output_format:'png',input_image:refs[0],input_image_2:refs[1]}),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw new Error('VFX_BFL_HTTP_'+response.status);
   const d=await response.json();if(typeof d.id!=='string'||! /^[a-zA-Z0-9_-]{1,160}$/.test(d.id)||typeof d.polling_url!=='string')throw new Error('VFX_BFL_RECEIPT_INVALID');
   const receipt:Submitted={id:d.id,pollingUrl:d.polling_url,...(typeof d.cost==='number'?{costUsd:d.cost/100}:{})};
   return {providerJobId:d.id,submissionReceiptRef:'provider-receipt:'+JSON.stringify(receipt)};
  },
  async poll(id){
   const current=await ledger.get(key);if(!current?.resultRef?.startsWith('provider-receipt:'))throw new Error('VFX_RECEIPT_MISSING');
   const receipt=JSON.parse(current.resultRef.slice('provider-receipt:'.length));if(receipt.id!==id)throw new Error('VFX_RECEIPT_CHANGED');
   const a=await port.finish(receipt,{environmentId:'moon',phase:'styleframe',prompt:auth.prompt});
   if(!Number.isFinite(a.costUsd)||a.costUsd<0||a.costUsd>.075+1e-9)throw new Error('VFX_FLAG_COST_RECONCILIATION_REQUIRED');
   const costUsd=a.costBasis==='provider_usage'?a.costUsd:.075,costBasis=a.costBasis==='provider_usage'?'provider_usage':'reserved_ceiling';
   const m=await sharp(a.buffer).metadata();if(m.format!=='png'||m.width!==1088||m.height!==1920)throw new Error('VFX_FLAG_RASTER_CHANGED');
   const cropped=await sharp(a.buffer).extract({left:4,top:0,width:1080,height:1920}).png().toBuffer();
   const path=paidResultPath(projectId,key,'png'),ref=paidResultPath(projectId,key,'json');await results.putBytes(path,cropped,'image/png');
   await results.putJson(ref,{assetPath:path,sha256:sha(cropped),bytes:cropped.length,providerJobId:id,costUsd,costBasis,rawWidth:1088,width:1080,height:1920,normalization:'crop four pixels per side, no resize/upscale',visualApproved:false});
   return {resultRef:ref,actualUsd:costUsd};
  }
 },()=>new Date().toISOString());
 if(op.status!=='COMMITTED'||!op.resultRef)throw new Error('VFX_FLAG_NOT_COMMITTED');
 const meta=await results.getJson<{assetPath:string;sha256:string;bytes:number}>(op.resultRef);if(!meta)throw new Error('VFX_FLAG_RESULT_MISSING');const bytes=await results.getBytes(meta.assetPath);if(!bytes||sha(bytes)!==meta.sha256||bytes.length!==meta.bytes)throw new Error('VFX_FLAG_RESULT_CHANGED');
 await mkdir('vfx-flag-review',{recursive:true});await writeFile('vfx-flag-review/Luna-bandera-Atomivid.png',bytes);await writeFile('vfx-flag-review/receipt.json',JSON.stringify({key,...meta,staticDirection:true,visualApproved:false,proCalls:0,deployment:false},null,2));
 console.log(JSON.stringify({key,sha256:meta.sha256,costUsd:op.committedUsd,visualApproved:false,proCalls:0}));
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_FLAG_BLOCKED');process.exitCode=1;});
