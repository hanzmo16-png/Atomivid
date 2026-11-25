// Read only. No browser/provider calls, writes, or plaintext evidence emitted.
import {createClient} from '@supabase/supabase-js';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
async function main(){
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(u,i)=>fetch(u,{...i,signal:AbortSignal.timeout(15000)})}});
 const bucket=sb.storage.from('videos'),prefix='mystery-shopper/v3/ledger';
 const list=await bucket.list(prefix,{limit:1000});if(list.error||!list.data||list.data.length>=1000)throw Error('read');
 const ledger=[];for(const f of list.data){if(!/^(reserve-|settle-).*\.json$/.test(f.name))continue;const r=await bucket.download(`${prefix}/${f.name}`);if(r.error||!r.data)throw Error('read');ledger.push({file:f.name,value:JSON.parse(await r.data.text())});}
 const reel='c6264af5-e4ec-8c36-9b9a-946bd4b09c03',audio='9241d2a6-064b-4ecc-9fd7-6b2bf4594d12';
 const vr=await sb.from('video_requests').select('user_id,status,render_attempts').eq('id',reel).single();if(vr.error||!vr.data)throw Error('read');
 const ap=await bucket.download(`audio-studio/v1/${vr.data.user_id}/${audio}.json`);if(ap.error||!ap.data)throw Error('read');const p=JSON.parse(await ap.data.text());
 const ops=await sb.from('pi_paid_operations').select('provider,method,status,reserved_usd,committed_usd,supply_reconciled').eq('project_id',reel);if(ops.error)throw Error('read');
 const payload={at:new Date().toISOString(),ledger,stop:list.data.some(x=>x.name==='STOP'),reel:{status:vr.data.status,attempts:vr.data.render_attempts,operations:ops.data},audio:{status:p.status,revision:p.revision,spentUsd:p.spentUsd,budgetUsd:p.budgetUsd,audioExists:!!p.audio,generation:p.generation},scope:'READ_ONLY_NO_PROVIDER_OR_BROWSER_CALLS'};
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);
 const pub=await readFile('scripts/mystery-shopper/private-recipient-public.pem'),wrapped=publicEncrypt({key:pub,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
 await mkdir(process.env.PRIVATE_OUT,{recursive:true});await writeFile(`${process.env.PRIVATE_OUT}/sealed.json`,JSON.stringify({version:1,algorithm:'RSA-OAEP-SHA256+A256GCM',key:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
 console.log('Encrypted read-only receipt ready. No plaintext evidence emitted.');
}
main().catch(()=>{console.error('Private readback blocked; raw data withheld.');process.exitCode=1;});
