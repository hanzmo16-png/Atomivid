import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runwayVideoProvider} from '../../src/lib/providers/video-gen/runway';
import {wrapDurableVideoProvider} from '../../src/lib/video/long-form/ai-video-durable-provider';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {ensureJobSupplyReady} from '../../src/lib/supply/readiness';
export async function motion(cfg:any,io:any){
 const {db,bucket,seal,get}=io,project=`podcast-${cfg.episodeId}`;
 const scenes=JSON.parse(readFileSync('ops/travis-walton/motion.json','utf8')) as {id:string;prompt:string}[];
 if(scenes.length!==8||new Set(scenes.map(s=>s.id)).size!==8)throw Error('MOTION_PLAN_INVALID');
 const spent=async()=>{const {data,error}=await db.from('pi_paid_operations').select('status,reserved_usd,committed_usd').eq('project_id',project).eq('provider','runway').neq('status','REFUNDED');if(error)throw Error('MOTION_LEDGER_UNAVAILABLE');return (data??[]).reduce((a:number,o:any)=>a+Number(o.status==='COMMITTED'?o.committed_usd:o.reserved_usd),0);};
 const provider=wrapDurableVideoProvider(runwayVideoProvider,{supabase:db,scopeId:project,ledger:supabaseLedgerStore(db),maxInAttemptResumes:2,beforeSubmit:async()=>await spent()+0.5<=4.00001});
 const manifest=[];
 for(const scene of scenes){
  const ready=await ensureJobSupplyReady(db,[{provider:'runway',unit:'usd',units:0.5,usd:0.5}]);
  if(!ready.ready)throw Error('MOTION_CAPACITY_UNAVAILABLE');
  const bytes=await get(`${cfg.ownerId}/podcasts/${cfg.episodeId}/references/${scene.id}.jpg`);
  const sha=createHash('sha256').update(bytes).digest('hex');
  const r=await provider.generateVideo({prompt:scene.prompt,aspectRatio:'16:9',durationSeconds:10,maxCostUsd:0.5,referenceImageUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`,metadata:{shotId:`${scene.id}-${sha.slice(0,10)}`}});
  const path=`${cfg.ownerId}/podcasts/${cfg.episodeId}/motion/${scene.id}.mp4`;
  const up=await bucket.upload(path,r.buffer,{contentType:'video/mp4',upsert:true});if(up.error)throw Error('MOTION_STORE_FAILED');
  seal(`${scene.id}.mp4`,r.buffer);manifest.push({id:scene.id,path,seconds:r.durationSeconds,referenceSha256:sha,providerJobId:r.providerJobId});
  console.log('MOTION_READY',JSON.stringify({id:scene.id,seconds:r.durationSeconds,ledgerUsd:await spent()}));
 }
 seal('motion-manifest.json',Buffer.from(JSON.stringify(manifest)));
 console.log('MOTION_COMPLETE',JSON.stringify({clips:manifest.length,ledgerUsd:await spent()}));
}
