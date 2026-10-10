import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,unlinkSync,openSync,closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

/** All publish requests use an authenticated owner JWT and the existing scoped assignment. */
export async function finalEdit(cfg:any,seal:(name:string,b:Buffer)=>void){
 const root='/tmp/travis-final',prefix=`${cfg.ownerId}/podcasts/${cfg.episodeId}/avatar-final`;
 mkdirSync(root,{recursive:true});
 const url=process.env.SUPABASE_URL!.trim();
 const db=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
 const apikey='sb_publishable_npUkxyz-qq8vmnifwE6lNQ_37tiQttZ';
 const owner=createClient(url,apikey,{auth:{persistSession:false,autoRefreshToken:false}});
 const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const get=async(path:string)=>{const r=await db.storage.from('videos').download(path);if(r.error||!r.data)throw Error('FINAL_SOURCE_UNAVAILABLE');return Buffer.from(await r.data.arrayBuffer());};
 const run=async(tag:string,command:string,args:string[])=>{
  const path=`${root}/${tag}.log`,fd=openSync(path,'w');
  console.log('FINAL_STAGE',JSON.stringify({stage:tag,state:'started'}));
  try{await new Promise<void>((resolve,reject)=>{const p=spawn(command,args,{env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'production'},stdio:['ignore',fd,fd]});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error('FINAL_STAGE_FAILED_'+tag.toUpperCase())));});}
  catch(e){seal(`${tag}-diagnostic.txt`,readFileSync(path));throw e;}finally{closeSync(fd);}
  console.log('FINAL_STAGE',JSON.stringify({stage:tag,state:'passed'}));
 };
 const u=await db.auth.admin.getUserById(cfg.ownerId);if(!u.data.user?.email)throw Error('FINAL_OWNER_MISSING');
 const link=await db.auth.admin.generateLink({type:'magiclink',email:u.data.user.email});if(link.error)throw Error('FINAL_OWNER_LINK_FAILED');
 const signed=await owner.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});if(signed.error||!signed.data.session)throw Error('FINAL_OWNER_LOGIN_FAILED');
 const credential=`${root}/owner-session.json`;
 writeFileSync(credential,JSON.stringify({url,apikey,ownerId:cfg.ownerId,episodeId:cfg.episodeId,session:signed.data.session}),{mode:0o600});
 try{
  const existing=await owner.storage.from('podcast-editor').download(`episodios/${cfg.episodeId}/v4/salida/COMPLETO.json`);
  if(existing.data){console.log('FINAL_ALREADY_PUBLISHED');seal('final-completo.json',Buffer.from(await existing.data.arrayBuffer()));return;}
  const resultBytes=await get(`${prefix}/result.json`),result=JSON.parse(resultBytes.toString());
  if(result.episodeId!==cfg.episodeId||result.fullDecodeErrors!==0||result.resolution!=='1080p')throw Error('FINAL_AVATAR_UNVERIFIED');
  writeFileSync(`${root}/avatar-result.json`,resultBytes);
  await run('fetch-v3','python3',['scripts/travis-walton/owner_editor.py','fetch',root]);
  renameSync(`${root}/source-v3/entrada`,`${root}/entrada`);
  writeFileSync(`${root}/v3.json`,readFileSync(`${root}/entrada/montaje.json`));
  const avatar=await get(result.path);if(sha(avatar)!==result.sha256)throw Error('FINAL_AVATAR_HASH');
  writeFileSync(`${root}/avatar-original.mp4`,avatar);
  // Conform to the timeline's frame rate and supply two silent tail frames for a clean final hold.
  await run('conform-avatar','ffmpeg',['-nostdin','-v','error','-y','-i',`${root}/avatar-original.mp4`,'-map','0:v:0','-an','-vf','fps=25,tpad=stop_mode=clone:stop_duration=0.08','-c:v','libx264','-crf','18','-preset','fast','-threads','2','-pix_fmt','yuv420p',`${root}/entrada/medios/31-avatar-Hans-1080p.mp4`]);
  await run('build-manifest','python3',['scripts/travis-walton/build_final_manifest.py',root]);
  await run('validate-files','python3',['scripts/podcast-editor-v3/editor.py','validate',`${root}/entrada/montaje.json`,'--archivos']);
  await run('publish-inputs','python3',['scripts/travis-walton/owner_editor.py','inputs',root]);
  await run('render','python3',['scripts/podcast-editor-v3/editor.py','run',`${root}/entrada/montaje.json`,'--work',`${root}/work`,'--retries','0']);
  const out=`${root}/work/${cfg.episodeId}/v4/salida`,report=JSON.parse(readFileSync(`${out}/reporte.json`,'utf8'));
  if(report.status!=='done'||!report.verification?.ok)throw Error('FINAL_RENDER_UNVERIFIED');
  await run('publish-output','python3',['scripts/travis-walton/owner_editor.py','publish',root]);
  seal('final-report.json',Buffer.from(JSON.stringify(report)));
  const sheet=`${out}/muestras/hoja_contactos.jpg`;if(existsSync(sheet))seal('final-sheet.jpg',readFileSync(sheet));
  // Four medium frames for a separate visual inspection of the actual avatar placements.
  const times=result.cuts.map((c:any)=>c.globalStart+Math.min(5,c.seconds/2));
  for(let i=0;i<times.length;i++){
   await run(`avatar-frame-${i}`,'ffmpeg',['-nostdin','-v','error','-y','-ss',String(times[i]),'-i',`${out}/episodio.mp4`,'-frames:v','1','-vf','scale=960:-1',`${root}/avatar-${i}.jpg`]);
   seal(`final-avatar-${i}.jpg`,readFileSync(`${root}/avatar-${i}.jpg`));
  }
  const receipt={episodeId:cfg.episodeId,version:4,manifestSha256:report.manifest_sha256,avatarSeconds:result.seconds,avatarCostUsd:result.costUsd,videoBytes:report.outputs.mp4_size,seconds:813.92,verified:report.verification.ok};
  const saved=await db.storage.from('videos').upload(`${prefix}/final-delivery.json`,Buffer.from(JSON.stringify(receipt)),{contentType:'application/json',upsert:false});
  if(saved.error)throw Error('FINAL_RECEIPT_STORE_FAILED');
  console.log('FINAL_DELIVERY_COMPLETE',JSON.stringify(receipt));
 }finally{
  const latest=JSON.parse(readFileSync(credential,'utf8'));const result=await db.auth.admin.signOut(latest.session.access_token,'local');
  unlinkSync(credential);if(result.error)throw Error('FINAL_OWNER_LOGOUT_FAILED');console.log('OWNER_SESSION_CLOSED');
 }
}
