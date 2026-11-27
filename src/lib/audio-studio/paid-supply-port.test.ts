import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { audioContract, audioDemand, audioPaidSupply } from "./paid-supply-port";
import { memoryLedgerStore } from "../production-intelligence/ledger";
import { memoryStore, projectDir } from "./store";
import { newProject, applyInput, scriptLines } from "./model";
import type { StudioVoice } from "./voice";
import { renderProject } from "./render";
const ownerId="11111111-1111-4111-8111-111111111111",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function setup() {
 let p=applyInput(newProject({ownerId,id,now:"2026-11-27T00:00:00Z",voiceCount:1}),{script:"Voz de prueba offline.",music:{mode:"sin_musica",mood:"calma",volume:0,ducking:false,intro:false,outro:false}},"2026-11-27T00:00:00Z");
 p={...p,generation:{...p.generation,status:"en_cola",kind:"generar",authorization:{revision:p.revision,model:p.ttsModel,at:"2026-11-27T00:00:00Z",usd:1,spentBefore:0}}};
 const ledger=memoryLedgerStore();ledger.submit=async(op,at)=>ledger.update(op.idempotencyKey,"RESERVED",{status:"SUBMITTED",updatedAt:at});
 const rpc=async(name:string)=>({error:null,data:name==="pi_reserve_audio_supply"?{reserved:true}:{spentUsd:[...ledger.ops.values()].filter(o=>o.status==="COMMITTED").reduce((n,o)=>n+o.committedUsd!,0),calls:[...ledger.ops.values()].filter(o=>o.status==="COMMITTED").length,characters:[...ledger.ops.values()].filter(o=>o.status==="COMMITTED").reduce((n,o)=>n+o.capacityUnits!,0)}});
 const port=audioPaidSupply({ledger,rpc}),store=memoryStore();
 const d=audioDemand(p,createHash("sha256").update("segment").digest("hex"),20,.01),blob=`${projectDir(ownerId,id)}/tts/${d.segment}.mp3`;
 return {p,ledger,port,store,d,blob,rpc};
}
test("authorization and manifest reject nonfinite/zero costs, duplicate segments, excess cap and missing atomic submit",async()=>{
 const {p,port,d,store,blob}=setup();
 for(const usd of [0,-1,NaN,Infinity,2,.00001])assert.throws(()=>audioDemand(p,d.segment,20,usd));
 assert.throws(()=>audioContract({...p,generation:{...p.generation,authorization:{...p.generation.authorization!,usd:NaN}}}));
 await assert.rejects(port.reserve(p,[d,d]),/MANIFEST/);
 const ledger=memoryLedgerStore(),unsafe=audioPaidSupply({ledger,rpc:async()=>({error:null,data:{reserved:true}})});
 let sends=0;await assert.rejects(unsafe.synth(p,d,blob,store,async()=>{sends++;return Buffer.from("speech");}),/ATOMIC_SUBMIT/);assert.equal(sends,0);
});
test("two concurrent callers produce one durable send and no synthetic provider ID; retry reuses verified cache",async()=>{
 const {p,port,d,store,blob,ledger}=setup();await port.reserve(p,[d]);let sends=0;
 const produce=async()=>{sends++;return Buffer.from("existing binary speech");};
 const results=await Promise.allSettled([port.synth(p,d,blob,store,produce),port.synth(p,d,blob,store,produce)]);
 assert.ok(results.some(r=>r.status==="fulfilled"));assert.equal(sends,1);
 assert.equal(ledger.ops.get(d.key)!.status,"COMMITTED");assert.equal(ledger.ops.get(d.key)!.providerJobId,null);
 assert.match(ledger.ops.get(d.key)!.resultRef!,/ESTIMATED_TARIFF/);
 await port.synth(p,d,blob,store,produce);assert.equal(sends,1);
 assert.deepEqual(await port.usage(p),{spentUsd:.01,calls:1,characters:20});
});
test("timeout or lost provider response stays SUBMITTED; repeated attempts never resend",async()=>{
 const {p,port,d,store,blob,ledger}=setup();let sends=0;
 for(let i=0;i<3;i++)await assert.rejects(port.synth(p,d,blob,store,async()=>{sends++;throw Error("LOST_RESPONSE");}));
 assert.equal(sends,1);assert.equal(ledger.ops.get(d.key)!.status,"SUBMITTED");
});
test("crash after durable receipt resumes settlement once; lost/tampered committed cache requires restore",async()=>{
 const {p,port,d,store,blob,ledger}=setup();let sends=0;const update=ledger.update.bind(ledger);let fail=true;
 ledger.update=async(k,s,patch)=>{if(patch.status==="COMMITTED"&&fail){fail=false;throw Error("CRASH_BEFORE_COMMIT");}return update(k,s,patch);};
 const produce=async()=>{sends++;return Buffer.from("speech");};await assert.rejects(port.synth(p,d,blob,store,produce));
 assert.equal(ledger.ops.get(d.key)!.status,"PROVIDER_JOB_RECORDED");await port.synth(p,d,blob,store,produce);assert.equal(sends,1);
 store.blobs.set(blob,Buffer.from("corruption"));await assert.rejects(port.synth(p,d,blob,store,produce),/RESTORATION/);assert.equal(sends,1);
 store.getBlob=async()=>null;await assert.rejects(port.synth(p,d,blob,store,produce),/RESTORATION/);assert.equal(sends,1);
});
test("cache write failure or journal receipt failure never repeats an uncertain provider call",async()=>{
 for(const boundary of ["cache","receipt"]){const {p,port,d,store,blob,ledger}=setup();let sends=0;
  if(boundary==="cache")store.putBlob=async()=>{throw Error("DISK_ERROR");};
  else {const update=ledger.update.bind(ledger);ledger.update=async(k,s,patch)=>patch.status==="PROVIDER_JOB_RECORDED"?false:update(k,s,patch);}
  const produce=async()=>{sends++;return Buffer.from("speech");};
  await assert.rejects(port.synth(p,d,blob,store,produce));await assert.rejects(port.synth(p,d,blob,store,produce));
  assert.equal(sends,1);assert.equal(ledger.ops.get(d.key)!.status,"SUBMITTED");
 }
});
test("real-mode Audio adapter renders fresh playable MP3 through financial port using local WAV only, then reuses cache",async()=>{
 const {p,port,store,ledger}=setup();await store.create(p);let sends=0;
 const voice: StudioVoice={mode:"elevenlabs" as const,voiceIdFor:()=>"offline-voice",provider:(model)=>({name:"elevenlabs",model,label:"real adapter (untested live)",usdFor:()=>.01,async synth(_text:string,_voice:string,dest:string){sends++;execFileSync("ffmpeg",["-y","-v","error","-f","lavfi","-i","sine=frequency=440:duration=3","-ar","48000","-ac","1",dest]);return {actualUsd:.01};}})};
 assert.equal(await renderProject({store,voice,paidSupply:port,musicDir:"/tmp/audio-studio-test-music"},ownerId,id),"terminada");
 const result=(await store.get(ownerId,id))!;assert.equal(result.spentUsd,.01);assert.equal(result.generation.providerCalls,1);assert.equal(sends,1);
 assert.ok((await store.getBlob(result.audio!.path))!.length>1000);assert.equal(ledger.ops.size,1);
 await store.put({...result,spentUsd:0,generation:{...result.generation,status:"en_cola",providerCalls:0,charsSynthesized:0}});
 assert.equal(await renderProject({store,voice,paidSupply:port,musicDir:"/tmp/audio-studio-test-music"},ownerId,id),"terminada");
 const recovered=(await store.get(ownerId,id))!;assert.equal(sends,1);assert.equal(recovered.spentUsd,.01);assert.equal(recovered.generation.providerCalls,1);assert.equal(recovered.generation.charsSynthesized,scriptLines(p.script,1)[0].text.length);
});
