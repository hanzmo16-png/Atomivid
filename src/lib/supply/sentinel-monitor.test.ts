import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorSupply, refreshProviderSnapshot } from "./monitor";
const clock = Date.parse("2026-11-26T12:00:00Z");
function db() {
  const rows: Record<string, Record<string, unknown>[]> = { pi_supply_policies: [{provider:"recraft",enabled:true},{provider:"flux",enabled:true}], pi_capacity_snapshots: [], pi_supply_alerts: [] };
  const client = { rows, failRead: false, rpc: async (name:string,args:{p_provider:string})=>({data:{provider:args.p_provider,level:"YELLOW",free:10},error:null}), from(table:string) {
    let values: Record<string,unknown>|undefined, max=Infinity, sort="", reverse=false;
    const filters: ((r:Record<string,unknown>)=>boolean)[]=[];
    const q={ select:()=>q,in:(k:string,a:unknown[])=>{filters.push(r=>a.includes(r[k]));return q;},eq:(k:string,v:unknown)=>{filters.push(r=>r[k]===v);return q;},neq:(k:string,v:unknown)=>{filters.push(r=>r[k]!==v);return q;},is:(k:string,v:unknown)=>{filters.push(r=>(r[k]??null)===v);return q;},order:(k:string,o?:{ascending?:boolean})=>{sort=k;reverse=o?.ascending===false;return q;},limit:(n:number)=>{max=n;return q;},insert:(v:Record<string,unknown>)=>{values=v;return q;},upsert:(v:Record<string,unknown>)=>{values=v;return q;},then(resolve:(r:unknown)=>void){
      const all=rows[table]??[];if(values&&!all.some(r=>values!.id!==undefined&&r.id===values!.id))all.push({delivered_at:null,...values});
      const data=all.filter(r=>filters.every(f=>f(r))).sort((a,b)=>String(a[sort]??"").localeCompare(String(b[sort]??""))*(reverse?-1:1)).slice(0,max);
      return Promise.resolve({data:client.failRead&&!values?null:data,error:client.failRead&&!values?{message:"fixture failure"}:null}).then(resolve);
    }};return q;
  }};return client;
}
const env={FAL_ADMIN_KEY:"offline-fixture-key"};
const healthy=(async(url:unknown,init?:RequestInit)=>{assert.equal(url,"https://api.fal.ai/v1/account/billing?expand=credits");assert.equal(init?.method,"GET");assert.equal(init?.redirect,"error");return Response.json({credits:{currency:"USD",current_balance:50}});}) as typeof fetch;
test("one official wallet GET serves FLUX/Recraft; cadence and original evidence timestamp survive aliases",async()=>{
  const d=db();let calls=0;const request=(async(u,i)=>{calls++;return healthy(u,i);}) as typeof fetch;
  await monitorSupply(d as never,{env,fetchImpl:request,now:()=>clock});
  assert.equal(calls,1);assert.deepEqual(d.rows.pi_capacity_snapshots.map(r=>r.provider),["recraft","flux"]);
  assert.ok(d.rows.pi_capacity_snapshots.every(r=>r.checked_at===new Date(clock).toISOString()));
  await monitorSupply(d as never,{env,fetchImpl:request,now:()=>clock+299999});assert.equal(calls,1);
  await monitorSupply(d as never,{env,fetchImpl:request,now:()=>clock+300000});assert.equal(calls,2);
  assert.equal(d.rows.pi_supply_alerts.length,1,"same unacknowledged shared-account incident, even across polling windows");
});
test("same-client concurrent reads coalesce without claiming a distributed financial lock",async()=>{
  const d=db();let calls=0;const request=(async(u,i)=>{calls++;await new Promise(r=>setTimeout(r,5));return healthy(u,i);}) as typeof fetch;
  await Promise.all(Array.from({length:12},()=>refreshProviderSnapshot(d as never,"recraft",{env,fetchImpl:request,now:()=>clock})));
  assert.equal(calls,1);
});
test("429 Retry-After persists in existing private alert outbox and survives another client/process",async()=>{
  const d=db();let calls=0;const request=(async()=>{calls++;return new Response("",{status:429,headers:{"Retry-After":"1800"}});}) as typeof fetch;
  assert.equal(await refreshProviderSnapshot(d as never,"recraft",{env,fetchImpl:request,now:()=>clock}),false);
  assert.equal(d.rows.pi_capacity_snapshots[0].available,null);
  assert.equal(await refreshProviderSnapshot({...d} as never,"flux",{env,fetchImpl:request,now:()=>clock+600000}),false);
  assert.equal(calls,1);assert.ok(d.rows.pi_supply_alerts.some(r=>(r.payload as {rateLimitUntil?:string})?.rateLimitUntil===new Date(clock+1800000).toISOString()));
});
test("missing credentials, unavailable persisted observations and disabled suppliers never trigger HTTP",async()=>{
 const d=db();let calls=0;const request=(async()=>{calls++;throw Error("forbidden");}) as typeof fetch;
 assert.equal(await refreshProviderSnapshot(d as never,"recraft",{env:{},fetchImpl:request}),false);
 d.failRead=true;assert.equal(await refreshProviderSnapshot(d as never,"recraft",{env,fetchImpl:request}),false);d.failRead=false;
 d.rows.pi_supply_policies.forEach(r=>{r.enabled=false;});await monitorSupply(d as never,{env,fetchImpl:request,now:()=>clock});assert.equal(calls,0);
});
