// One authorized append-only settlement. No provider call, reset, deletion or raw output.
import {createClient} from '@supabase/supabase-js';
async function main(){
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
 const id='c6264af5-e4ec-8c36-9b9a-946bd4b09c03',prefix='mystery-shopper/v3/ledger',bucket=sb.storage.from('videos');
 const req=await sb.from('video_requests').select('status,render_attempts').eq('id',id).single();if(req.error||req.data.status!=='completed'||req.data.render_attempts!==1)throw Error('status');
 const c=await sb.from('generation_costs').select('footage_provider,music_provider,image_generation_count,image_cost_usd,premium_video_cost_usd,avatar_cost_usd').eq('request_id',id).single();if(c.error||!c.data)throw Error('cost');
 if(c.data.footage_provider!=='pexels-video-first'||c.data.music_provider!=='curated-library'||[c.data.image_generation_count,c.data.image_cost_usd,c.data.premium_video_cost_usd,c.data.avatar_cost_usd].some(x=>Number(x)!==0))throw Error('uncovered');
 const ops=await sb.from('pi_paid_operations').select('status,committed_usd').eq('project_id',id);if(ops.error||ops.data.length!==4||ops.data.some(x=>x.status!=='COMMITTED'||x.committed_usd===null||!Number.isFinite(Number(x.committed_usd))||Number(x.committed_usd)<0))throw Error('operations');
 // This public repository's completed standard Ubuntu render has zero billable milliseconds.
 const h={Authorization:`Bearer ${process.env.GH_READ_TOKEN}`,Accept:'application/vnd.github+json'};
 const repo=await fetch('https://api.github.com/repos/hanzmo16-png/Atomivid',{headers:h,signal:AbortSignal.timeout(15000)});if(!repo.ok||(await repo.json()).private!==false)throw Error('repo');
 const t=await fetch('https://api.github.com/repos/hanzmo16-png/Atomivid/actions/runs/45612136221/timing',{headers:h,signal:AbortSignal.timeout(15000)});if(!t.ok)throw Error('timing');const time=await t.json();if(!time.billable||Object.values(time.billable).some(x=>x.total_ms!==0))throw Error('billing');
 const l=await bucket.list(prefix,{limit:1000});if(l.error||!l.data||l.data.length>=1000||l.data.some(x=>x.name==='STOP'))throw Error('ledger');
 const reservations=[],settlements=[];for(const f of l.data){if(!/^(reserve-|settle-).*\.json$/.test(f.name))continue;const r=await bucket.download(`${prefix}/${f.name}`);if(r.error||!r.data)throw Error('read');const x=JSON.parse(await r.data.text());(f.name.startsWith('reserve-')?reservations:settlements).push(x);}
 const reels=reservations.filter(x=>x.module==='reels');if(reels.length!==1||reels[0].reservedUsd!==1.5||!/^ms-[a-z0-9-]+-reels$/.test(reels[0].key))throw Error('ambiguous');
 const amount=Math.ceil((ops.data.reduce((s,x)=>s+Number(x.committed_usd),0)-Number.EPSILON)*100)/100;if(!(amount>0&&amount<=reels[0].reservedUsd))throw Error('amount');
 const path=`${prefix}/settle-${reels[0].key}.json`,existing=settlements.filter(x=>x.key===reels[0].key);if(existing.length>1||existing.length===1&&existing[0].spentUsd!==amount)throw Error('existing');
 const receipt={key:reels[0].key,spentUsd:amount,source:'Four COMMITTED provider operations, rounded up to cents; completed public Ubuntu render zero billable ms; no generated image/premium/avatar; curated music and free footage. Internal provider-ledger accounting, not supplier invoice.',at:new Date().toISOString()};
 if(!existing.length){const w=await bucket.upload(path,JSON.stringify(receipt),{contentType:'application/json',upsert:false});if(w.error)throw Error('write');}
 const back=await bucket.download(path);if(back.error||!back.data)throw Error('readback');const check=JSON.parse(await back.data.text());if(check.key!==receipt.key||check.spentUsd!==amount)throw Error('verification');
 console.log('PASS: append-only Reel settlement read back. No generation or public financial output.');
}
main().catch(()=>{console.error('BLOCKED: settlement prerequisites not met; no raw data emitted.');process.exitCode=1;});
