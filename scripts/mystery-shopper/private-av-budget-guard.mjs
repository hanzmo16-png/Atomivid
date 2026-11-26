import {createClient} from '@supabase/supabase-js';
import {ledgerStore,canReserve,totals} from '../../src/lib/mystery-shopper/v3/ledger.ts';
const e=process.env;
async function main(){
 const sb=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const privacy=await sb.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const b=sb.storage.from('videos');
 const read=async(kind,id)=>{if(!/^\d+$/.test(id??''))throw Error('id');const r=await b.download(`mystery-shopper/v3/receipts/${kind}-${id}.json`);if(r.error||!r.data)throw Error('proof');return JSON.parse(await r.data.text());};
 const admission=await read('av-admission',e.MS_ADMISSION_RUN),quote=await read('av',e.MS_QUOTE_RUN);
 if(admission.origin!=='https://atomivid.vercel.app'||admission.status!=='PASS'||admission.authenticated!==true||admission.qaPilot!==true||admission.nonQaPilot!==false||admission.owner!==false||admission.internalOwner!==false)throw Error('admission');
 if(quote.authenticated!==true||quote.quote?.modality!=='avatar'||quote.quote?.host!=='virtual catalog victor'||quote.quote?.requestedSeconds!==60||!(quote.quote?.quote>0&&quote.quote.quote<=3)||quote.episodeId)throw Error('quote');
 const ledger=ledgerStore(b);if(await ledger.stopped())throw Error('stop');const state=await ledger.state();
 if(state.reservations.length!==new Set(state.reservations.map(x=>x.key)).size||state.settlements.length!==new Set(state.settlements.map(x=>x.key)).size||state.settlements.some(s=>!state.reservations.some(r=>r.key===s.key))||state.reservations.some(r=>!Number.isFinite(r.reservedUsd)||r.reservedUsd<0)||state.settlements.some(s=>!Number.isFinite(s.spentUsd)||s.spentUsd<0))throw Error('ledger');
 if(!canReserve(state,'video-podcast',3).ok)throw Error('budget');
 const receipt={kind:'AV_PRECLICK_BUDGET',ledger:totals(state),quote:quote.quote,admissionRun:e.MS_ADMISSION_RUN,quoteRun:e.MS_QUOTE_RUN,runCapUsd:3,cumulativeCapUsd:8.5};
 const w=await b.upload(`mystery-shopper/v3/receipts/av-budget-${e.GITHUB_RUN_ID}.json`,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('receipt');
 console.log('Private proofs and fresh unchanged cumulative/module budget verified. No provider calls.');
}
main().catch(()=>{console.error('AV generation blocked before reservation; private values withheld.');process.exitCode=1;});
