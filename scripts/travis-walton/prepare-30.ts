/** Deterministic input preparation only. Grok owns the final render/publish. */
import {createClient} from '@supabase/supabase-js';
import {createHash,privateDecrypt,createDecipheriv} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {MUSIC_MANIFEST} from '../../src/lib/providers/music/manifest';

export async function prepareThirty(cfg:any,seal:(name:string,b:Buffer)=>void,publish=false){
 const root='/tmp/travis-thirty',url=process.env.SUPABASE_URL!.trim(),apikey='sb_publishable_npUkxyz-qq8vmnifwE6lNQ_37tiQttZ';
 mkdirSync(root,{recursive:true});mkdirSync(`${root}/narration`,{recursive:true});mkdirSync(`${root}/music`,{recursive:true});
 const db=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const owner=createClient(url,apikey,{auth:{persistSession:false,autoRefreshToken:false}});
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const get=async(path:string,bucket='videos')=>{const r=await db.storage.from(bucket).download(path);if(r.error||!r.data)throw Error('THIRTY_SOURCE_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());};
 const run=async(tag:string,command:string,args:string[])=>{
  const path=`${root}/${tag}.log`,fd=openSync(path,'w');console.log('THIRTY_STAGE',JSON.stringify({stage:tag,state:'started'}));
  try{await new Promise<void>((resolve,reject)=>{const p=spawn(command,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production'},stdio:['ignore',fd,fd]});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('THIRTY_STAGE_FAILED_'+tag)));});}
  catch(e){seal(`${tag}-diagnostic.txt`,readFileSync(path));throw e;}finally{closeSync(fd);}
  console.log('THIRTY_STAGE',JSON.stringify({stage:tag,state:'passed'}));
 };
 const [ek,iv,tag,ct]=readFileSync('ops/travis-walton/expansion.json.sealed','utf8').trim().split('.').map(x=>Buffer.from(x,'base64'));
 const key=privateDecrypt({key:await get('ops/podcast-episode/runner-key.pem'),oaepHash:'sha256'},ek),d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);
 const planBytes=Buffer.concat([d.update(ct),d.final()]),plan=JSON.parse(planBytes.toString());
 if(plan.episodeId!==cfg.episodeId||plan.targetSeconds!==1800||plan.authorizedTotalVoiceCapUsd!==5.58)throw Error('THIRTY_PLAN_MISMATCH');
 const prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}/expansion-30/${sha(planBytes).slice(0,16)}`;
 const mBytes=await get(`${prefix}/manifest.json`),m=JSON.parse(mBytes.toString());
 writeFileSync(`${root}/voice.json`,mBytes);
 for(const b of m.blocks){const bytes=await get(b.path);if(sha(bytes)!==b.sha256)throw Error('THIRTY_VOICE_HASH');writeFileSync(`${root}/narration/${b.id}.mp3`,bytes);}
 for(const id of ['elevenlabs-tension-1','elevenlabs-tension-2','elevenlabs-reflective-1','elevenlabs-cinematic-2']){
  const track=MUSIC_MANIFEST.find(t=>t.id===id);if(!track)throw Error('THIRTY_MUSIC_MISSING');writeFileSync(`${root}/music/${id}.mp3`,await get(track.storagePath,'music-library'));
 }
 const u=await db.auth.admin.getUserById(cfg.ownerId);if(!u.data.user?.email)throw Error('THIRTY_OWNER_MISSING');
 const link=await db.auth.admin.generateLink({type:'magiclink',email:u.data.user.email});if(link.error)throw Error('THIRTY_OWNER_LINK');
 const signed=await owner.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});if(signed.error||!signed.data.session)throw Error('THIRTY_OWNER_SESSION');
 const credential=`${root}/owner-session.json`;writeFileSync(credential,JSON.stringify({url,apikey,ownerId:cfg.ownerId,episodeId:cfg.episodeId,session:signed.data.session}),{mode:0o600});
 try{
  await run('fetch-v4','python3',['scripts/travis-walton/owner_inputs_30.py','fetch',root]);
  renameSync(`${root}/source-v4/entrada`,`${root}/entrada`);writeFileSync(`${root}/v4.json`,readFileSync(`${root}/entrada/montaje.json`));
  const stocks=JSON.parse(readFileSync('ops/travis-walton/expansion-stock.json','utf8'));
  for(const s of stocks){
   const r=await fetch(s.url,{signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error('THIRTY_STOCK_HTTP');
   const bytes=Buffer.from(await r.arrayBuffer()),length=r.headers.get('content-length');
   if((length&&Number(length)!==bytes.length)||bytes.length<10000)throw Error('THIRTY_STOCK_INCOMPLETE');
   writeFileSync(`${root}/entrada/medios/${s.sourceId}.mp4`,bytes);
  }
  writeFileSync(`${root}/stocks.json`,Buffer.from(JSON.stringify(stocks)));
  await run('assemble-inputs','python3',['scripts/travis-walton/build_30_inputs.py',root]);
  await run('validate-every-source','python3',['scripts/podcast-editor-v3/editor.py','validate',`${root}/entrada/montaje.json`,'--archivos']);
  const report=readFileSync(`${root}/preparation-report.json`);
  seal('thirty-preparation-report.json',report);seal('thirty-montaje.json',readFileSync(`${root}/entrada/montaje.json`));
  seal('thirty-stock-sheet.jpg',readFileSync(`${root}/stock-sheet.jpg`));seal('thirty-voice-sample.mp3',readFileSync(`${root}/voice-sample.mp3`));
  if(publish){
   const expected=readFileSync('ops/travis-walton/approved-input-sha256','utf8').trim();
   if(sha(readFileSync(`${root}/entrada/montaje.json`))!==expected)throw Error('THIRTY_REVIEWED_MANIFEST_MISMATCH');
   await run('publish-inputs','python3',['scripts/travis-walton/owner_inputs_30.py','inputs',root]);
   const saved=await db.storage.from('videos').upload(`${prefix}/prepared-inputs-v5.json`,report,{contentType:'application/json',upsert:false});
   if(saved.error){const old=await get(`${prefix}/prepared-inputs-v5.json`);if(sha(old)!==sha(report))throw Error('THIRTY_RECEIPT_CONFLICT');}
  }
  console.log('THIRTY_INPUTS_READY',JSON.stringify({...JSON.parse(report.toString()),published:publish,paidCalls:0}));
 }finally{
  const latest=JSON.parse(readFileSync(credential,'utf8'));const result=await db.auth.admin.signOut(latest.session.access_token,'local');unlinkSync(credential);
  if(result.error)throw Error('THIRTY_OWNER_LOGOUT_FAILED');console.log('THIRTY_OWNER_SESSION_CLOSED');
 }
}
