import test from "node:test";
import assert from "node:assert/strict";
import { audioActionAck } from "../../../../scripts/mystery-shopper/audio-action-ack";
test("Audio action: a click without response is BLOCKED and never resent", async()=>{
 let clicks=0;const page={waitForResponse:async()=>{throw new Error('fixture timeout');}};
 const r=await audioActionAck(page,'id','generar',async()=>{clicks++;});assert.equal(r.state,'BLOCKED');assert.equal(clicks,1);
});
test("Audio action: HTTP rejection and inactive state are not accepted generations",async()=>{
 for(const [ok,status,state] of [[false,422,'inactiva'],[true,200,'inactiva']] as const){
  const page={waitForResponse:async()=>({ok:()=>ok,status:()=>status,json:async()=>({generation:{status:state},error:'private fixture body'})})};
  const r=await audioActionAck(page,'id','generar',async()=>{});assert.equal(r.state,'FAIL');assert.ok(!r.detail.includes('private fixture body'));
 }
});
test("Audio action: response must match project, method and action; queue confirmation passes",async()=>{
 const page={waitForResponse:async(predicate: (r: unknown)=>boolean)=>{
  const r=(id:string,method:string,action:string)=>({url:()=>`https://example.test/api/audio-studio/projects/${id}`,request:()=>({method:()=>method,postDataJSON:()=>({action})})});
  assert.equal(predicate(r('other','POST','generar')),false);assert.equal(predicate(r('id','PUT','generar')),false);assert.equal(predicate(r('id','POST','listo')),false);assert.equal(predicate(r('id','POST','generar')),true);
  return {ok:()=>true,json:async()=>({generation:{status:'en_cola'}})};
 }};
 assert.equal((await audioActionAck(page,'id','generar',async()=>{})).state,'PASS');
});
