import {createClient} from '@supabase/supabase-js';
import {request} from 'playwright';
import {randomUUID} from 'node:crypto';
import {studioOwnerSignature} from '../../src/lib/podcast/v3/owner-check.ts';
import {validatePreviewShare} from './preview-share.ts';
const e=process.env;
async function main(){
 const origin='https://atomivid-ifh6x9b59-atomivid.vercel.app';
 if(e.MS_TARGET!==origin)throw Error('target');
 const sb=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const bucket=await sb.storage.getBucket('videos');if(bucket.error||bucket.data.public!==false)throw Error('privacy');
 const result={kind:'PRIVATE_AV_ADMISSION',origin,status:'BLOCKED',authenticated:false,qaPilot:false,nonQaPilot:null,owner:null,internalOwner:null};
 let client;
 try{
  const authClient=createClient(e.NEXT_PUBLIC_SUPABASE_URL,e.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await authClient.auth.signInWithPassword({email:e.MYSTERY_SHOPPER_QA_EMAIL,password:e.MYSTERY_SHOPPER_QA_PASSWORD});
  const qa=auth.data?.user;if(auth.error||qa?.id!=='95c182e1-2549-4ef8-a4a4-924fd2890683'||!qa.email_confirmed_at)throw Error('qa');
  result.authenticated=true;
  const users=await sb.auth.admin.listUsers({page:1,perPage:1000});if(users.error)throw Error('users');
  const other=users.data.users.find(u=>u.id!==qa.id&&u.email_confirmed_at);if(!other)throw Error('nonqa');
  client=await request.newContext();
  const access=await client.get(validatePreviewShare(origin,e.MS_PREVIEW_ACCESS_URL),{maxRedirects:0});await access.dispose();
  const check=async userId=>{
   const nonce=randomUUID(),time=String(Date.now());
   const r=await client.post(origin+'/api/internal/studio-owner',{maxRedirects:0,data:{userId},headers:{'x-probe-nonce':nonce,'x-probe-time':time,'x-probe-signature':studioOwnerSignature(e.SUPABASE_SERVICE_ROLE_KEY.trim(),userId,nonce,time)}});
   if(r.status()!==200)throw Error('admission');const j=await r.json();if(['owner','internalOwner','qaPilot'].some(k=>typeof j[k]!=='boolean'))throw Error('shape');return j;
  };
  const a=await check(qa.id),b=await check(other.id);
  Object.assign(result,{qaPilot:a.qaPilot,nonQaPilot:b.qaPilot,owner:a.owner,internalOwner:a.internalOwner});
  if(!a.qaPilot||b.qaPilot||a.owner||a.internalOwner)throw Error('scope');
  result.status='PASS';
 }catch{result.status='BLOCKED';}
 finally{
  await client?.dispose();
  const w=await sb.storage.from('videos').upload(`mystery-shopper/v3/receipts/av-admission-${e.GITHUB_RUN_ID}.json`,JSON.stringify(result),{contentType:'application/json',upsert:false,metadata:result});if(w.error)throw Error('receipt');
 }
 console.log('Admission receipt saved privately; no provider calls or generation.');if(result.status!=='PASS')process.exitCode=1;
}
main().catch(()=>{console.error('Admission blocked; private values withheld.');process.exitCode=1;});
