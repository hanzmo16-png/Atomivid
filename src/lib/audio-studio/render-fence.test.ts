import test from "node:test";
import assert from "node:assert/strict";
import { sameRenderAuthorization, renderProject } from "./render";
import { newProject } from "./model";
import { memoryStore } from "./store";
const ownerId="11111111-1111-4111-8111-111111111111",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project=()=>{const p=newProject({ownerId,id,now:"2026-11-27T00:00:00Z",voiceCount:1});p.script="Un texto";p.generation={...p.generation,status:"en_cola",kind:"generar",authorization:{revision:p.revision,model:p.ttsModel,at:"2026-11-27T00:00:00Z",usd:1,spentBefore:0}};return p;};
test("authorization fence rejects changed owner, script, model, revision, voices, language, music and authorization; permits progress and spend updates",()=>{
 const p=project();assert.equal(sameRenderAuthorization(p,{...p,spentUsd:0.1,generation:{...p.generation,providerCalls:1}}),true);
 for(const patch of [{ownerId:id},{script:"Otro texto"},{revision:p.revision+1},{language:"en" as const},{voices:["otra"]},{music:{...p.music,volume:12}},{generation:{...p.generation,authorization:{...p.generation.authorization!,at:"2026-11-27T01:00:00Z"}}}])assert.equal(sameRenderAuthorization(p,{...p,...patch}),false);
});
test("stale worker and its error handler cannot overwrite a newly authorized project",async()=>{
 const store=memoryStore(),p=project();await store.create(p);let reads=0,writes=0;
 const original=store.get.bind(store),put=store.put.bind(store);const newer={...p,revision:p.revision+1,script:"Nuevo guion"};
 store.get=async(o,i)=>{reads++;return reads===1?original(o,i):structuredClone(newer);};
 store.put=async value=>{writes++;await put(value);};
 const result=await renderProject({store,voice:{mode:"elevenlabs",voiceIdFor:()=>"unused",provider:()=>{throw Error("MUST_NOT_CALL_PROVIDER");}}},ownerId,id);
 assert.equal(result,"fallida");assert.equal(writes,0);
});
