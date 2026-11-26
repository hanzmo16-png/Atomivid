import test from 'node:test';
import assert from 'node:assert/strict';
import { initialQueue, claimCycle, finishCycle, claimDefect, transition, fingerprint, publicView, type Cycle, type Check } from './model';
import { allowBrowserRequest, targetOrigin, sentinelStatus } from './policy';
import { update, Conflict, type QueueStore } from './github-store';
const at='2026-11-26T20:00:00.000Z', end='2026-11-26T20:01:00.000Z', sha='a'.repeat(40);
const check:Check={id:'download',product:'reels',state:'FAIL',severity:'P1',owner:'codex',module:'delivery',detail:'controlled failure'};
const cycle=(id:string,checks:Check[]=[check]):Cycle=>({id,trigger:'schedule',scope:'authenticated-readonly',startedAt:at,finishedAt:end,sha,runnerSha:sha,url:'https://github.com/example/repo/actions/runs/1',authenticated:true,sentinel:'BLOCKED',checks,spendUsd:0});
function add(q:ReturnType<typeof initialQueue>,c:Cycle){const token=claimCycle(q,c.id,c.startedAt);finishCycle(q,c,token);}
test('boundary: unauthenticated POST to generation is blocked before login too',()=>{
 assert.equal(allowBrowserRequest({url:'https://atomivid.vercel.app/api/render',method:'POST',origin:'https://atomivid.vercel.app',authenticated:false,resourceType:'fetch'}),false);
});
test('one live cycle; completed id not repeated; expired lease recoverable with fencing',()=>{
 const q=initialQueue(at),t=claimCycle(q,'one',at); assert.throws(()=>claimCycle(q,'two',at),/LEASE/);
 const t2=claimCycle(q,'two','2026-11-26T20:21:00Z');assert.throws(()=>finishCycle(q,cycle('one'),t),/FENCED/);
 finishCycle(q,{...cycle('two'),finishedAt:'2026-11-26T20:22:00Z'},t2);assert.throws(()=>claimCycle(q,'two','2026-11-26T21:00:00Z'),/COMPLETED/);
});
test('dedup, real claim, correction, exact deployed SHA revalidation, recurrence reopens same defect',()=>{
 const q=initialQueue(at);add(q,cycle('one'));add(q,cycle('two'));assert.equal(q.defects.length,1);assert.equal(q.defects[0].occurrences,2);
 const id=fingerprint(check),t=claimDefect(q,id,'codex','codex-session',end);assert.throws(()=>claimDefect(q,id,'codex','other',end),/CLAIMED/);
 transition(q,id,t,'FIXED_IN_BRANCH',sha,end);add(q,cycle('three',[{...check,state:'PASS'}]));assert.equal(q.defects[0].state,'FIXED_IN_BRANCH');
 transition(q,id,t,'INTEGRATED',sha,end);add(q,{...cycle('four',[{...check,state:'PASS'}]),sha:'b'.repeat(40)});assert.equal(q.defects[0].state,'INTEGRATED');
 add(q,cycle('five',[{...check,state:'PASS'}]));assert.equal(q.defects[0].state,'REVALIDATED');add(q,cycle('six'));assert.equal(q.defects.length,1);assert.equal(q.defects[0].state,'DETECTED');
});
test('fixtures/blocked/missing checks never close real findings and missing auth cannot certify',()=>{
 const q=initialQueue(at);add(q,cycle('one'));const id=fingerprint(check),t=claimDefect(q,id,'codex','agent',end);transition(q,id,t,'FIXED_IN_BRANCH',sha,end);transition(q,id,t,'INTEGRATED',sha,end);
 add(q,{...cycle('f',[{...check,state:'PASS'}]),scope:'fixture'});add(q,cycle('b',[{...check,state:'BLOCKED'}]));add(q,{...cycle('u',[{...check,state:'PASS'}]),authenticated:false});assert.equal(q.defects[0].state,'INTEGRATED');
});
test('stop fences publication; restart needs fresh claim; token stripped from admin view',()=>{
 const q=initialQueue(at);const t=claimCycle(q,'x',at);q.enabled=false;assert.throws(()=>finishCycle(q,cycle('x'),t),/STOPPED/);assert.throws(()=>claimCycle(q,'new',at),/STOPPED/);assert.doesNotMatch(JSON.stringify(publicView(q,end)),new RegExp(t));
});
test('CAS retries preserve concurrent updates instead of lost writes',async()=>{
 let q=initialQueue(at),rev=0,conflict=true;
 const store:QueueStore={async read(){return {state:structuredClone(q),revision:String(rev)}},async write(n,r){if(conflict){conflict=false;q.activity.push({at,text:'other'});rev++;throw new Conflict()};assert.equal(r,String(rev));q=n;rev++}};
 await update(store,n=>n.activity.push({at,text:'ours'}));assert.deepEqual(q.activity.map(e=>e.text),['other','ours']);
});
test('targets and sentinel fail closed; no guessed balance',()=>{
 assert.throws(()=>targetOrigin('https://evil.test'));assert.throws(()=>targetOrigin('https://atomivid.vercel.app?token=x'));assert.equal(sentinelStatus(404,{}),'BLOCKED');assert.equal(sentinelStatus(200,{sentinel:{accounts:[],accountingScope:'READ_ONLY_NOT_ATOMIC_ADMISSION'},admission:[],observedAt:new Date().toISOString()}), 'READ');
});
test('different defects sharing a module cannot be claimed simultaneously',()=>{
 const q=initialQueue(at);add(q,cycle('multi',[check,{...check,id:'playback'}]));
 claimDefect(q,fingerprint(check),'codex','one',end);
 assert.throws(()=>claimDefect(q,fingerprint({...check,id:'playback'}),'codex','two',end),/MODULE_ALREADY_CLAIMED/);
});
test('wrong owner, expired claim, invalid transition and paid cycle are refused',()=>{
 const q=initialQueue(at);add(q,cycle('first'));const id=fingerprint(check);
 assert.throws(()=>claimDefect(q,id,'claude','wrong',end),/NOT_CLAIMABLE/);
 const t=claimDefect(q,id,'codex','one',end);assert.throws(()=>transition(q,id,t,'INTEGRATED',sha,end),/INVALID_TRANSITION/);
 assert.throws(()=>transition(q,id,t,'FIXED_IN_BRANCH',sha,'2026-11-27T01:00:00Z'),/INVALID_CLAIM/);
 const paid={...cycle('paid'),spendUsd:1} as unknown as Cycle;
 assert.throws(()=>finishCycle(q,paid,claimCycle(q,'paid',at)),/INVALID_CYCLE/);
});
test('admin view reports blockers, not healthy merely because a runner finished',()=>{
 const q=initialQueue(at);assert.equal(publicView(q,end).operational,'STALE');
 add(q,cycle('blocked',[{...check,state:'BLOCKED'}]));assert.equal(publicView(q,end).operational,'BLOCKED');assert.equal(publicView(q,end).nextEvaluation,'2026-11-26T20:17:00.000Z');
});
