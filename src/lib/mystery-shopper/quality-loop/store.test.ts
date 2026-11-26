import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubQueueStore, Conflict } from './github-store';
import { initialQueue } from './model';
const q=initialQueue('2026-11-26T20:00:00Z');
test('GitHub queue never converts a permission failure or corrupt state to an empty healthy queue',async()=>{
 for(const status of [401,403,500]){
  const s=new GitHubQueueStore('owner/repo','token',(async()=>new Response('{}',{status})) as typeof fetch);await assert.rejects(s.read(),new RegExp(`READ_${status}`));
 }
 const s=new GitHubQueueStore('owner/repo','token',(async()=>Response.json({sha:'rev',content:Buffer.from('{}').toString('base64')})) as typeof fetch);await assert.rejects(s.read(),/CORRUPT/);
});
test('bootstrap is an orphan branch and an existing ref is a CAS conflict',async()=>{
 const calls:{path:string,body:Record<string,unknown>}[]=[];
 const fetcher=(async(url:string,init:RequestInit)=>{const p=new URL(url).pathname;calls.push({path:p,body:JSON.parse(init.body as string)});return p.endsWith('/git/refs')?Response.json({}, {status:422}):Response.json({sha:'new-object'});}) as typeof fetch;
 await assert.rejects(new GitHubQueueStore('owner/repo','token',fetcher).write(q,null),Conflict);
 assert.deepEqual(calls.find(c=>c.path.endsWith('/git/commits'))?.body.parents,[]);
 assert.equal(calls.at(-1)?.body.ref,'refs/heads/automation/quality-loop-state');
});
test('updates only write state branch with expected revision and do not write application data',async()=>{
 let body:Record<string,unknown>|null=null;
 const fetcher=(async(_url:string,init:RequestInit)=>{body=JSON.parse(init.body as string);return new Response('{}',{status:409});}) as typeof fetch;
 await assert.rejects(new GitHubQueueStore('owner/repo','token',fetcher).write(q,'old-revision'),Conflict);
 assert.equal((body as unknown as Record<string,unknown>).branch,'automation/quality-loop-state');assert.equal((body as unknown as Record<string,unknown>).sha,'old-revision');
 await assert.rejects(new GitHubQueueStore('owner/repo').write(q,'rev'),/NOT_CONFIGURED/);
});
test('state above GitHub inline-content limit uses raw representation and keeps CAS revision',async()=>{
 let calls=0;const fetcher=(async(_u:string,init:RequestInit)=>{calls++;if(calls===1)return Response.json({sha:'revision',size:1500000,encoding:'none',content:''});assert.equal((init.headers as Record<string,string>).accept,'application/vnd.github.raw+json');return Response.json(q);}) as typeof fetch;
 const s=await new GitHubQueueStore('owner/repo','token',fetcher).read();assert.equal(s.revision,'revision');assert.equal(s.state.version,'quality-loop/1');assert.equal(calls,2);
});
