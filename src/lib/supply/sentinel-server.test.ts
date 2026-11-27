import {test} from "node:test";
import assert from "node:assert/strict";
import {resourceSentinelResponse} from "./sentinel-server";
const now=Date.parse("2026-11-26T12:00:00Z");
function database(failHistory=false){
 const tables:Record<string,Record<string,unknown>[]>= {pi_supply_policies:[{provider:"__global__",max_concurrent:2},{provider:"runway",unit:"credit",unit_cost_usd:.01,enabled:true,timezone:"UTC"}],pi_capacity_snapshots:[{provider:"runway",unit:"credit",available:40,checked_at:new Date(now).toISOString(),reliability:"provider_api",health:"OK"}],pi_paid_operations:[],pi_supply_job_reservations:[]};
 return {from(table:string){let single=false,start=0,end=500;const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,or:()=>q,range:(a:number,b:number)=>{start=a;end=b+1;return q;},maybeSingle:()=>{single=true;return q;},then(resolve:(r:unknown)=>void){const data=tables[table]??[];return Promise.resolve({data:single?data[0]??null:data.slice(start,end),count:data.length,error:failHistory&&table==="pi_paid_operations"?{message:"private fixture error"}:null}).then(resolve);}};return q;},async rpc(name:string){assert.ok(["pi_worker_supply_slots","pi_supply_state"].includes(name),"no reserve/submit/resume RPC permitted by observation");return{data:name==="pi_supply_state"?{level:"RED",reason:"funded budget unconfigured"}:{configured:true,active:1,free:1},error:null};}};
}
const env={COMMAND_CENTER_ADMIN_EMAILS:"owner@example.test"};
test("unauthenticated, unconfirmed and normal users cannot even construct the privileged data client",async()=>{
 let reads=0;const service=()=>{reads++;return database() as never;};
 for(const [user,status] of [[null,401],[{email:"other@example.test",email_confirmed_at:"2026-01-01"},403],[{email:"owner@example.test"},403]] as const){
  const r=await resourceSentinelResponse(user,{service,env,now});assert.equal(r.status,status);assert.match(r.headers.get("Cache-Control")!,/no-store/);assert.deepEqual(await r.json(),{error:"Resource Sentinel unavailable"});
 }
 assert.equal(reads,0);
});
test("admin receives unit-aware private read model, real worker counts and explicit unverified GPU/storage",async()=>{
 const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database() as never,env,now});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.sentinel.accounts[0].available,40);assert.equal(data.sentinel.resources.find((x:{resource:string})=>x.resource==="gpu").state,"UNKNOWN");assert.equal(data.sentinel.resources.find((x:{resource:string})=>x.resource==="workers").used,1);assert.equal(data.purchases,"NEVER_AUTOMATIC");assert.equal(data.sentinel.accounts[0].operationalLevel,"RED","verified admission refusal is never hidden behind a wallet balance");assert.ok(!JSON.stringify(data).includes("owner@example.test"));
});
test("unreadable ledger never appears as zero commitments, free funds or a green forecast",async()=>{
 const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database(true) as never,env,now});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.sentinel.accounts[0].level,"GRAY");assert.equal(data.sentinel.accounts[0].free,null);assert.equal(data.sentinel.accounts[0].forecast.coverageDays,null);
});
