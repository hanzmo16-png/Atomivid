import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { executePaidOperation } from '../../src/lib/production-intelligence/ledger';
import { paidCallKey } from '../../src/lib/paid-calls/gate';
import { supabaseLedgerStore } from '../../src/lib/paid-calls/supabase-ledger-store';
import { ensureJobSupplyReady } from '../../src/lib/supply/readiness';
import { refreshProviderSnapshot } from '../../src/lib/supply/monitor';

export async function finalAvatar(cfg:any,seal:(name:string,b:Buffer)=>void){
 const db=createClient(process.env.SUPABASE_URL!.trim(),process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const storage=db.storage.from('videos'),prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}/avatar-final`;
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const get=async(path:string)=>{const r=await storage.download(path);if(r.error||!r.data)throw Error('AVATAR_SOURCE_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());};
 const put=async(path:string,b:Buffer,mime:string)=>{const r=await storage.download(path);if(r.data){if(sha(Buffer.from(await r.data.arrayBuffer()))!==sha(b))throw Error('EXISTING_AVATAR_DIFFERS');return;}const u=await storage.upload(path,b,{contentType:mime,upsert:false});if(u.error)throw Error('AVATAR_STORE_FAILED');if(sha(await get(path))!==sha(b))throw Error('AVATAR_STORE_HASH');};
 const api=async(path:string,init:RequestInit={})=>{
  const r=await fetch('https://api.heygen.com'+path,{...init,redirect:'error',signal:AbortSignal.timeout(90000),headers:{'X-Api-Key':process.env.HEYGEN_API_KEY!.trim(),...(init.body instanceof FormData?{}:{'Content-Type':'application/json'})}});
  const j=await r.json().catch(()=>null);if(!r.ok||!j?.data)throw Error(`HEYGEN_HTTP_${r.status}`);return j.data;
 };
 const wallet=async()=>{const d=await api('/v3/users/me');if(d.wallet?.currency!=='usd'||!Number.isFinite(d.wallet.remaining_balance))throw Error('WALLET_UNVERIFIED');return d.wallet.remaining_balance as number;};
 const upload=async(b:Buffer,mime:string,name:string)=>{const f=new FormData();f.append('file',new Blob([new Uint8Array(b)],{type:mime}),name);const d=await api('/v3/assets',{method:'POST',body:f});const id=d.asset_id??d.id;if(typeof id!=='string')throw Error('ASSET_ID_MISSING');return id;};
 const plan=JSON.parse((await get(`${prefix}/plan.json`)).toString());
 if(plan.episodeId!==cfg.episodeId||plan.ownerId!==cfg.ownerId||plan.seconds>168||plan.cuts.length!==4)throw Error('AVATAR_PLAN_INVALID');
 const audio=await get(plan.batchPath),image=await get(plan.imagePath);
 if(sha(audio)!==plan.batchSha256||sha(image)!==plan.imageSha256)throw Error('AVATAR_INPUT_HASH');
 const reserved=Math.ceil(plan.seconds*.0385*100)/100;
 if(reserved>6.5||reserved!==plan.estimatedUsd)throw Error('AVATAR_BUDGET_INVALID');
 const spec={projectId:`podcast-${cfg.episodeId}`,shotId:'avatar:final-four-interventions',provider:'heygen',model:'avatar-iv-photo',method:'generate_video',inputFingerprint:{audioSha:sha(audio),imageSha:sha(image),resolution:'1080p'},reservedUsd:reserved};
 const key=paidCallKey(spec),ledger=supabaseLedgerStore(db),prior=await ledger.get(key);
 if(!prior||prior.status==='RESERVED'){
  await refreshProviderSnapshot(db,'heygen');
  const ready=await ensureJobSupplyReady(db,[{provider:'heygen',unit:'usd',units:reserved,usd:reserved}]);
  if(!ready.ready)throw Error('AVATAR_SUPPLY_NOT_READY');
  const others=await db.from('pi_paid_operations').select('idempotency_key,status,reserved_usd,committed_usd').eq('project_id',spec.projectId).eq('provider','heygen').neq('status','REFUNDED');
  if(others.error||(others.data??[]).reduce((n,o)=>n+(o.idempotency_key===key?0:Number(o.committed_usd??o.reserved_usd)),0)+reserved>6.5)throw Error('EPISODE_AVATAR_CAP');
 }
 const receiptPath=`${prefix}/provider-receipt.json`,resultPath=`${prefix}/result.json`;
 const op=await executePaidOperation(ledger,{idempotencyKey:key,projectId:spec.projectId,shotId:spec.shotId,provider:spec.provider,model:spec.model,method:spec.method,attemptKind:'initial',reservedUsd:reserved}, {
  submit:async()=>{
   const before=await wallet();if(before<reserved)throw Error('WALLET_INSUFFICIENT');
   const imageId=await upload(image,'image/png','studio.png'),audioId=await upload(audio,'audio/wav','interventions.wav');
   const d=await api('/v3/videos',{method:'POST',body:JSON.stringify({type:'image',image:{type:'asset_id',asset_id:imageId},audio_asset_id:audioId,aspect_ratio:'16:9',resolution:'1080p'})});
   if(typeof d.video_id!=='string')throw Error('JOB_ID_MISSING_NEVER_RESUBMIT');
   await put(receiptPath,Buffer.from(JSON.stringify({jobId:d.video_id,ledgerKey:key,walletBefore:before,seconds:plan.seconds,submittedAt:new Date().toISOString()})),'application/json');
   console.log('AVATAR_SUBMITTED',JSON.stringify({seconds:plan.seconds,reservedUsd:reserved,resolution:'1080p',paidCalls:1}));
   return {providerJobId:d.video_id,submissionReceiptRef:receiptPath};
  },
  poll:async(jobId)=>{
   const receipt=JSON.parse((await get(receiptPath)).toString());if(receipt.jobId!==jobId||receipt.ledgerKey!==key)throw Error('RECEIPT_MISMATCH');
   let data:any;const deadline=Date.now()+40*60_000;
   while(Date.now()<deadline){data=await api(`/v3/videos/${encodeURIComponent(jobId)}`);if(data.status==='completed')break;if(['failed','cancelled'].includes(data.status))throw Error('AVATAR_PROVIDER_FAILED_RECONCILE');await new Promise(r=>setTimeout(r,15000));}
   if(data?.status!=='completed'||typeof data.video_url!=='string')throw Error('AVATAR_PENDING_RESUME_SAME_JOB');
   const r=await fetch(data.video_url,{redirect:'error',signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error('AVATAR_DOWNLOAD_FAILED');const video=Buffer.from(await r.arrayBuffer());
   const local='/tmp/travis-close/avatar.mp4';writeFileSync(local,video);
   execFileSync('ffmpeg',['-nostdin','-v','error','-xerror','-err_detect','explode','-i',local,'-map','0:v:0','-map','0:a?','-f','null','-'],{stdio:'pipe'});
   const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',local]).toString());
   const v=probe.streams.find((x:any)=>x.codec_type==='video');if(!v||v.width!==1920||v.height!==1080||Number(v.duration??probe.format.duration)<plan.seconds-.08)throw Error('AVATAR_OUTPUT_INVALID');
   const path=`${prefix}/interventions-1080p.mp4`;await put(path,video,'video/mp4');
   let after=await wallet();for(let i=0;i<6&&after>=receipt.walletBefore;i++){await new Promise(r=>setTimeout(r,10000));after=await wallet();}
   const observed=Math.round((receipt.walletBefore-after)*10000)/10000;
   const actual=observed>0?observed:reserved;
   if(actual>reserved+.02)throw Error('AVATAR_CHARGE_REQUIRES_RECONCILIATION');
   const result={...plan,resolution:'1080p',path,bytes:video.length,sha256:sha(video),providerJobId:jobId,duration:Number(v.duration??probe.format.duration),costUsd:actual,costBasis:observed>0?'wallet-delta':'reserved-estimate',fullDecodeErrors:0};
   await put(resultPath,Buffer.from(JSON.stringify(result,null,2)),'application/json');
   return {resultRef:resultPath,actualUsd:actual};
  }
 },()=>new Date().toISOString());
 if(op.status!=='COMMITTED'||!op.resultRef)throw Error('AVATAR_NOT_COMMITTED');
 const resultBytes=await get(op.resultRef),result=JSON.parse(resultBytes.toString());seal('avatar-result.json',resultBytes);
 const video=await get(result.path);if(sha(video)!==result.sha256)throw Error('AVATAR_RESULT_HASH');
 writeFileSync('/tmp/travis-close/avatar.mp4',video);
 execFileSync('ffmpeg',['-nostdin','-v','error','-y','-i','/tmp/travis-close/avatar.mp4','-vf','fps=1/11,scale=480:-1,tile=4x2','-frames:v','1','/tmp/travis-close/avatar-sheet.jpg'],{stdio:'pipe'});
 seal('avatar-sheet.jpg',readFileSync('/tmp/travis-close/avatar-sheet.jpg'));
 console.log('AVATAR_COMPLETE',JSON.stringify({seconds:result.seconds,bytes:result.bytes,costUsd:result.costUsd,resolution:result.resolution,reused:prior?.status==='COMMITTED',fullDecodeErrors:0}));
}
