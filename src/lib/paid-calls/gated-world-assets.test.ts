import test from 'node:test';
import assert from 'node:assert/strict';
import {gatedWorldAsset} from './gated-world-assets';
import {memoryLedgerStore} from '../production-intelligence/ledger';
import {memoryResultStore} from './result-store';
import {CHECKS} from '../production-intelligence/vfx-director/gates';
import type {Job} from '../production-intelligence/vfx-director/jobs';
import type {OfficialPort,WorldRequest} from '../providers/vfx-worlds/official';
// Single-world preparation fixture, distinct from perceptual or provider proof.
const source='a'.repeat(64),artifact='b'.repeat(64);
function setup(){
 const job={id:'prep',ownerId:'owner',planHash:'scope',plan:{environments:[]},artifacts:{direction:artifact},approvals:[{stage:'direction',planHash:'scope',artifactSha256:artifact,reviewerId:'owner',approved:true,checks:CHECKS.direction.map(name=>({name,pass:true,evidence:'fixture'}))}]} as unknown as Job;
 // jobGates requires a world: mock uses a real environment definition and the real scope hash.
 job.brief={projectId:'prep',intent:'world',emotion:'wonder',frames:150,fps:30,width:1080,height:1920,sourceSha256:source,subjectLock:'identity_with_relight',budgetUsd:4.77,environments:[{id:'nyc',kind:'city',lighting:'night_practical'}]};
 job.plan={version:'vfx-director/1',sourceSha256:source,contract:{} as Job['plan']['contract'],environments:[{id:'nyc',kind:'city',lighting:'night_practical',startFrame:0,endFrame:150,materialAssetId:'plate',materialSha256:source,light:'frozen',continuityIn:'source',continuityOut:'cut'}],world:{scaleMeters:1,physics:'fixed',light:'frozen',optics:'measured',continuityIn:'source',continuityOut:'cut'},layersFrontToBack:['person','plate'],beats:[{frame:0,action:'cut'}],tasks:[],requiredChecks:['edges']};
 job.inventory={};job.assets=['plate'];job.environmentArtifacts={nyc:{direction:artifact}};
 return job;
}
import {environmentHash} from '../production-intelligence/vfx-director/jobs';
function deps(){const job=setup();job.approvals=job.approvals.map(a=>({...a,environmentId:'nyc',planHash:environmentHash(job,'nyc')}));return {ledger:memoryLedgerStore(),results:memoryResultStore(),projectId:'prep',actorId:'owner',job,maxCostUsd:.03,projectBudgetUsd:4.77,connectionsVerified:true};}
const r:WorldRequest={environmentId:'nyc',phase:'styleframe',prompt:'Empty NYC night plate'};
test('no ledger write means no paid HTTP; committed result reuses without resubmit',async()=>{
 const d=deps();let calls=0;
 const port:OfficialPort={async submit(){calls++;return{id:'image-1'};},async finish(){return{buffer:Buffer.from('image'),mimeType:'image/png',extension:'png',model:'flux-2-pro',costUsd:.03,costBasis:'published_rate',providerJobId:'image-1'};}};
 const a=await gatedWorldAsset({...d,port},r);assert.equal(a.reused,false);
 assert.equal((await gatedWorldAsset({...d,port},r)).reused,true);assert.equal(calls,1);
 await assert.rejects(gatedWorldAsset({...d,port},{...r,prompt:'Different'}),/ATTEMPT_ALREADY_FROZEN/);assert.equal(calls,1);
 const broken={...deps(),ledger:{get:async()=>null,insert:async()=>{throw new Error('ledger down');},update:async()=>false}};
 await assert.rejects(gatedWorldAsset({...broken,port},r),/ledger down/);assert.equal(calls,1);
});
test('connection, owner and review failures block before any submission',async()=>{
 const d=deps();const port:OfficialPort={submit:async()=>{throw new Error('must not call');},finish:async()=>{throw new Error('must not call');}};
 await assert.rejects(gatedWorldAsset({...d,port,connectionsVerified:false},r),/CONNECTION/);
 await assert.rejects(gatedWorldAsset({...d,port,actorId:'other'},r));
 await assert.rejects(gatedWorldAsset({...d,port,job:{...d.job,approvals:[]}},r),/approval/);
 assert.equal(d.ledger.writes,0);
});
test('failed polling resumes the recorded job without a second submission',async()=>{
 const d=deps();let submits=0,polls=0;
 const port:OfficialPort={async submit(){submits++;return{id:'job-1',pollingUrl:'https://api.us1.bfl.ai/v1/get_result?id=job-1',costUsd:.03};},async finish(receipt){assert.equal(receipt.pollingUrl,'https://api.us1.bfl.ai/v1/get_result?id=job-1');assert.equal(receipt.costUsd,.03);polls++;if(polls===1)throw new Error('poll failed');return{buffer:Buffer.from('image'),mimeType:'image/png',extension:'png',model:'flux-2-pro',costUsd:.03,costBasis:'provider_usage',providerJobId:'job-1'};}};
 await assert.rejects(gatedWorldAsset({...d,port},r),/poll failed/);
 await gatedWorldAsset({...d,port},r);assert.equal(submits,1);assert.equal(polls,2);
});
test('a rejected recorded styleframe allows exactly one budgeted replacement and retains the original charge',async()=>{
 const d=deps();let submits=0;
 const port:OfficialPort={async submit(){return{id:`job-${++submits}`,pollingUrl:'https://api.bfl.ai/v1/get_result?id=fixture'};},async finish(j){if(j.id==='job-1')throw new Error('VFX_HTTP_404');return{buffer:Buffer.from('replacement'),mimeType:'image/png',extension:'png',model:'flux-2-pro',costUsd:.03,costBasis:'provider_usage',providerJobId:j.id};}};
 await assert.rejects(gatedWorldAsset({...d,port},r),/404/);
 const original=[...d.ledger.ops.values()].find(o=>o.providerJobId==='job-1')!;
 await d.ledger.update(original.idempotencyKey,'PROVIDER_JOB_RECORDED',{status:'RECONCILIATION_REQUIRED'});
 const slot=[...d.ledger.ops.values()].find(o=>o.method==='generation_slot')!;
 await d.ledger.insert({...slot,idempotencyKey:slot.idempotencyKey+'_defect_1',method:'rejected_styleframe',resultRef:JSON.stringify({failedOperationKey:original.idempotencyKey,providerJobId:'job-1',ownerId:'owner',environmentId:'nyc',phase:'styleframe',rejected:true,maximumAdditionalUsd:.03,authorizationSha256:'c'.repeat(64),code:'VFX_HTTP_404'})});
 await assert.rejects(gatedWorldAsset({...d,port},r),/REPLACEMENT_BUDGET/);assert.equal(submits,1);
 const updated={...d,port,projectBudgetUsd:4.80};
 assert.equal((await gatedWorldAsset(updated,r)).reused,false);
 assert.equal((await gatedWorldAsset(updated,r)).reused,true);assert.equal(submits,2);
 assert.equal(d.ledger.ops.get(original.idempotencyKey)?.status,'RECONCILIATION_REQUIRED');
 assert.equal(d.ledger.ops.get(original.idempotencyKey)?.reservedUsd,.03);
 await assert.rejects(gatedWorldAsset(updated,{...r,prompt:'More epic'}),/ATTEMPT_ALREADY_FROZEN/);assert.equal(submits,2);
});
