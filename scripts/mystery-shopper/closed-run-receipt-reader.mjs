import {createClient} from '@supabase/supabase-js';
const RUN = '45856688839';
const REPO = 'hanzmo16-png/Atomivid';
const ROOTS = ['mystery-shopper/private-focused-longform','mystery-shopper/private-final-readonly'];
const OUTPUT = `mystery-shopper/private-receipt-readback/${RUN}/aggregate.json`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? x : undefined;
const num = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
const bool = x => typeof x === 'boolean' ? x : undefined;
const safeFile = x => typeof x === 'string' && ROOTS.some(root=>new RegExp(`^${root}/[0-9a-f-]{36}/screen-\\d+\\.png$`).test(x)) ? x : undefined;
const player = x => x && {width:num(x.width),height:num(x.height),durationSeconds:num(x.durationSeconds),timeAdvancedSeconds:num(x.timeAdvancedSeconds)};
const digest = x => x && {bytes:num(x.bytes),sha256:hash(x.sha256)};
export function sanitizeReceipt(raw) {
  if (String(raw?.runId) !== RUN || ![true,false].includes(raw.passed)) throw Error('receipt attribution unavailable');
  return {
    runId:RUN,passed:raw.passed,checkpoint:['browser-login','actual-onboarding','library','completed-result','download','complete','existing-AV-library','existing-AV-player','existing-AV-streamed-download','module-navigation','completed-video','completed-audio'].includes(raw.checkpoint)?raw.checkpoint:undefined,
    productionCommit:typeof raw.productionCommit==='string' && /^[0-9a-f]{40}$/.test(raw.productionCommit)?raw.productionCommit:undefined,
    renderAttempt:num(raw.renderAttempt),delivery:digest(raw.delivery),blockedRequests:num(raw.blockedRequests),paidCalls:num(raw.paidCalls),jobsCreated:num(raw.jobsCreated),
    audioExistingMp3:raw.audioExistingMp3==='VERIFIED_PLAYBACK_AND_SHA256'?'VERIFIED_PLAYBACK_AND_SHA256':undefined,
    viewports:Array.isArray(raw.viewports)?raw.viewports.slice(0,2).map(v=>({width:num(v.width),height:num(v.height),libraryVisible:bool(v.libraryVisible),downloadShaMatches:bool(v.downloadShaMatches),player:player(v.player),onboarding:v.onboarding && {visible:bool(v.onboarding.visible),modal:bool(v.onboarding.modal),exitReachable:bool(v.onboarding.exitReachable)},avEpisode:v.avEpisode && {player:player(v.avEpisode.player),delivery:digest(v.avEpisode.delivery)}})):[],
    screens:Array.isArray(raw.screens)?raw.screens.slice(0,32).map(s=>({width:num(s.width),height:num(s.height),passed:bool(s.passed),file:safeFile(s.file),bytes:num(s.bytes),sha256:hash(s.sha256),planQuotaVisible:bool(s.planQuotaVisible),internalQuotaExpected:s.planQuotaExpectation==='INTERNAL_ACCOUNT_NOTE_ABSENT'?true:undefined})):[],
    captureDigests:Array.isArray(raw.receipts)?raw.receipts.slice(0,32).map(digest):[],
  };
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== REPO || !process.env.GITHUB_TOKEN || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error('bindings unavailable');
  // Fixed exact run, read once. A running browser job cannot be inspected by this reader.
  const response = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${RUN}`,{headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('closed run unavailable');
  const run = await response.json();
  if (String(run.id)!==RUN || run.status!=='completed' || run.repository?.full_name!==REPO || !run.run_started_at || !run.updated_at) throw Error('exact run not closed');
  const start=Date.parse(run.run_started_at), end=Date.parse(run.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end<start || end-start>30*60*1000) throw Error('run window unavailable');
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const info=await sb.storage.getBucket('videos');
  if(info.error || info.data.public!==false)throw Error('private bucket required');
  const bucket=sb.storage.from('videos');const receipts=[];const coverage=[];
  // Root identified this exact failed-run prefix by Storage metadata. Never inspect unrelated receipts.
  const prefix='mystery-shopper/private-focused-longform/9e4d5ee4-b0da-4c07-8f30-8a2979307554';
  const objects=await bucket.list(prefix,{limit:64});
  if(objects.error || !objects.data || objects.data.length>=64)throw Error('bounded metadata list unavailable');
  const object=objects.data.find(x=>x.name==='receipt.json');
  const created=Date.parse(object?.created_at ?? '');
  if(!object || !Number.isFinite(created) || created<start || created>end)throw Error('pinned receipt outside closed run');
  const source=`${prefix}/receipt.json`;
  const file=await bucket.download(source);
  if(file.error || !file.data || file.data.size>65536)throw Error('bounded receipt unavailable');
  const sanitized=sanitizeReceipt(JSON.parse(await file.data.text()));
  const signed=await bucket.createSignedUrl(source,300);
  if(signed.error || !signed.data?.signedUrl)throw Error('private receipt link unavailable');
  receipts.push({source,createdAt:object.created_at,receiptBytes:file.data.size,screenshotObjectCount:objects.data.filter(x=>/^screen-\d+\.png$/.test(x.name)).length,receipt:sanitized,privateReceiptUrlExpiresInSeconds:300,privateReceiptUrl:signed.data.signedUrl});
  coverage.push({prefix,matched:1});
  const out={version:1,runId:RUN,runStatus:'completed',runConclusion:['success','failure','cancelled','timed_out','skipped','neutral','action_required','stale'].includes(run.conclusion)?run.conclusion:'unknown',coverage,receipts,readAt:new Date().toISOString(),scope:'EXACT_CLOSED_RUN_RECEIPTS_ONLY_NO_SCREEN_BODY_READ'};
  const saved=await bucket.upload(OUTPUT,JSON.stringify(out),{contentType:'application/json',upsert:false});
  if(saved.error)throw Error('private aggregate unavailable');
  console.log('PASS: exact closed-run aggregate retained privately; no browser executed.');
}
if(process.env.MS_RECEIPT_DIAGNOSTIC==='1')main().catch(()=>{console.error('FAIL: bounded private receipt diagnostic incomplete.');process.exitCode=1;});
