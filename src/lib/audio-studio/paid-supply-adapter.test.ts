import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertAudioSegmentSupplyAdmission, AudioPaidSupplyBlockedError } from "./paid-supply-adapter";
import { applyInput, newProject, scriptLines } from "./model";
import { memoryStore, projectDir } from "./store";
import { renderProject } from "./render";
import { resumeGeneration } from "./service";
import { segmentKey, settingsFor, type StudioVoice, type StudioVoiceMode } from "./voice";

const OWNER="11111111-1111-4111-8111-111111111111";
const ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW="2026-11-26T17:00:00.000Z";
function realVoice(calls: { count: number }, usd=0.01): StudioVoice {
  return { mode:"elevenlabs",voiceIdFor:()=>"real-voice",provider: model=>({name:"elevenlabs",model,label:"real adapter (untested live)",usdFor:()=>usd,async synth(){calls.count++;throw Error("FORBIDDEN_PROVIDER_HTTP");}}) };
}
async function queued(script="Primera intervención.\nSegunda intervención.") {
  const store=memoryStore();
  let p=applyInput(newProject({id:ID,ownerId:OWNER,now:NOW,voiceCount:1}),{script,music:{mode:"sin_musica",mood:"calma",volume:0,ducking:false,intro:false,outro:false}},NOW);
  p={...p,spentUsd:0.37,generation:{...p.generation,status:"en_cola",kind:"generar",providerCalls:2,charsSynthesized:17,progress:{done:1,total:2},authorization:{usd:1,spentBefore:0.37,revision:p.revision,model:p.ttsModel,at:NOW}}};
  await store.create(p);return {store,p};
}
function blobFor(p: Awaited<ReturnType<typeof queued>>["p"], text: string) {
  const key=segmentKey("elevenlabs",p.ttsModel,"real-voice",text,settingsFor(p.ttsModel));
  return `${projectDir(OWNER,ID)}/tts/${key}.mp3`;
}

test("real, unknown and mismatched adapters have no zero-price or environment bypass",()=>{
  const prior={NODE_ENV:process.env.NODE_ENV,VERCEL:process.env.VERCEL,SUPPLY_GUARD_ENFORCED:process.env.SUPPLY_GUARD_ENFORCED};
  try {
    for(const runtime of ["test","production"]){
      (process.env as Record<string,string|undefined>).NODE_ENV=runtime;process.env.VERCEL="1";process.env.SUPPLY_GUARD_ENFORCED="false";
      for(const [mode,name] of [["elevenlabs","elevenlabs"],["fixture","elevenlabs"],["demo","elevenlabs"],["elevenlabs","demo-espeak"],["future","future-tts"]])assert.throws(()=>assertAudioSegmentSupplyAdmission(mode as StudioVoiceMode,name),AudioPaidSupplyBlockedError);
    }
    assert.doesNotThrow(()=>assertAudioSegmentSupplyAdmission("fixture","fixture-espeak"));
    assert.doesNotThrow(()=>assertAudioSegmentSupplyAdmission("demo","demo-espeak"));
  }finally{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test("queued paid cache miss and repeated resume preserve authorization, progress and spent; zero HTTP",async()=>{
  const {store,p}=await queued();const calls={count:0};const voice=realVoice(calls,0);
  for(let attempt=0;attempt<2;attempt++){
    assert.equal(await renderProject({store,voice,now:()=>NOW},OWNER,ID),"fallida");
    const after=(await store.get(OWNER,ID))!;
    assert.match(after.generation.error!,/en espera de una reserva/);
    assert.equal(after.spentUsd,p.spentUsd);assert.equal(after.generation.providerCalls,2);assert.equal(after.generation.charsSynthesized,17);
    assert.deepEqual(after.generation.authorization,p.generation.authorization);assert.deepEqual(after.generation.progress,p.generation.progress);
    assert.equal(calls.count,0);assert.equal(after.audio,p.audio);
    assert.equal((await resumeGeneration({store,voice:{ok:true,voice},now:()=>NOW},OWNER,ID)).status,202);
  }
});

test("paid partial cache is reused untouched, a missing next segment remains blocked after cache loss",async()=>{
  const {store,p}=await queued();const calls={count:0};const voice=realVoice(calls);
  const first=scriptLines(p.script,p.voiceCount)[0].text;const blob=blobFor(p,first);const cached=Buffer.from("existing cached segment, never replaced");
  await store.putBlob(blob,cached,"audio/mpeg");
  assert.equal(await renderProject({store,voice,now:()=>NOW},OWNER,ID),"fallida");
  assert.deepEqual(await store.getBlob(blob),cached);assert.equal(calls.count,0);assert.equal((await store.get(OWNER,ID))!.spentUsd,0.37);
  const originalGet=store.getBlob.bind(store);store.getBlob=async key=>key===blob?null:originalGet(key);
  await resumeGeneration({store,voice:{ok:true,voice},now:()=>NOW},OWNER,ID);
  assert.equal(await renderProject({store,voice,now:()=>NOW},OWNER,ID),"fallida");assert.equal(calls.count,0);assert.equal((await store.get(OWNER,ID))!.spentUsd,0.37);
});

test("fully cached real speech still mixes to a playable MP3 without synth or another spend",async()=>{
  const {store,p}=await queued("Voz existente guardada.");const calls={count:0};const voice=realVoice(calls);const dir=await mkdtemp(path.join(tmpdir(),"aps-sentinel-test-"));
  try {
    const file=path.join(dir,"cached.mp3");
    execFileSync("ffmpeg",["-y","-v","error","-f","lavfi","-i","sine=frequency=440:duration=3","-ar","48000","-ac","1","-c:a","libmp3lame",file]);
    await store.putBlob(blobFor(p,scriptLines(p.script,p.voiceCount)[0].text),await readFile(file),"audio/mpeg");
    assert.equal(await renderProject({store,voice,now:()=>NOW,musicDir:path.join(tmpdir(),"audio-studio-test-music")},OWNER,ID),"terminada");
    const after=(await store.get(OWNER,ID))!;assert.equal(after.spentUsd,0.37);assert.equal(after.generation.providerCalls,2);assert.equal(calls.count,0);
    assert.equal(after.audio!.reusedSegments,1);assert.ok(after.audio!.bytes>0);assert.equal(after.generation.status,"terminada");
  }finally{await rm(dir,{recursive:true,force:true});}
});
