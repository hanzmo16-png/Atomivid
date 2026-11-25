import{createClient}from'@supabase/supabase-js';import{readFile,readdir}from'node:fs/promises';import path from'node:path';
async function main(){
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const b=sb.storage.from('videos');const privacy=await sb.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const roots=await readdir(process.env.MS_OUT_DIR);const dir=roots.find(x=>x===`ms-${process.env.MS_JOB_ID}`);let config=null; if(dir)config=JSON.parse(await readFile(path.join(process.env.MS_OUT_DIR,dir,'youtube-configurar.json'),'utf8').catch(()=> 'null'));
 const r=await sb.from('video_requests').select('status,long_form_stage,render_attempts,video_path').eq('id',process.env.MS_YOUTUBE_RESUME_REQUEST_ID).single();if(r.error)throw Error('request');
 const receipt={scope:'PRIVATE_QA_READBACK',requestId:process.env.MS_YOUTUBE_RESUME_REQUEST_ID,status:r.data.status,stage:r.data.long_form_stage,attempts:r.data.render_attempts,hasVideo:!!r.data.video_path,configuration:config?.rows??null};
 const name=`mystery-shopper/v3/receipts/longform-${process.env.GITHUB_RUN_ID}.json`;const w=await b.upload(name,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('write');console.log('Private journey receipt stored; no values published.');
}
main().catch(()=>{console.error('Private receipt unavailable; raw data withheld.');process.exitCode=1;});
