/** Read-only official voice connection check with pinned compatible audio decoding. */
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createServiceClient} from '../../src/lib/supabase/service';import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const sb=createServiceClient(),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb);
 const auth=await ledger.get('vfx_closing_voice_authorization_v1');if(auth?.status!=='COMMITTED'||auth.method!=='human_direction'||!auth.resultRef)throw new Error('VFX_VOICE_NOT_AUTHORIZED');const c=JSON.parse(auth.resultRef);
 const owner=await sb.from('vfx_director_jobs').select('owner_id').eq('id','precampaign-three-worlds-v1-preparation').maybeSingle();const u=await sb.auth.admin.getUserById(c.ownerId);if(owner.error||owner.data?.owner_id!==c.ownerId||u.error||!u.data.user?.email_confirmed_at)throw new Error('VFX_OWNER_UNVERIFIED');
 const key=process.env.ELEVENLABS_API_KEY;if(!key)throw new Error('VFX_VOICE_KEY_MISSING');
 const get=async(path:string)=>{const r=await fetch('https://api.elevenlabs.io/v1/'+path,{headers:{'xi-api-key':key},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('VFX_VOICE_PREFLIGHT_HTTP_'+r.status);return r.json();};
 const [voice,models,subscription]=await Promise.all([get('voices/'+encodeURIComponent(c.voiceId)),get('models'),get('user/subscription')]);
 const diagRow=await ledger.get('vfx_closing_voice_diagnostics_v1');const diagConfig=diagRow?.status==='COMMITTED'&&diagRow.resultRef?JSON.parse(diagRow.resultRef):{paths:[]};
 const diagnostics=[];for(const path of diagConfig.paths){diagnostics.push({path,data:await results.getJson(path)});}
 await ledger.insert({idempotencyKey:'vfx_closing_voice_connection_'+process.env.GITHUB_RUN_ID,projectId:c.projectId,shotId:'closing-voice-connection',provider:'internal',model:'voice-preflight/1',method:'read_only_preflight',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({checkedAt:new Date().toISOString(),voice,models,subscription,diagnostics,paidCalls:0}),updatedAt:new Date().toISOString()});
 const model=models.find((m:{model_id:string})=>m.model_id===c.modelId);if(!model?.can_do_voice_conversion||!model.languages?.some((l:{language_id:string})=>l.language_id==='es'))throw new Error('VFX_SPANISH_CONVERSION_UNAVAILABLE');
 const root=await mkdtemp(join(tmpdir(),'voice-preflight-'));
 try{
  const src=await results.getBytes(c.sourcePath);if(!src||hash(src)!==c.sourceSha256)throw new Error('VFX_VOICE_SOURCE_CHANGED');await writeFile(join(root,'original.mp4'),src);
  await promisify(execFile)('python3',['scripts/vfx/closing-voice-transcribe.py',root],{timeout:10*60_000,maxBuffer:1024*1024});
  const transcript=JSON.parse(await readFile(join(root,'transcript.json'),'utf8'));
  const report={checkedAt:new Date().toISOString(),sourceSha256:c.sourceSha256,voiceId:c.voiceId,voiceName:voice.name,voiceCategory:voice.category,voiceSharing:voice.sharing,modelId:c.modelId,model: model,subscription,transcript,paidCalls:0};
  if(!await ledger.insert({idempotencyKey:'vfx_closing_voice_preflight_'+process.env.GITHUB_RUN_ID,projectId:c.projectId,shotId:'closing-voice-preflight',provider:'internal',model:'voice-preflight/1',method:'read_only_preflight',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify(report),updatedAt:new Date().toISOString()}))throw new Error('VFX_PREFLIGHT_EXISTS');
  console.log(JSON.stringify({connectionVerified:true,voiceAvailable:true,spanishConversionAvailable:true,speechAnalyzed:true,paidCalls:0}));
 }catch(e){const err=e as Error&{stderr?:string};await ledger.insert({idempotencyKey:'vfx_closing_voice_failure_'+process.env.GITHUB_RUN_ID,projectId:c.projectId,shotId:'closing-voice-failure',provider:'internal',model:'voice-preflight/1',method:'private_diagnostic',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({message:err.message,stderr:err.stderr,paidCalls:0}),updatedAt:new Date().toISOString()});throw new Error('VFX_VOICE_PREFLIGHT_FAILED_PRIVATE_DIAGNOSTIC_SAVED');}finally{await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_VOICE_PREFLIGHT_BLOCKED');process.exitCode=1;});
