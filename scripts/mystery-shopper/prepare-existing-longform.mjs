// Reuse only the QA preparation temporally tied to its settled script reservation. Never create a script.
import{createClient}from'@supabase/supabase-js';import{appendFile}from'node:fs/promises';
async function main(){
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),bucket=sb.storage.from('videos'),prefix='mystery-shopper/v3/ledger';
 const list=await bucket.list(prefix,{limit:1000});if(list.error||!list.data||list.data.length>=1000||list.data.some(x=>x.name==='STOP'))throw Error('ledger');
 const rs=[],ss=[];for(const f of list.data){if(!/^(reserve-|settle-).*\.json$/.test(f.name))continue;const b=await bucket.download(`${prefix}/${f.name}`);if(b.error||!b.data)throw Error('read');(f.name.startsWith('reserve-')?rs:ss).push(JSON.parse(await b.data.text()));}
 const owner=await sb.from('video_requests').select('user_id').eq('id','c6264af5-e4ec-8c36-9b9a-946bd4b09c03').single();if(owner.error)throw Error('owner');
 const matches=[];
 for(const r of rs.filter(x=>x.module==='youtube'&&x.key.endsWith('-yt-script'))){const settled=ss.filter(s=>s.key===r.key);if(settled.length!==1||!Number.isFinite(settled[0].spentUsd)||settled[0].spentUsd<0||settled[0].spentUsd>r.reservedUsd)continue;
 const at=Date.parse(r.at);if(!Number.isFinite(at))throw Error('time');const jobs=await sb.from('documentary_script_jobs').select('request_id').eq('user_id',owner.data.user_id).eq('status','completed').gte('created_at',new Date(at-30000).toISOString()).lte('created_at',new Date(at+30000).toISOString());if(jobs.error)throw Error('jobs');
 for(const j of jobs.data){const req=await sb.from('video_requests').select('id,status,mode,render_attempts,duration_seconds,user_id').eq('id',j.request_id).single();if(req.error)throw Error('request');if(req.data.status==='script_ready'&&req.data.mode==='long_form'&&req.data.render_attempts===0&&req.data.duration_seconds===180&&req.data.user_id===owner.data.user_id)matches.push({request:req.data.id,key:r.key});}}
 if(matches.length!==1)throw Error('ambiguous');const m=matches[0];console.log(`::add-mask::${m.request}`);console.log(`::add-mask::${m.key}`);await appendFile(process.env.GITHUB_ENV,`MS_YOUTUBE_RESUME_REQUEST_ID=${m.request}\nMS_YOUTUBE_EXISTING_SCRIPT_KEY=${m.key}\n`);console.log('One existing preparation verified. No script generation or provider call.');
}
main().catch(()=>{console.error('BLOCKED: no unique unrendered QA preparation with settled script. No new script created.');process.exitCode=1;});
