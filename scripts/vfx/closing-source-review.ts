/** Private source recovery from trusted direction; no provider credentials or generation. */
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash,randomBytes,createCipheriv} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {createServiceClient} from '../../src/lib/supabase/service';import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const sb=createServiceClient(),ledger=supabaseLedgerStore(sb),results=supabaseResultStore(sb);
 const row=await ledger.get('vfx_closing_stage_direction_20261003_220140');if(row?.status!=='COMMITTED'||row.method!=='human_direction'||!row.resultRef)throw new Error('VFX_CLOSING_DIRECTION_MISSING');
 const direction=JSON.parse(row.resultRef);if(direction.approved!==true||direction.maximumAdditionalUsdForPreparation!==0||direction.deploymentAuthorized!==false||!Array.isArray(direction.candidateSourcePaths)||direction.candidateSourcePaths.length!==2)throw new Error('VFX_CLOSING_DIRECTION_CHANGED');
 const u=await sb.auth.admin.getUserById(direction.ownerId);if(u.error||!u.data.user?.email_confirmed_at)throw new Error('VFX_OWNER_UNVERIFIED');
 const owned=await sb.from('vfx_director_jobs').select('owner_id').eq('id','precampaign-three-worlds-v1-preparation').maybeSingle();if(owned.error||owned.data?.owner_id!==direction.ownerId)throw new Error('VFX_OWNER_MISMATCH');
 const root=await mkdtemp(join(tmpdir(),'closing-source-'));
 try{
  let source:Buffer|undefined;
  for(const path of direction.candidateSourcePaths){if(typeof path!=='string'||!path.startsWith(direction.projectId+'./')||!path.endsWith('.mp4')||path.includes('..'))throw new Error('VFX_CLOSING_PATH_CHANGED');const b=await results.getBytes(path);if(!b)throw new Error('VFX_CLOSING_SOURCE_MISSING');if(source&&sha(b)!==sha(source))throw new Error('VFX_CLOSING_TAKES_AMBIGUOUS');source=b;}
  if(!source||source.length>28*1024*1024)throw new Error('VFX_CLOSING_SOURCE_SIZE');await writeFile(join(root,'closing-original.mp4'),source);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',join(root,'closing-original.mp4')],{encoding:'utf8'}));
  if(!probe.streams.some((s:{codec_type:string})=>s.codec_type==='audio'))throw new Error('VFX_CLOSING_AUDIO_MISSING');
  await writeFile(join(root,'source-review.json'),JSON.stringify({sourceSha256:sha(source),sourcePaths:direction.candidateSourcePaths,duplicatesVerified:true,probe,direction,speechConfirmed:false,paidCalls:0},null,2));
  execFileSync('python3',['-c',"import zipfile,sys,pathlib;p=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(p/'source-review.zip','w',zipfile.ZIP_STORED);z.write(p/'closing-original.mp4','closing-original.mp4');z.write(p/'source-review.json','source-review.json');z.close()",root]);
  const plain=await readFile(join(root,'source-review.zip')),key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const deliveryKey='vfx_closing_source_review_'+process.env.GITHUB_RUN_ID+'_'+process.env.GITHUB_RUN_ATTEMPT;
  if(!await ledger.insert({idempotencyKey:deliveryKey,projectId:direction.projectId,shotId:'closing-source-review',provider:'internal',model:'encrypted-review/1',method:'encrypted_delivery',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({ownerId:direction.ownerId,keyBase64:key.toString('base64'),plainSha256:sha(plain),encryptedSha256:sha(encrypted)}),updatedAt:new Date().toISOString()}))throw new Error('VFX_DELIVERY_EXISTS');
  await results.putBytes(direction.projectId+'/closing-source-review/'+deliveryKey+'.enc',encrypted,'application/octet-stream');
  await mkdir('vfx-closing-encrypted',{recursive:true});await writeFile('vfx-closing-encrypted/source-review.enc',encrypted);await writeFile('vfx-closing-encrypted/delivery.json',JSON.stringify({deliveryKey,plaintextMediaExported:false,paidCalls:0}));console.log(JSON.stringify({encryptedReviewReady:true,paidCalls:0,plaintextMediaExported:false}));
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_CLOSING_SOURCE_BLOCKED');process.exitCode=1;});
