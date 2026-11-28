import {test} from "node:test";
import assert from "node:assert/strict";
import {resourceSentinelResponse} from "./sentinel-server";
const now=Date.parse("2026-11-26T12:00:00Z");
function database(failHistory=false,options:{slots?:unknown;slotsError?:boolean;throwSlots?:boolean;maxConcurrent?:unknown}={}){
 const tables:Record<string,Record<string,unknown>[]>= {pi_supply_policies:[{provider:"__global__",max_concurrent:"maxConcurrent" in options?options.maxConcurrent:2},{provider:"runway",unit:"credit",unit_cost_usd:.01,enabled:true,timezone:"UTC"}],pi_capacity_snapshots:[{provider:"runway",unit:"credit",available:40,checked_at:new Date(now).toISOString(),reliability:"provider_api",health:"OK"}],pi_paid_operations:[],pi_supply_job_reservations:[]};
 return {from(table:string){let single=false,start=0,end=500;const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,or:()=>q,range:(a:number,b:number)=>{start=a;end=b+1;return q;},maybeSingle:()=>{single=true;return q;},then(resolve:(r:unknown)=>void){const data=tables[table]??[];return Promise.resolve({data:single?data[0]??null:data.slice(start,end),count:data.length,error:failHistory&&table==="pi_paid_operations"?{message:"private fixture error"}:null}).then(resolve);}};return q;},async rpc(name:string){assert.ok(["pi_worker_supply_slots","pi_supply_state"].includes(name),"no reserve/submit/resume RPC permitted by observation");if(name==="pi_supply_state")return{data:{level:"RED",reason:"funded budget unconfigured"},error:null};if(options.throwSlots)throw Error("private slot fixture error");return{data:"slots" in options?options.slots:{configured:true,active:1,free:1},error:options.slotsError?{message:"private slot fixture error"}:null};}};
}
const env={COMMAND_CENTER_ADMIN_EMAILS:"owner@example.test"};
test("unauthenticated, unconfirmed and normal users cannot even construct the privileged data client",async()=>{
 let reads=0;const service=()=>{reads++;return database() as never;};
 for(const [user,status] of [[null,401],[{email:"other@example.test",email_confirmed_at:"2026-01-01"},403],[{email:"owner@example.test"},403]] as const){
  const r=await resourceSentinelResponse(user,{service,env,now});assert.equal(r.status,status);assert.match(r.headers.get("Cache-Control")!,/no-store/);assert.deepEqual(await r.json(),{error:"Resource Sentinel unavailable"});
 }
 assert.equal(reads,0);
});
test("admin receives unit-aware balances and accounting slot counts without claiming worker liveness",async()=>{
 const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database() as never,env,now});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.sentinel.accounts[0].available,40);assert.equal(data.sentinel.resources.find((x:{resource:string})=>x.resource==="gpu").state,"UNKNOWN");assert.deepEqual(data.sentinel.resources.find((x:{resource:string})=>x.resource==="workers"),{resource:"workers",state:"UNKNOWN",used:null,limit:null,unit:null});assert.deepEqual(data.accountingSlots,{state:"VERIFIED",used:1,limit:2,checkedAt:new Date(now).toISOString(),scope:"VIDEO_REQUESTS_ONLY_NOT_WORKER_LIVENESS"});assert.equal(data.purchases,"NEVER_AUTOMATIC");assert.equal(data.sentinel.accounts[0].operationalLevel,"RED","verified admission refusal is never hidden behind a wallet balance");assert.ok(!JSON.stringify(data).includes("owner@example.test"));
});
test("unreadable ledger never appears as zero commitments, free funds or a green forecast",async()=>{
 const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database(true) as never,env,now});
 assert.equal(r.status,200);const data=await r.json();assert.equal(data.sentinel.accounts[0].level,"GRAY");assert.equal(data.sentinel.accounts[0].free,null);assert.equal(data.sentinel.accounts[0].forecast.coverageDays,null);
});

test("zero or over-limit accounting occupancy never establishes a live worker",async()=>{
 for(const active of [0,3]){
  const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database(false,{slots:{configured:true,active,free:Math.max(0,2-active),healthy:true,heartbeatAt:new Date(now).toISOString()}}) as never,env,now});
  assert.equal(r.status,200);const data=await r.json();
  assert.deepEqual(data.accountingSlots,{state:"VERIFIED",used:active,limit:2,checkedAt:new Date(now).toISOString(),scope:"VIDEO_REQUESTS_ONLY_NOT_WORKER_LIVENESS"});
  assert.deepEqual(data.sentinel.resources.find((x:{resource:string})=>x.resource==="workers"),{resource:"workers",state:"UNKNOWN",used:null,limit:null,unit:null});
 }
});

const invalidAccounting: {name:string;options:Parameters<typeof database>[1]}[] = [
 {name:"missing response",options:{slots:null}},
 {name:"unconfigured",options:{slots:{configured:false,active:0}}},
 {name:"nonboolean configuration",options:{slots:{configured:"true",active:0}}},
 {name:"missing active count",options:{slots:{configured:true}}},
 ...[-1,NaN,Infinity,.5,"1",null,Number.MAX_SAFE_INTEGER+1].map(active=>({name:`invalid count ${String(active)}`,options:{slots:{configured:true,active}}})),
 ...[0,-1,NaN,Infinity,.5,null,undefined,true,[],{}].map(maxConcurrent=>({name:`invalid ceiling ${String(maxConcurrent)}`,options:{maxConcurrent}})),
 {name:"RPC error despite valid data",options:{slotsError:true}},
 {name:"RPC rejection",options:{throwSlots:true}},
];
for(const {name,options} of invalidAccounting){
 test(`unverified accounting slots stay null: ${name}`,async()=>{
  const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>database(false,options) as never,env,now});
  assert.equal(r.status,200);const data=await r.json();
  assert.deepEqual(data.accountingSlots,{state:"UNKNOWN",used:null,limit:null,checkedAt:null,scope:"VIDEO_REQUESTS_ONLY_NOT_WORKER_LIVENESS"});
  assert.deepEqual(data.sentinel.resources.find((x:{resource:string})=>x.resource==="workers"),{resource:"workers",state:"UNKNOWN",used:null,limit:null,unit:null});
  assert.doesNotMatch(JSON.stringify(data),/private slot fixture error/);
 });
}

test("a synchronous slot RPC failure does not invent an empty worker queue",async()=>{
 const db=database();const service={...db,rpc(name:string){if(name==="pi_worker_supply_slots")throw Error("private synchronous slot failure");return db.rpc(name);}};
 const r=await resourceSentinelResponse({email:"owner@example.test",email_confirmed_at:"2026-01-01"},{service:()=>service as never,env,now});
 assert.equal(r.status,200);const data=await r.json();
 assert.deepEqual(data.accountingSlots,{state:"UNKNOWN",used:null,limit:null,checkedAt:null,scope:"VIDEO_REQUESTS_ONLY_NOT_WORKER_LIVENESS"});
 assert.equal(data.sentinel.resources.find((x:{resource:string})=>x.resource==="workers").state,"UNKNOWN");
 assert.doesNotMatch(JSON.stringify(data),/private synchronous slot failure/);
});
