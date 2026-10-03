/** VFX material preparation via existing ledger: submit is recorded before network; accepted jobs
 * poll without resubmission. Host supplies authenticated owner and trusted scoped review context.
 * This does not change Generate defaults or register a paid executor as a free Director capability.
 */
import { executePaidOperation, idempotencyKey, type LedgerStore } from '../production-intelligence/ledger';
import { stableHash } from '../production-intelligence/canonical';
import { assertGate } from '../production-intelligence/vfx-director/gates';
import { requireOwner, jobGates, type Job } from '../production-intelligence/vfx-director/jobs';
import { worldRecipe,type WorldRequest,type OfficialPort,type OfficialAsset,type Submitted } from '../providers/vfx-worlds/official';
import { paidResultPath,sha256Hex,type PaidResultStore } from './result-store';
export async function gatedWorldAsset(deps:{ledger:LedgerStore;results:PaidResultStore;port:OfficialPort;
 projectId:string;actorId:string;job:Job;maxCostUsd:number;projectBudgetUsd:number;connectionsVerified:boolean},r:WorldRequest) {
 requireOwner(deps.actorId,deps.job.ownerId);
 if(deps.projectId!==deps.job.id)throw new Error("VFX_JOB_ID_MISMATCH");
 const scope=jobGates(deps.job,r.environmentId);
 if(!deps.connectionsVerified)throw new Error('VFX_CONNECTION_NOT_VERIFIED');
 const recipe=worldRecipe(r);
 if(!Number.isFinite(deps.projectBudgetUsd)||deps.projectBudgetUsd<4.77)throw new Error('VFX_PROJECT_BUDGET_EXCEEDED');
 if(!Number.isFinite(deps.maxCostUsd)||recipe.reservedUsd>deps.maxCostUsd)throw new Error('VFX_OPERATION_BUDGET_EXCEEDED');
 assertGate('direction',scope);
 if(r.phase!=='styleframe') {
  assertGate('styleframe',scope);
  if(r.reference!.sha256!==scope.artifacts.styleframe)throw new Error('VFX_REFERENCE_NOT_APPROVED');
 }
 if(r.phase==='final')assertGate('motion',scope);
 let key=idempotencyKey({projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:r.phase==='styleframe'?'text-to-image':'image-to-video',
  inputFingerprint:stableHash({environmentId:r.environmentId,phase:r.phase,prompt:r.prompt,referenceSha256:r.reference?.sha256??null,scopeHash:scope.planHash,sku:recipe.sku,seconds:recipe.seconds,width:recipe.width,height:recipe.height,fps:recipe.fps,audio:false},32),attemptOrdinal:0});
 // A trusted owner direction can explicitly remove paid background video from this world.
 // Already accepted requests remain recoverable; the policy cannot authorize a new charge.
 const policy=await deps.ledger.get('vfx_world_policy_'+stableHash({projectId:deps.projectId,environmentId:r.environmentId},32));
 if(policy){
  if(policy.projectId!==deps.projectId||policy.status!=='COMMITTED'||policy.method!=='world_payment_policy'||!policy.resultRef)throw new Error('VFX_WORLD_PAYMENT_POLICY_INVALID');
  const p=JSON.parse(policy.resultRef);
  if(p.ownerId!==deps.actorId||p.environmentId!==r.environmentId||p.background!=='fixed_lunar_flag'||p.allowImageToVideo!==false||r.environmentId!=='moon')throw new Error('VFX_WORLD_PAYMENT_POLICY_INVALID');
  if(r.phase!=='styleframe'){
   const prior=await deps.ledger.get(key);
   if(!prior||!['COMMITTED','PROVIDER_JOB_RECORDED'].includes(prior.status))throw new Error('VFX_FIXED_FLAG_PAID_VIDEO_FORBIDDEN');
  }
 }
 // One frozen request per world/phase. A changed prompt cannot evade the attempt ceiling.
 const slotKey='vfx_slot_'+stableHash({projectId:deps.projectId,environmentId:r.environmentId,phase:r.phase},32);
 await deps.ledger.insert({idempotencyKey:slotKey,projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:'generation_slot',attemptKind:r.phase,reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:key,updatedAt:new Date().toISOString()});
 if((await deps.ledger.get(slotKey))?.resultRef!==key)throw new Error('VFX_ATTEMPT_ALREADY_FROZEN');
 // A service-recorded rejected styleframe may authorize exactly one replacement.
 const defect=await deps.ledger.get(slotKey+'_defect_1');
 if(defect){
  if(r.phase!=='styleframe'||defect.status!=='COMMITTED'||defect.reservedUsd!==0||!defect.resultRef)throw new Error('VFX_REPLACEMENT_DEFECT_INVALID');
  const review=JSON.parse(defect.resultRef);
  const prior=await deps.ledger.get(key);
  if(review.failedOperationKey!==key||review.ownerId!==deps.actorId||review.environmentId!==r.environmentId||review.phase!==r.phase||review.rejected!==true||review.maximumAdditionalUsd!==0.03||typeof review.authorizationSha256!=='string'||!review.code||prior?.status!=='RECONCILIATION_REQUIRED'||prior.providerJobId!==review.providerJobId)throw new Error('VFX_REPLACEMENT_NOT_AUTHORIZED');
  if(deps.projectBudgetUsd<4.80)throw new Error('VFX_REPLACEMENT_BUDGET_EXCEEDED');
  key=idempotencyKey({projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:'text-to-image',inputFingerprint:stableHash({originalOperationKey:key,defectKey:defect.idempotencyKey,authorizationSha256:review.authorizationSha256},32),attemptOrdinal:1});
 }
 let returned:OfficialAsset|undefined;
 const op=await executePaidOperation(deps.ledger,{idempotencyKey:key,projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:r.phase==='styleframe'?'text-to-image':'image-to-video',attemptKind:r.phase,reservedUsd:recipe.reservedUsd},{
  async submit(){const job=await deps.port.submit(r);return {providerJobId:job.id,submissionReceiptRef:'provider-receipt:'+JSON.stringify(job)};},
  async poll(jobId){
   const current=await deps.ledger.get(key);
   const receipt=current?.resultRef?.startsWith('provider-receipt:')?JSON.parse(current.resultRef.slice('provider-receipt:'.length)) as Submitted:{id:jobId};
   if(receipt.id!==jobId)throw new Error('VFX_PROVIDER_RECEIPT_CHANGED');
   const a=await deps.port.finish(receipt,r);
   if(!Number.isFinite(a.costUsd)||a.costUsd<0||a.costUsd>recipe.reservedUsd+1e-9)throw new Error('VFX_COST_RECONCILIATION_REQUIRED');
   returned=a;
   const assetPath=paidResultPath(deps.projectId,key,a.extension),ref=paidResultPath(deps.projectId,key,'json');
   await deps.results.putBytes(assetPath,a.buffer,a.mimeType);
   await deps.results.putJson(ref,{assetPath,sha256:sha256Hex(a.buffer),bytes:a.buffer.length,model:a.model,costUsd:a.costUsd,costBasis:a.costBasis,mimeType:a.mimeType,extension:a.extension,providerJobId:jobId});
   return {resultRef:ref,actualUsd:a.costUsd};
  }
 },()=>new Date().toISOString());
 if(op.status!=='COMMITTED'||!op.resultRef)throw new Error('VFX_RESULT_NOT_COMMITTED');
 if(returned)return {...returned,key,reused:false};
 const m=await deps.results.getJson<Omit<OfficialAsset,'buffer'>&{assetPath:string;sha256:string;bytes:number}>(op.resultRef);
 if(!m)throw new Error('VFX_STORED_RESULT_MISSING');
 const buffer=await deps.results.getBytes(m.assetPath);
 if(!buffer||buffer.length!==m.bytes||sha256Hex(buffer)!==m.sha256)throw new Error('VFX_STORED_RESULT_CHANGED');
 return {...m,buffer,key,reused:true};
}
