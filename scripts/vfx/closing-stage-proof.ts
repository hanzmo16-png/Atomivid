/** Zero-cost internal scene proof. Every source/report/media output stays private. */
import {mkdtemp,writeFile,readFile,mkdir,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash,randomBytes,createCipheriv} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import sharp from 'sharp';
import {createServiceClient} from '../../src/lib/supabase/service';import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const sb=createServiceClient(),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb),row=await ledger.get('vfx_closing_stage_proof_authorization_v1');
 if(row?.status!=='COMMITTED'||row.method!=='human_direction'||!row.resultRef)throw new Error('VFX_CLOSING_PROOF_NOT_AUTHORIZED');const config=JSON.parse(row.resultRef);
 if(config.approved!==true||config.maximumAdditionalUsd!==0||config.voiceConversionAuthorized!==false||config.deploymentAuthorized!==false)throw new Error('VFX_CLOSING_PROOF_SCOPE_CHANGED');
 const u=await sb.auth.admin.getUserById(config.ownerId);if(u.error||!u.data.user?.email_confirmed_at)throw new Error('VFX_OWNER_UNVERIFIED');
 const owned=await sb.from('vfx_director_jobs').select('owner_id').eq('id','precampaign-three-worlds-v1-preparation').maybeSingle();if(owned.error||owned.data?.owner_id!==config.ownerId)throw new Error('VFX_OWNER_MISMATCH');
 const root=await mkdtemp(join(tmpdir(),'closing-stage-'));
 try{
  const original=await results.getBytes(config.sourcePath);if(!original||sha(original)!==config.sourceSha256)throw new Error('VFX_CLOSING_SOURCE_CHANGED');await writeFile(join(root,'original.mp4'),original);await writeFile(join(root,'config.json'),JSON.stringify(config));
  const svg=await readFile('scripts/vfx/launch-stage.svg');await writeFile(join(root,'stage.png'),await sharp(svg).png().toBuffer());
  const model=await fetch('https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx');if(!model.ok)throw new Error('VFX_MATTE_MODEL_UNAVAILABLE');await writeFile(join(root,'rvm.onnx'),Buffer.from(await model.arrayBuffer()));
  const run=await promisify(execFile)('python3',['scripts/vfx/closing-stage-proof.py',root],{timeout:20*60_000,maxBuffer:1024*1024});console.log(run.stdout.trim());
  const report=JSON.parse(await readFile(join(root,'closing-report.json'),'utf8')),prefix=config.projectId+'/closing-launch-stage/';
  const video=await readFile(join(root,'ATOMIVID-cierre-escenario-prueba.mp4'));if(video.length>45*1024*1024||sha(video)!==report.sha256)throw new Error('VFX_CLOSING_PROOF_STORAGE_LIMIT');await results.putBytes(prefix+report.sha256+'.mp4',video,'video/mp4');await results.putJson(prefix+'closing-report.json',report);
  const matteParts=[];for(const file of (await readdir(root)).filter(f=>/^matte-part-\d{3}\.npz$/.test(f)).sort()){const b=await readFile(join(root,file));await results.putBytes(prefix+file,b,'application/octet-stream');matteParts.push({file,sha256:sha(b)});}await results.putJson(prefix+'matte-report.json',{sourceSha256:config.sourceSha256,trim:report.trim,frames:report.frames,matteParts});
  const plain=await readFile(join(root,'closing-review.zip'));if(plain.length>30*1024*1024)throw new Error('VFX_CLOSING_CAPSULE_LIMIT');const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const deliveryKey='vfx_closing_stage_proof_'+process.env.GITHUB_RUN_ID+'_'+process.env.GITHUB_RUN_ATTEMPT;
  if(!await ledger.insert({idempotencyKey:deliveryKey,projectId:config.projectId,shotId:'closing-launch-stage-proof',provider:'internal',model:'encrypted-review/1',method:'encrypted_delivery',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({ownerId:config.ownerId,keyBase64:key.toString('base64'),plainSha256:sha(plain),encryptedSha256:sha(encrypted)}),updatedAt:new Date().toISOString()}))throw new Error('VFX_DELIVERY_EXISTS');
  await mkdir('vfx-closing-stage-encrypted',{recursive:true});await writeFile('vfx-closing-stage-encrypted/closing-review.enc',encrypted);await writeFile('vfx-closing-stage-encrypted/delivery.json',JSON.stringify({deliveryKey,plaintextMediaExported:false,paidCalls:0}));
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_CLOSING_STAGE_BLOCKED');process.exitCode=1;});
