/** Private original/matte controls are encrypted before any GitHub artifact upload. */
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomBytes,createCipheriv,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createServiceClient} from '../../src/lib/supabase/service';
import {supabaseLedgerStore} from '../../src/lib/paid-calls/supabase-ledger-store';
import {supabaseResultStore} from '../../src/lib/paid-calls/result-store';
import {directorActor} from '../../src/lib/production-intelligence/vfx-director/access';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const pkg=JSON.parse(await readFile('docs/production-intelligence/VFX-CAMPAIGN-MATERIALS.json','utf8'));
 const auth=JSON.parse(await readFile('docs/production-intelligence/VFX-REPAIR-AUTHORIZATION.json','utf8'));
 const sb=createServiceClient(),user=await sb.auth.admin.getUserById(auth.ownerId);if(user.error)throw new Error('OWNER_LOOKUP_FAILED');directorActor(user.data.user);
 const root=await mkdtemp(join(tmpdir(),'vfx-private-proof-'));const results=supabaseResultStore(sb),ledger=supabaseLedgerStore(sb);
 try{
  const source=await results.getBytes('precampaign-teaser-v1/v2/vfx-001-source-20261002_181854-1.mp4-4.700-0.500-hable.mp4');
  if(!source||hash(source)!==pkg.source.sha256)throw new Error('SOURCE_CHANGED');await writeFile(join(root,'source.mp4'),source);
  const response=await fetch('https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx');
  if(!response.ok)throw new Error('VFX_MATTE_MODEL_UNAVAILABLE');await writeFile(join(root,'rvm.onnx'),Buffer.from(await response.arrayBuffer()));
  const {stdout}=await promisify(execFile)('python3',['scripts/vfx/private-material-proof.py',root],{timeout:10*60_000,maxBuffer:1024*1024});console.log(stdout.trim());
  const plain=await readFile(join(root,'private-proof.zip'));if(plain.length>30*1024*1024)throw new Error('VFX_PRIVATE_CAPSULE_TOO_LARGE');
  const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const deliveryKey='vfx_private_proof_'+process.env.GITHUB_RUN_ID+'_'+process.env.GITHUB_RUN_ATTEMPT;
  if(!await ledger.insert({idempotencyKey:deliveryKey,projectId:pkg.projectId+'-preparation',shotId:'private-material-proof',provider:'internal',model:'encrypted-review/1',method:'encrypted_delivery',attemptKind:'review',reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:JSON.stringify({keyBase64:key.toString('base64'),format:'AES-256-GCM:12-byte-IV,ciphertext,16-byte-tag',plainSha256:hash(plain),encryptedSha256:hash(encrypted),ownerId:auth.ownerId}),updatedAt:new Date().toISOString()}))throw new Error('VFX_PRIVATE_DELIVERY_ALREADY_EXISTS');
  await results.putBytes(pkg.projectId+'-preparation/private-proof/'+deliveryKey+'.enc',encrypted,'application/octet-stream');
  await mkdir('vfx-encrypted-review',{recursive:true});await writeFile('vfx-encrypted-review/private-proof.enc',encrypted);
  await writeFile('vfx-encrypted-review/delivery.json',JSON.stringify({deliveryKey,encryptedSha256:hash(encrypted),plaintextMediaExported:false,productionReady:false}));
  console.log(JSON.stringify({deliveryKey,plaintextMediaExported:false,paidCalls:0,productionReady:false}));
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(()=>{console.error('VFX_PRIVATE_PROOF_BLOCKED');process.exitCode=1;});
