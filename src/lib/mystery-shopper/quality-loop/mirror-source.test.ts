import test from 'node:test';
import assert from 'node:assert/strict';
import { initialQueue, claimCycle, finishCycle, event, type Queue, type Cycle } from './model';
import { update, Conflict, type QueueStore } from './github-store';
import { mirrorSource, assertMirrorSource, isMirrorSourceChanged } from './mirror-source';

const AT='2026-11-28T01:00:00Z', NEXT='2026-11-28T01:01:00Z', SHA='a'.repeat(40);
const cycle=(id:string,at:string):Cycle=>({id,trigger:'schedule',scope:'authenticated-readonly',startedAt:at,finishedAt:at,sha:SHA,runnerSha:SHA,url:'https://github.com/example/run',authenticated:true,sentinel:'READ',checks:[],spendUsd:0});
class Memory implements QueueStore {
 state=initialQueue(AT);revision=0;beforeWrite:(()=>void)|null=null;
 async read(){return {state:structuredClone(this.state),revision:String(this.revision)};}
 async write(q:Queue,r:string|null){if(this.beforeWrite){const hook=this.beforeWrite;this.beforeWrite=null;hook();}if(r!==String(this.revision))throw new Conflict();this.state=structuredClone(q);this.revision++;}
 complete(id:string,at:string){const c=cycle(id,at),t=claimCycle(this.state,id,at);finishCycle(this.state,c,t);this.revision++;}
}
const mark=(s:Memory,source:string,state:'VERIFIED'|'BLOCKED'='VERIFIED')=>update(s,q=>{assertMirrorSource(q,source);q.mirror={at:NEXT,state};});

test('unchanged completed snapshot can be verified; stamp contains no raw state',async()=>{
 const s=new Memory();s.complete('one',AT);const source=mirrorSource(s.state);
 assert.match(source,/^[a-f0-9]{64}$/);await mark(s,source);assert.equal(s.state.mirror.state,'VERIFIED');
});
test('newer completed cycle cannot inherit the older Drive receipt',async()=>{
 const s=new Memory();s.complete('one',AT);const source=mirrorSource(s.state);s.complete('two',NEXT);const before=structuredClone(s.state);
 await assert.rejects(mark(s,source),/MIRROR_SOURCE_CHANGED/);assert.deepEqual(s.state,before);assert.equal(s.state.mirror.state,'PENDING');
});
test('STOP and restart fence an earlier source even when enabled returns to true',async()=>{
 const s=new Memory(),source=mirrorSource(s.state);s.state.enabled=false;event(s.state,NEXT,'STOP');s.revision++;
 await assert.rejects(mark(s,source),/MIRROR_SOURCE_CHANGED/);
 s.state.enabled=true;event(s.state,'2026-11-28T01:02:00Z','START');s.revision++;const before=structuredClone(s.state);
 await assert.rejects(mark(s,source),/MIRROR_SOURCE_CHANGED/);assert.deepEqual(s.state,before);
});
test('active lease is refused before transfer and after a source was captured',async()=>{
 const s=new Memory(),source=mirrorSource(s.state);claimCycle(s.state,'active',AT);s.revision++;const before=structuredClone(s.state);
 assert.throws(()=>mirrorSource(s.state),/MIRROR_SOURCE_CHANGED/);await assert.rejects(mark(s,source),/MIRROR_SOURCE_CHANGED/);assert.deepEqual(s.state,before);
});
test('CAS conflict retries the fence against the actual newer cycle',async()=>{
 const s=new Memory();s.complete('one',AT);const source=mirrorSource(s.state);s.beforeWrite=()=>s.complete('two',NEXT);
 await assert.rejects(mark(s,source),/MIRROR_SOURCE_CHANGED/);assert.equal(s.state.cycles.at(-1)?.id,'two');assert.equal(s.state.mirror.state,'PENDING');
});
test('stale failure cannot overwrite a newer VERIFIED receipt',async()=>{
 const s=new Memory();s.complete('one',AT);const source=mirrorSource(s.state);s.complete('two',NEXT);await mark(s,mirrorSource(s.state));const before=structuredClone(s.state);
 await assert.rejects(mark(s,source,'BLOCKED'),/MIRROR_SOURCE_CHANGED/);assert.deepEqual(s.state,before);
});
test('same-source transfer failure can be BLOCKED without losing source data',async()=>{
 const s=new Memory();s.complete('one',AT);const cycles=structuredClone(s.state.cycles);await mark(s,mirrorSource(s.state),'BLOCKED');assert.equal(s.state.mirror.state,'BLOCKED');assert.deepEqual(s.state.cycles,cycles);
});
test('source changed is distinct from a Drive failure; local receipt changes are allowed',()=>{
 const q=initialQueue(AT),source=mirrorSource(q);q.mirror={state:'VERIFIED',at:NEXT};assertMirrorSource(q,source);
 assert.equal(isMirrorSourceChanged(new Error('MIRROR_SOURCE_CHANGED')),true);assert.equal(isMirrorSourceChanged(new Error('DRIVE_MIRROR_BLOCKED')),false);
});
test('own handoff driveId receipt does not invalidate the unchanged completed source',async()=>{
 const s=new Memory(),c=cycle('failure',AT);c.checks=[{id:'test',product:'reels',state:'FAIL',severity:'P1',owner:'codex',module:'fixture',detail:''}];
 const token=claimCycle(s.state,c.id,AT);finishCycle(s.state,c,token);const source=mirrorSource(s.state);
 await update(s,q=>{assertMirrorSource(q,source);q.defects[0].driveId='synthetic-drive-receipt';});
 await mark(s,source);assert.equal(s.state.mirror.state,'VERIFIED');assert.equal(s.state.defects[0].driveId,'synthetic-drive-receipt');
});
