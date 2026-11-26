import {strictPrivateLedger} from './strict-private-ledger.mjs';
// Short-lived encrypted transport only. No account credentials or long-lived bypass secrets are exported.
import { createClient } from '@supabase/supabase-js';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { ledgerStore, totals } from '../../src/lib/mystery-shopper/v3/ledger.ts';
import { validatePreviewShare } from './preview-share.ts';
const env=process.env;
async function main(){
 const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),b=sb.storage.from('videos');
 const privacy=await sb.storage.getBucket('videos');if(privacy.error||privacy.data.public!==false)throw Error('privacy');
 const origin=new URL(env.MS_TARGET).origin;if(!/^https:\/\/[a-z0-9-]+-atomivid\.vercel\.app$/.test(origin))throw Error('target');
 const write=async(p,value,metadata)=>{const q=await b.upload(p,value,{contentType:'application/json',upsert:false,metadata});if(q.error)throw Error('write');};
 if(env.MS_ACCESS_OPERATION==='prepare'){
  const id=env.GITHUB_RUN_ID;if(!/^\d+$/.test(id))throw Error('id');
  const keys=generateKeyPairSync('rsa',{modulusLength:4096,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const ledger=ledgerStore(b);if(await ledger.stopped())throw Error('stopped');const state=await strictPrivateLedger(b);
  // Reject corrupted/ambiguous accounting; never infer zero from a missing read.
  if(state.reservations.length!==new Set(state.reservations.map(x=>x.key)).size||state.settlements.length!==new Set(state.settlements.map(x=>x.key)).size||state.settlements.some(s=>!state.reservations.some(r=>r.key===s.key))||state.reservations.some(r=>!Number.isFinite(r.reservedUsd)||r.reservedUsd<0)||state.settlements.some(s=>!Number.isFinite(s.spentUsd)||s.spentUsd<0))throw Error('ledger');
  const t=totals(state);if(t.committedUsd>8.5||t.openReservedUsd!==0)throw Error('budget');
  const receipt={nativeConfig:{targetMatches:env.MS_NATIVE_TARGET_MATCHES==='true',qaEnabled:env.MS_NATIVE_QA_ENABLED==='true',nativeOwnerGateNotDisabled:env.MS_NATIVE_OWNER_GATE_ENABLED==='true'},kind:'SEALED_PREVIEW_ACCESS',keyId:id,origin,expiresAt:Date.now()+3600000,publicKey:keys.publicKey,ledger:t,availableUsd:Math.round((8.5-t.committedUsd)*100)/100};
  await write(`mystery-shopper/v3/preview-access/${id}/private.json`,JSON.stringify({privateKey:keys.privateKey}));
  await write(`mystery-shopper/v3/preview-access/${id}/receipt.json`,JSON.stringify(receipt),receipt);
  console.log('Temporary encryption recipient and fresh accounting receipt saved privately. No provider calls.');return;
 }
 const id=env.MS_ACCESS_KEY_ID;if(!/^\d+$/.test(id??'')||!/^\d+$/.test(env.GITHUB_RUN_ID??''))throw Error('id');
 const read=async p=>{const q=await b.download(p);if(q.error||!q.data)throw Error('read');return JSON.parse(await q.data.text());};
 const receipt=await read(`mystery-shopper/v3/preview-access/${id}/receipt.json`);
 if(receipt.kind!=='SEALED_PREVIEW_ACCESS'||receipt.keyId!==id||receipt.origin!==origin||!Number.isFinite(receipt.expiresAt)||receipt.expiresAt<=Date.now())throw Error('expired');
 const {privateKey}=await read(`mystery-shopper/v3/preview-access/${id}/private.json`);
 const cipher=env.MS_ACCESS_CIPHERTEXT;if(!/^[A-Za-z0-9+/=]{684}$/.test(cipher??''))throw Error('cipher');
 const payload=JSON.parse(privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(cipher,'base64')).toString('utf8'));
 if(payload.keyId!==id||payload.origin!==origin||payload.expiresAt!==receipt.expiresAt)throw Error('binding');
 const url=validatePreviewShare(origin,payload.url);
 // upsert:false is the one-use claim; a replay never reaches any generation step.
 await write(`mystery-shopper/v3/preview-access/${id}/consumed.json`,JSON.stringify({run:env.GITHUB_RUN_ID,at:new Date().toISOString()}));
 console.log(`::add-mask::${url}`);console.log(`::add-mask::${new URL(url).searchParams.get('_vercel_share')}`);
 await appendFile(env.GITHUB_ENV,`MS_PREVIEW_ACCESS_URL=${url}\n`);console.log('Temporary access decrypted for the pinned Preview only.');
}
main().catch(()=>{console.error('BLOCKED: temporary access or fresh accounting could not be verified; protected values withheld.');process.exitCode=1;});
