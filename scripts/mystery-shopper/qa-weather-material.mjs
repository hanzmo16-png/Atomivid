// Free stock preflight / explicit QA editorial repair. No paid-provider import or render invocation.
import {createClient} from '@supabase/supabase-js';
import {createHash} from 'node:crypto';
import {adaptWeatherContext} from './qa-weather-context.mjs';
import {materialAvailabilityPreflight} from '../../src/lib/video/long-form/material-preflight.ts';
import {getFootageProvider} from '../../src/lib/providers/footage/index.ts';
import {withSearchDeadline} from '../../src/lib/video/long-form/material-plan.ts';
import {reopenLongFormAfterMaterialGap} from '../../src/lib/video/long-form/reconfigure-production.ts';
import {persistScriptChange} from '../../src/lib/video/script-persistence.ts';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function main(){
 const e=process.env,s=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}}),b=s.storage.from('videos');const privacy=await s.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const id='ed438c74-b0bb-43e1-8153-ea8c993d9877';const[q,a]=await Promise.all([s.from('video_requests').select('id,user_id,status,mode,render_attempts,duration_seconds,error_message,script_json,long_form_production_plan,long_form_confirmed_at').eq('id',id).single(),s.from('video_requests').select('user_id').eq('id','c6264af5-e4ec-8c36-9b9a-946bd4b09c03').single()]);
 if(q.error||a.error||q.data.user_id!==a.data.user_id||q.data.status!=='failed'||q.data.render_attempts!==2||q.data.mode!=='long_form'||q.data.duration_seconds!==180||!q.data.error_message?.startsWith('IMPEDIMENTO ANTES DE GASTAR: no existe material pertinente y único')||!q.data.long_form_confirmed_at)throw Error('scope');
 const paid=await s.from('pi_paid_operations').select('*',{head:true,count:'exact'}).eq('project_id',id);if(paid.error||paid.count!==0)throw Error('paid uncertainty');
 const original=q.data,plan=original.long_form_production_plan;if(plan.strategy!=='economical'||plan.aiImageCount!==0||plan.aiVideoClipCount!==0||plan.version!==3)throw Error('plan');
 const {script,edits}=adaptWeatherContext(original.script_json);
 const footageProvider=withSearchDeadline(getFootageProvider(),Date.now()+240000);if(footageProvider.name==='fixture')throw Error('real free stock not configured');
 const pre=await materialAvailabilityPreflight({plan,allocation:plan.allocation,beats:script.beats,topic:script.topic??'',footageProvider,aiVideoEnabled:false});
 const receipt={scope:'ONE_QA_EDITORIAL_MATERIAL_PREFLIGHT',original,proposed:script,edits,originalScriptSha256:hash(original.script_json),proposedScriptSha256:hash(script),planSha256:hash(plan),pre,paidOperations:0,at:new Date().toISOString(),nativeAttemptsPreserved:2};
 const filename=`mystery-shopper/v3/receipts/weather-material-${e.GITHUB_RUN_ID}.json`;
 const w=await b.upload(filename,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:{scope:receipt.scope,status:pre.status,missing:pre.missing.length,temporary:pre.temporary.length,edits,originalScriptSha256:receipt.originalScriptSha256,proposedScriptSha256:receipt.proposedScriptSha256}});if(w.error)throw Error('audit');
 if(e.MS_MATERIAL_APPLY==='1'){
  if(pre.status!=='ok')throw Error('no complete material');
  const opened=await reopenLongFormAfterMaterialGap(s,{requestId:id,userId:original.user_id});if(!opened.ok)throw Error('reconfigure proof');
  await persistScriptChange(s,{id,user_id:original.user_id,status:'script_ready',render_attempts:2,script_json:original.script_json},{script_json:script});
  const r=await b.upload(`mystery-shopper/v3/receipts/weather-applied-${e.GITHUB_RUN_ID}.json`,JSON.stringify({scope:'ONE_QA_EDITORIAL_APPLIED',source:filename,originalScriptSha256:receipt.originalScriptSha256,proposedScriptSha256:receipt.proposedScriptSha256,attemptsPreserved:2}),{contentType:'application/json',upsert:false,metadata:{scope:'ONE_QA_EDITORIAL_APPLIED',source:filename,attemptsPreserved:2}});if(r.error)throw Error('applied receipt');
 }
 console.log('Free material preflight saved privately; no paid call or render performed.');
}
main().catch(()=>{console.error('BLOCKED: QA material proof incomplete; no paid operation or render invoked.');process.exitCode=1;});
