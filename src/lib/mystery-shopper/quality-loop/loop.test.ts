import test from 'node:test';
import assert from 'node:assert/strict';
import { initialQueue, claimCycle, finishCycle, claimDefect, transition, fingerprint, publicView, type Cycle, type Check } from './model';
import { allowBrowserRequest, targetOrigin, sentinelStatus, providerReadiness, allowMediaProbe } from './policy';
import { update, Conflict, type QueueStore } from './github-store';
const at='2026-11-26T20:00:00.000Z', end='2026-11-26T20:01:00.000Z', sha='a'.repeat(40);
const check:Check={id:'download',product:'reels',state:'FAIL',severity:'P1',owner:'codex',module:'delivery',detail:'controlled failure'};
const cycle=(id:string,checks:Check[]=[check]):Cycle=>({id,trigger:'schedule',scope:'authenticated-readonly',startedAt:at,finishedAt:end,sha,runnerSha:sha,url:'https://github.com/example/repo/actions/runs/1',authenticated:true,sentinel:'BLOCKED',checks,spendUsd:0});
test('episode detail GET is default-denied and grants only one exact authenticated owner-card path',()=>{
 const origin='https://atomivid.vercel.app',path='/api/podcast/v3/11111111-1111-4111-8111-111111111111';
 const request={url:origin+path,origin,method:'GET',authenticated:true,resourceType:'fetch'};
 assert.equal(allowBrowserRequest(request),false);
 assert.equal(allowBrowserRequest({...request,existingEpisodePath:path}),true);
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.equal(allowBrowserRequest({...request,method,existingEpisodePath:path}),false);
 for(const resourceType of ['media','document','websocket','eventsource','xhr'])assert.equal(allowBrowserRequest({...request,resourceType,existingEpisodePath:path}),false);
 assert.equal(allowBrowserRequest({...request,authenticated:false,existingEpisodePath:path}),false);
 for(const suffix of ['?action=retry','#x','/retry','/render','/archive'])assert.equal(allowBrowserRequest({...request,url:origin+path+suffix,existingEpisodePath:path}),false);
 for(const url of [origin+path.replace('11111111-','22222222-'),'https://other.example'+path,'https://user:pass@atomivid.vercel.app'+path])assert.equal(allowBrowserRequest({...request,url,existingEpisodePath:path}),false);
 for(const existingEpisodePath of [null,undefined,'/api/podcast/v3/not-a-uuid','/api/podcast/v3/../render','/api/render'])assert.equal(allowBrowserRequest({...request,existingEpisodePath}),false);
});
test('admin readback is default-denied, manual GET only, authenticated and exact same origin',()=>{
 const r={url:'https://atomivid.vercel.app/api/command-center/quality-loop',method:'GET',origin:'https://atomivid.vercel.app',authenticated:true,resourceType:'fetch'};
 assert.equal(allowBrowserRequest(r),false);
 assert.equal(allowBrowserRequest({...r,adminReadback:true}),true);
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])assert.equal(allowBrowserRequest({...r,method,adminReadback:true}),false);
 assert.equal(allowBrowserRequest({...r,authenticated:false,adminReadback:true}),false);
 assert.equal(allowBrowserRequest({...r,url:r.url.replace('atomivid.vercel.app','untrusted.example'),adminReadback:true}),false);
});
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
 add(q,cycle('blocked',[{...check,state:'BLOCKED'}]));assert.equal(publicView(q,end).operational,'BLOCKED');assert.equal(publicView(q,end).nextEvaluation,'2026-11-26T20:23:00.000Z');
});

test('one green provider or a stale/unreconciled wallet cannot green-light a whole product',()=>{
 assert.equal(providerReadiness('youtube',{sentinel:{accounts:[{providers:['openai'],operationalLevel:'GREEN',balanceStatus:'REAL',free:100}],resources:[{resource:'workers',state:'VERIFIED',used:0,limit:1}]}}),false);
 assert.equal(providerReadiness('reels',{sentinel:{accounts:[{providers:['openai','pexels','elevenlabs','recraft','flux'],operationalLevel:'GREEN',balanceStatus:'REAL',free:null}]}}),false);
});
test('one defect across viewports; a desktop pass cannot hide the mobile failure or missing revalidation',()=>{
 const q=initialQueue(at);const mobile={...check,id:'layout-412'},desktop={...check,id:'layout-1440',state:'PASS' as const};
 add(q,cycle('mixed',[mobile,desktop]));assert.equal(q.defects.length,1);assert.equal(q.defects[0].state,'DETECTED');
 const id=fingerprint(mobile),t=claimDefect(q,id,'codex','agent',end);transition(q,id,t,'FIXED_IN_BRANCH',sha,end);transition(q,id,t,'INTEGRATED',sha,end);
 add(q,cycle('still-broken',[mobile,desktop]));assert.equal(q.defects[0].state,'INTEGRATED');
 add(q,cycle('missing-mobile',[desktop]));assert.equal(q.defects[0].state,'INTEGRATED');
 add(q,cycle('fixed',[{...mobile,state:'PASS'},desktop]));assert.equal(q.defects[0].state,'REVALIDATED');
});
test('recurrence reopens same defect and creates one linked follow-up, not a duplicate root task',()=>{
 const q=initialQueue(at);add(q,cycle('first'));const d=q.defects[0],root=d.taskId;d.driveId='prior-task-file';const t=claimDefect(q,d.id,'codex','active',end);transition(q,d.id,t,'FIXED_IN_BRANCH',sha,end);transition(q,d.id,t,'INTEGRATED',sha,end);add(q,cycle('good',[{...check,state:'PASS'}]));add(q,cycle('recur'));const follow=q.defects[0].taskId;assert.notEqual(follow,root);assert.equal(q.defects[0].rootTaskId,root);assert.equal(q.defects[0].driveId,null);add(q,cycle('same-fail'));assert.equal(q.defects.length,1);assert.equal(q.defects[0].taskId,follow);
});

test('unverified egress cannot be consumed by periodic/deployment media probes; fixture flag cannot target production',()=>{
 for(const trigger of ['schedule','deployment_status','unknown'])assert.equal(allowMediaProbe(trigger,false),false);
 assert.equal(allowMediaProbe('workflow_dispatch',false),true);assert.equal(allowMediaProbe('fixture',true),true);
 assert.throws(()=>targetOrigin('https://atomivid.vercel.app',true),/LOCAL/);
});

test('QA credentials cannot be routed to a lookalike Vercel project or alternate production port',()=>{
 for(const url of ['https://atomivid-attacker.vercel.app','https://atomivid.vercel.app:8443','ftp://localhost'])assert.throws(()=>targetOrigin(url,url.startsWith('ftp:')));
 assert.equal(targetOrigin('https://atomivid.vercel.app'),'https://atomivid.vercel.app');
 assert.equal(targetOrigin('http://127.0.0.1:1234',true),'http://127.0.0.1:1234');
});

test('a branch runner cannot close a real production defect even when its observed app SHA matches the recorded deployment',()=>{
 const q=initialQueue(at);add(q,cycle('observed'));
 const d=q.defects[0],token=claimDefect(q,d.id,'codex','codex-session',end);
 transition(q,d.id,token,'FIXED_IN_BRANCH',sha,end);transition(q,d.id,token,'INTEGRATED',sha,end);
 add(q,{...cycle('branch-check',[{...check,state:'PASS'}]),runnerSha:'b'.repeat(40)});
 assert.equal(d.state,'INTEGRATED');
 add(q,cycle('deployed-runner-check',[{...check,state:'PASS'}]));assert.equal(d.state,'REVALIDATED');
});
