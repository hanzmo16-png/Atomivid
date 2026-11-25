// Store the reconciliation snapshot ONLY inside the existing private app bucket.
import{createClient}from'@supabase/supabase-js';import{createHash}from'node:crypto';import{totals}from'../../src/lib/mystery-shopper/v3/ledger.ts';
async function main(){
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
 const info=await sb.storage.getBucket('videos');if(info.error||info.data.public!==false)throw Error('privacy');
 const bucket=sb.storage.from('videos'),prefix='mystery-shopper/v3/ledger',l=await bucket.list(prefix,{limit:1000});if(l.error||!l.data||l.data.length>=1000)throw Error('list');
 const state={reservations:[],settlements:[]},raw=[];
 for(const f of [...l.data].sort((a,b)=>a.name.localeCompare(b.name))){if(!/^(reserve-|settle-).*\.json$/.test(f.name))continue;const r=await bucket.download(`${prefix}/${f.name}`);if(r.error||!r.data)throw Error('read');const text=await r.data.text(),x=JSON.parse(text);if(!x.key)throw Error('key');raw.push([f.name,text]);if(f.name.startsWith('reserve-')){if(!['youtube','audio-podcast','reels','video-podcast'].includes(x.module)||!Number.isFinite(x.reservedUsd)||x.reservedUsd<=0)throw Error('reserve');state.reservations.push(x);}else{if(!Number.isFinite(x.spentUsd)||x.spentUsd<0)throw Error('settle');state.settlements.push(x);}}
 const keys=new Set(state.reservations.map(x=>x.key));if(keys.size!==state.reservations.length||new Set(state.settlements.map(x=>x.key)).size!==state.settlements.length||state.settlements.some(x=>!keys.has(x.key)))throw Error('integrity');
 const t=totals(state),receipt={at:new Date().toISOString(),scope:'AUTHORIZED_CAMPAIGN_LEDGER_NOT_PROVIDER_WALLET',...t,availableUsd:Math.round((8.5-t.committedUsd)*100)/100,stop:l.data.some(x=>x.name==='STOP'),sourceSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
 if(receipt.availableUsd<0)throw Error('overrun');
 const path=`mystery-shopper/v3/receipts/endgame-20261125-${process.env.GITHUB_RUN_ID}.json`;
 const w=await bucket.upload(path,JSON.stringify(receipt),{contentType:'application/json',upsert:false,metadata:receipt});if(w.error)throw Error('write');const b=await bucket.download(path);if(b.error||!b.data||await b.data.text()!==JSON.stringify(receipt))throw Error('readback');console.log('PASS: private campaign receipt verified. No values or screenshots exported to GitHub.');
}
main().catch(()=>{console.error('BLOCKED: private receipt could not be verified. No financial data emitted.');process.exitCode=1;});
