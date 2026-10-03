/** Private review only, with no provider credentials or paid executor. */
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createHash,randomBytes,createCipheriv} from 'node:crypto';
import {createServiceClient} from '../../src/lib/supabase/service';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const auth=JSON.parse(await readFile('docs/production-intelligence/VFX-OPENING-REVIEW-AUTHORIZATION.json','utf8'));
 if(auth.maximumAdditionalUsd!==0||auth.approved!==true||auth.stage!=='private-opening-review')throw new Error('VFX_REVIEW_NOT_AUTHORIZED');
 const sb=createServiceClient(),u=await sb.auth.admin.getUserById(auth.ownerId);if(u.error)throw new Error('OWNER_LOOKUP_FAILED');directorActor(u.data.user);
 const results=supabaseResultStore(sb),ledger=supabaseLedgerStore(sb),root=await mkdtemp(join(tmpdir(),'vfx-opening-'));
 try{
  const source=await results.getBytes('precampaign-teaser-v1/v2/vfx-001-source-20261002_181854-1.mp4-4.700-0.500-hable.mp4');if(!source||sha(source)!==auth.sourceSha256)throw new Error('SOURCE_CHANGED');await writeFile(join(root,'source.mp4'),source);
  for(const asset of auth.assets){
   const m=await results.getJson<{assetPath:string;sha256:string}>(asset.metadataPath);if(!m||m.sha256!==asset.sha256)throw new Error('VFX_REVIEW_ASSET_CHANGED');
   const b=await results.getBytes(m.assetPath);if(!b||sha(b)!==m.sha256)throw new Error('VFX_REVIEW_ASSET_CHANGED');await writeFile(join(root,asset.name),b);
  }
  const prefix='precampaign-three-worlds-v1-preparation/private-proof/';const mr=await results.getJson<{sourceSha256:string;matteParts:{file:string;sha256:string}[]}>(prefix+'matte-report.json');if(!mr||mr.sourceSha256!==auth.sourceSha256)throw new Error('VFX_MATTE_SOURCE_CHANGED');
  await writeFile(join(root,'matte-report.json'),JSON.stringify(mr));
  for(const part of mr.matteParts){if(!/^matte-part-\d{3}\.npz$/.test(part.file))throw new Error('VFX_MATTE_PATH_INVALID');const b=await results.getBytes(prefix+part.file);if(!b||sha(b)!==part.sha256)throw new Error('VFX_MATTE_CHANGED');await writeFile(join(root,part.file),b);}
  const execute=promisify(execFile);
  await execute('python3',['scripts/vfx/region-motion-proof.py','nyc',join(root,'nyc.png'),join(root,'nyc.mp4'),root],{timeout:5*60_000,maxBuffer:1024*1024});
  const run=await execute('python3',['scripts/vfx/opening-review.py',root],{timeout:12*60_000,maxBuffer:1024*1024});console.log(run.stdout.trim());
  const plain=await readFile(join(root,'opening-review.zip'));if(plain.length>30*1024*1024)throw new Error('VFX_REVIEW_CAPSULE_TOO_LARGE');
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const deliveryKey='vfx_opening_review_'+process.env.GITHUB_RUN_ID+'_'+process.env.GITHUB_RUN_ATTEMPT;
  if(!await ledger.insert({idempotencyKey:deliveryKey,projectId:'precampaign-three-worlds-v1-preparation',shotId:'private-opening-review',provider:'internal',model:'encrypted-review/1',method:'encrypted_delivery',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({keyBase64:key.toString('base64'),ownerId:auth.ownerId,plainSha256:sha(plain),encryptedSha256:sha(encrypted)}),updatedAt:new Date().toISOString()}))throw new Error('VFX_REVIEW_DELIVERY_EXISTS');
  await mkdir('vfx-opening-encrypted',{recursive:true});await writeFile('vfx-opening-encrypted/opening-review.enc',encrypted);await writeFile('vfx-opening-encrypted/delivery.json',JSON.stringify({deliveryKey,encryptedSha256:sha(encrypted),plaintextMediaExported:false,productionReady:false}));
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'VFX_OPENING_REVIEW_BLOCKED');process.exitCode=1;});
