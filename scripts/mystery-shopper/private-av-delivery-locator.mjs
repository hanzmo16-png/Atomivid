import {createClient} from '@supabase/supabase-js';
import {createHash} from 'node:crypto';
async function main(){
 const e=process.env,id='2247cadf-9775-4840-8752-c66e36095612',owner='95c182e1-2549-4ef8-a4a4-924fd2890683';
 const sb=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),b=sb.storage.from('videos');
 const privacy=await sb.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const [q,ops]=await Promise.all([sb.from('podcast_studio_episodes').select('id,user_id,status,video_path,cost_usd,result,authorized_usd').eq('id',id).single(),sb.from('podcast_studio_operations').select('provider,op,state,reserved_usd,actual_usd').eq('episode_id',id)]);
 const path=`${owner}/podcast-studio/${id}/episodio.mp4`,row=q.data;
 if(q.error||ops.error||!row||row.user_id!==owner||row.status!=='ready'||row.video_path!==path||Number(row.authorized_usd)!==3||!Array.isArray(ops.data)||!ops.data.length)throw Error('canonical');
 if(ops.data.some(x=>x.state!=='settled'||x.actual_usd===null||!Number.isFinite(Number(x.actual_usd))||Number(x.actual_usd)<0))throw Error('unsettled');
 const providerSpent=ops.data.reduce((n,x)=>n+Number(x.actual_usd),0),cost=Number(row.cost_usd);
 if(row.cost_usd===null||!Number.isFinite(cost)||cost<providerSpent-0.0001||cost>3||providerSpent>3||!ops.data.some(x=>x.provider==='heygen'&&x.op==='avatar_clip'&&Number(x.actual_usd)>0)||!ops.data.some(x=>x.provider==='elevenlabs'&&x.op==='tts'&&Number(x.actual_usd)>0))throw Error('cost');
 if(!Number.isFinite(row.result?.duration)||row.result.duration<=0||!Array.isArray(row.result?.lip_violations)||row.result.lip_violations.length)throw Error('native-output');
 const file=await b.download(path);if(file.error||!file.data)throw Error('file');
 const bytes=Buffer.from(await file.data.arrayBuffer());if(!bytes.length||bytes.length>120000000)throw Error('size');
 const sha256=createHash('sha256').update(bytes).digest('hex'),signed=await b.createSignedUrl(path,300);if(signed.error||!signed.data?.signedUrl)throw Error('locator');
 const url=new URL(signed.data.signedUrl),trusted=new URL(e.NEXT_PUBLIC_SUPABASE_URL);
 if(url.protocol!=='https:'||url.origin!==trusted.origin||url.pathname!==`/storage/v1/object/sign/videos/${path}`)throw Error('binding');
 const receipt={scope:'PRIVATE_AV_STORAGE_TO_OWNER_DRIVE',episodeId:id,ownerVerified:true,canonicalPath:path,sha256,bytes:bytes.length,nativeDurationSeconds:row.result.duration,nativeLipViolations:row.result.lip_violations.length,nativeCostUsd:cost,providerSpentUsd:providerSpent,operations:ops.data,signedUrl:url.href,expiresAt:Date.now()+300000};
 const w=await b.upload(`mystery-shopper/v3/receipts/av-delivery-locator-${e.GITHUB_RUN_ID}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('receipt');
 console.log('Completed canonical AV locator saved privately for authorized owner delivery; no media or URL in GitHub.');
}
main().catch(()=>{console.error('AV delivery blocked: canonical media, settled cost or private binding not verified.');process.exitCode=1;});
