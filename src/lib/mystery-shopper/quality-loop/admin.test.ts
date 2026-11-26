import test from 'node:test';import assert from 'node:assert/strict';
import { qualityHandlers } from './admin';import { initialQueue,claimCycle } from './model';
import type { AuthUser } from '../../command-center/access';
const origin='https://atomivid.vercel.app',env={COMMAND_CENTER_ADMIN_EMAILS:'admin@example.test'};
function fixture(user:AuthUser){let q=initialQueue(new Date().toISOString()),reads=0,writes=0,factories=0;const h=qualityHandlers({env,auth:async()=>user,queue:()=>{factories++;return{async read(){reads++;return{state:structuredClone(q),revision:'rev'}},async write(n){writes++;q=n;}}},deployedSha:()=> 'a'.repeat(40)});return{h,get state(){return q},get reads(){return reads},get writes(){return writes},get factories(){return factories}};}
const admin={id:'admin-id',email:'admin@example.test',email_confirmed_at:'2026-01-01'};
const post=(body:object,o:string|null=origin)=>new Request(origin+'/api/command-center/quality-loop',{method:'POST',headers:{'content-type':'application/json',...(o?{origin:o}:{})},body:JSON.stringify(body)});
test('anonymous, unconfirmed and non-admin users cannot even construct the queue client',async()=>{
 for(const [user,status] of [[null,401],[{id:'x',email:'user@example.test',email_confirmed_at:'2026-01-01'},403],[{id:'x',email:'admin@example.test'},403]] as const){const f=fixture(user);assert.equal((await f.h.GET()).status,status);assert.equal((await f.h.POST(post({action:'stop'}))).status,status);assert.equal(f.factories,0);}
});
test('admin cross-origin and missing-origin posts are denied without a queue write',async()=>{
 const f=fixture(admin);for(const o of ['https://evil.test',null])assert.equal((await f.h.POST(post({action:'stop'},o))).status,403);assert.equal(f.writes,0);
});
test('admin view is no-store and hides the cycle fencing token',async()=>{
 const f=fixture(admin);const token=claimCycle(f.state,'in-flight',new Date().toISOString());const r=await f.h.GET();assert.equal(r.status,200);assert.match(r.headers.get('cache-control')||'',/no-store/);assert.equal((await r.text()).includes(token),false);
});
test('emergency stop fences a worker without deleting results and restart is explicit',async()=>{
 const f=fixture(admin);claimCycle(f.state,'in-flight',new Date().toISOString());assert.equal((await f.h.POST(post({action:'stop'}))).status,200);assert.equal(f.state.enabled,false);assert.equal(f.state.lease,null);assert.equal((await f.h.POST(post({action:'start'}))).status,200);assert.equal(f.state.enabled,true);assert.equal(f.writes,2);
});
test('a submitted branch SHA cannot be recorded as integrated into another production build',async()=>{
 const f=fixture(admin);const r=await f.h.POST(post({action:'INTEGRATED',id:'id',token:'token',sha:'b'.repeat(40)}));assert.equal(r.status,409);assert.equal(f.writes,0);
});
