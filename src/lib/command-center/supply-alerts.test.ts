import test from "node:test";
import assert from "node:assert/strict";
import { loadSupplyInbox } from "./supply-alerts";
const admin={email:"owner@example.test",email_confirmed_at:"2026-01-01"};
const env={COMMAND_CENTER_ADMIN_EMAILS:"owner@example.test"};
const row=(id:string,provider="recraft",level="UNKNOWN",reason="billing_error",created_at="2026-11-27T10:00:00Z")=>({id,provider,level,payload:{reason,secret:"NEVER_EXPORT",available:987654,account:"private@example.test"},created_at});
function client(data:unknown,error:unknown=null,throws=false){let reads=0;let requestedLimit=0;return {get reads(){return reads;},get requestedLimit(){return requestedLimit;},db:{from(table:string){reads++;assert.equal(table,"pi_supply_alerts");if(throws)throw Error("NEVER_EXPORT");return{select(columns:string){assert.equal(columns,"id,provider,level,payload,created_at");return{order(column:string,options:unknown){assert.equal(column,"created_at");assert.deepEqual(options,{ascending:false});return{async limit(n:number){requestedLimit=n;return{data,error};}};}};}};}}};}
test("aliases collapse equivalent historical alerts and preserve newest identity, sample count and privacy",async()=>{
 const c=client([row("old","flux"),row("latest","recraft","UNKNOWN","billing_error","2026-11-27T11:00:00Z"),row("middle","flux")]);
 const inbox=await loadSupplyInbox(admin,c.db as never,env);
 assert.equal(inbox.available,true);assert.equal(c.requestedLimit,1000);assert.equal(inbox.alerts.length,1);
 assert.equal(inbox.alerts[0].id,"latest");assert.equal(inbox.alerts[0].createdAt,"2026-11-27T11:00:00Z");
 assert.match(inbox.alerts[0].provider,/fal/i);assert.equal((inbox.alerts[0] as {occurrencesInSample?:number}).occurrencesInSample,3);
 assert.doesNotMatch(JSON.stringify(inbox),/NEVER_EXPORT|987654|private@example|billing_error|payload/);
});
test("distinct controlled causes and severities remain separate, newest 20 incidents survive duplicate floods",async()=>{
 const data=[...Array.from({length:50},(_,i)=>row(`duplicate-${i}`,"flux")),row("startup","flux","UNKNOWN","monitor_job_did_not_start"),row("wallet","flux","UNKNOWN","reported_wallet_low"),row("red","flux","RED"),row("yellow","flux","YELLOW"),...Array.from({length:21},(_,i)=>row(`other-${i}`,`independent-${i}`,"UNKNOWN","billing_error",`2026-11-27T11:${String(i).padStart(2,"0")}:00Z`))];
 const full=await loadSupplyInbox(admin,client(data.slice(0,54)).db as never,env);
 assert.equal(full.alerts.length,5);assert.deepEqual(new Set(full.alerts.map(a=>a.level)),new Set(["RED","YELLOW","UNKNOWN"]));
 assert.equal(new Set(full.alerts.map(a=>a.message)).size,3);
 const inbox=await loadSupplyInbox(admin,client(data).db as never,env);
 assert.equal(inbox.alerts.length,20);assert.equal(inbox.alerts[0].id,"other-20");assert.equal(inbox.alerts.at(-1)?.id,"other-1");
});
test("history cap, malformed results and read failures refuse availability without disclosing payloads",async()=>{
 for(const c of [client(Array.from({length:1000},(_,i)=>row(String(i)))),client(null),client([],Error("NEVER_EXPORT")),client([],null,true)]){
  assert.deepEqual(await loadSupplyInbox(admin,c.db as never,env),{available:false,alerts:[]});
 }
 assert.deepEqual(await loadSupplyInbox(admin,client([]).db as never,env),{available:true,alerts:[]});
});
test("different private upstream causes never merge through an identical safe message",async()=>{
 const a=row("unavailable","flux","UNKNOWN","private outage details 123");
 const b=row("rate-limit","recraft","UNKNOWN","private rate-limit details 456");
 const inbox=await loadSupplyInbox(admin,client([a,b]).db as never,env);
 assert.equal(inbox.alerts.length,2);assert.equal(inbox.alerts[0].message,inbox.alerts[1].message);
 assert.doesNotMatch(JSON.stringify(inbox),/private outage|private rate-limit|123|456/);
});
test("admin authorization always precedes the privileged reader",async()=>{
 for(const user of [null,{email:"owner@example.test"},{email:"other@example.test",email_confirmed_at:"yes"}]){
  const c=client([]);await assert.rejects(loadSupplyInbox(user,c.db as never,env));assert.equal(c.reads,0);
 }
});
