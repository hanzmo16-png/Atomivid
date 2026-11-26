import {createClient} from '@supabase/supabase-js';
import {strictPrivateLedger} from './strict-private-ledger.mjs';
import {totals} from '../../src/lib/mystery-shopper/v3/ledger.ts';
async function main(){
 const e=process.env,s=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),b=s.storage.from('videos');
 const privacy=await s.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 if(!/^\d+$/.test(e.MS_AV_RUN_ID??''))throw Error('run');
 const read=async prefix=>{const r=await b.download(`mystery-shopper/v3/receipts/${prefix}-${e.MS_AV_RUN_ID}.json`);if(r.error||!r.data)throw Error('proof');return JSON.parse(await r.data.text());};
 const accepted=await read('av-accepted'),journey=await read('av');
 if(accepted.accepted!==true||accepted.kind!=='AV_POST_ACCEPTED'||accepted.episodeId!==journey.episodeId||journey.authenticated!==true||journey.humanGate!==null||journey.failures?.length!==0)throw Error('journey');
 const cost=Number(journey.native?.episode?.cost_usd);if(!Number.isFinite(cost)||cost<0||cost>accepted.authorizedUsd)throw Error('cost');
 const state=await strictPrivateLedger(b),t=totals(state),reservations=state.reservations.filter(x=>x.module==='video-podcast');
 if(reservations.length!==1||reservations[0].reservedUsd!==accepted.authorizedUsd||state.settlements.length!==new Set(state.settlements.map(x=>x.key)).size||state.reservations.length!==new Set(state.reservations.map(x=>x.key)).size)throw Error('history');
 const settlements=state.settlements.filter(x=>x.key===reservations[0].key);if(settlements.length!==1||settlements[0].spentUsd!==Math.ceil((cost-Number.EPSILON)*100)/100||t.committedUsd>8.5||t.openReservedUsd!==0)throw Error('settlement');
 const q=await s.from('podcast_studio_episodes').select('status,cost_usd,estimate,result').eq('id',accepted.episodeId).single();if(q.error||q.data.status!=='ready'||Number(q.data.cost_usd)!==cost)throw Error('native');
 const receipt={scope:'PRIVATE_AV_FINAL_ACCOUNTING_READ_ONLY',ledger:t,availableUsd:Math.round((8.5-t.committedUsd)*100)/100,reservations,settlements,nativeRegisteredUsd:Number(q.data.cost_usd),nativeRunnerQuoteEstimateUsd:q.data.estimate.lines.find(x=>x.concept==='render')?.usd??null,invoiceVerified:false,durationSeconds:q.data.result.duration};
 const w=await b.upload(`mystery-shopper/v3/receipts/av-final-audit-${e.GITHUB_RUN_ID}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('receipt');
 console.log('Final immutable AV settlement and cumulative ledger read back privately. No ledger mutation or provider call.');
}
main().catch(()=>{console.error('Final AV accounting readback blocked; original ledger preserved.');process.exitCode=1;});
