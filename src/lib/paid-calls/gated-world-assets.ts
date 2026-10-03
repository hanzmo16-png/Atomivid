/** VFX material preparation via existing ledger: submit is recorded before network; accepted jobs
 * poll without resubmission. Host supplies authenticated owner and trusted scoped review context.
 * This does not change Generate defaults or register a paid executor as a free Director capability.
 */
import { executePaidOperation, idempotencyKey, type LedgerStore } from '../production-intelligence/ledger';
import { stableHash } from '../production-intelligence/canonical';
import { assertGate } from '../production-intelligence/vfx-director/gates';
import { requireOwner, jobGates, type Job } from '../production-intelligence/vfx-director/jobs';
import { worldRecipe,type WorldRequest,type OfficialPort,type OfficialAsset } from '../providers/vfx-worlds/official';
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
 const key=idempotencyKey({projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:r.phase==='styleframe'?'text-to-image':'image-to-video',
  inputFingerprint:stableHash({environmentId:r.environmentId,phase:r.phase,prompt:r.prompt,referenceSha256:r.reference?.sha256??null,scopeHash:scope.planHash,sku:recipe.sku,seconds:recipe.seconds,width:recipe.width,height:recipe.height,fps:recipe.fps,audio:false},32),attemptOrdinal:0});
 // One frozen request per world/phase. A changed prompt cannot evade the attempt ceiling.
 const slotKey='vfx_slot_'+stableHash({projectId:deps.projectId,environmentId:r.environmentId,phase:r.phase},32);
 await deps.ledger.insert({idempotencyKey:slotKey,projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:'generation_slot',attemptKind:r.phase,reservedUsd:0,committedUsd:0,status:'COMMITTED',providerJobId:null,resultRef:key,updatedAt:new Date().toISOString()});
 if((await deps.ledger.get(slotKey))?.resultRef!==key)throw new Error('VFX_ATTEMPT_ALREADY_FROZEN');
 let returned:OfficialAsset|undefined;
 const op=await executePaidOperation(deps.ledger,{idempotencyKey:key,projectId:deps.projectId,shotId:`world:${r.environmentId}:${r.phase}`,provider:recipe.provider,model:recipe.sku,method:r.phase==='styleframe'?'text-to-image':'image-to-video',attemptKind:r.phase,reservedUsd:recipe.reservedUsd},{
  async submit(){const job=await deps.port.submit(r);return {providerJobId:job.id};},
  async poll(jobId){
   const a=await deps.port.finish({id:jobId},r);
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
