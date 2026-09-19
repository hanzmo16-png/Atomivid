import test from "node:test";
import assert from "node:assert/strict";
import { heygenAvatarProvider as provider, estimateHeygenCost } from "./heygen";
import { AvatarProviderError } from "../types";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const req = { providerAvatarId: "asset:photo-one", script: "", audioUrl: "https://storage.test/recording.wav?token=private", audioDurationSeconds: 5, maxCostUsd: 2 };
async function mocked(fn: typeof fetch, body: () => Promise<void>) {
  const old = global.fetch; const key = process.env.HEYGEN_API_KEY;
  global.fetch = fn; process.env.HEYGEN_API_KEY = "test-secret";
  try { await body(); } finally { global.fetch = old; if (key === undefined) delete process.env.HEYGEN_API_KEY; else process.env.HEYGEN_API_KEY = key; }
}
test("photo+audio uses assets and data envelope, omits engine/text/voice, persists job before GET", async () => {
  const calls: string[] = [];
  await mocked(async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://storage.test")) return new Response("RIFF0000WAVE");
    if (u.endsWith("/v3/assets")) { assert.ok(init?.body instanceof FormData); calls.push("upload"); return json({ data: { asset_id: "audio-one" } }); }
    if (u.endsWith("/v3/videos")) {
      const p = JSON.parse(String(init?.body));
      assert.deepEqual(p, { type: "image", image: { type: "asset_id", asset_id: "photo-one" }, audio_asset_id: "audio-one", aspect_ratio: "auto", resolution: "720p" });
      calls.push("post"); return json({ data: { video_id: "job", status: "waiting" } });
    }
    if (u.endsWith("/v3/videos/job")) { calls.push("get"); return json({ data: { status: "completed", video_url: "https://result.test/video.mp4" } }); }
    return new Response(new Uint8Array([1,2,3]));
  }, async () => {
    const r = await provider.generateVideo({ ...req, onJobCreated: async id => { assert.equal(id,"job"); calls.push("persist"); } });
    assert.equal(r.providerJobId,"job"); assert.equal(r.costUsd,0.20); assert.equal(r.durationSeconds,5);
    assert.deepEqual(calls,["upload","post","persist","get"]);
  });
});
test("duration and budget fail before any upload; never fall back to TTS", async () => {
  await mocked(async () => { throw new Error("unexpected network"); }, async () => {
    for (const r of [{...req,audioUrl:undefined},{...req,audioDurationSeconds:undefined},{...req,audioDurationSeconds:NaN},{...req,maxCostUsd:0.01}]) await assert.rejects(()=>provider.generateVideo(r),AvatarProviderError);
  });
  assert.equal(estimateHeygenCost(42.794),1.65);
});
for (const failure of ["post","persist","poll"] as const) test(`never repeats creation after ${failure} failure`, async () => {
  let posts = 0;
  await mocked(async (url) => {
    const u=String(url);
    if(u.startsWith("https://storage.test")) return new Response("RIFF0000WAVE");
    if(u.endsWith("/v3/assets")) return json({data:{asset_id:"audio"}});
    if(u.endsWith("/v3/videos")) {posts++; return failure === "post" ? json({error:{code:"invalid_parameter",param:"engine",message:"Extra inputs are not permitted"}},400) : json({data:{video_id:"one"}});}
    return json({error:{code:"internal_error",message:"https://private.test?token=secret"}},503);
  },async()=>{
    await assert.rejects(()=>provider.generateVideo({...req,onJobCreated:async()=>{if(failure==="persist")throw new Error("persistence failed");}}),e=>{
      assert.ok(e instanceof Error);assert.ok(!e.message.includes("token=secret"));return true;
    }); assert.equal(posts,1);
  });
});
test("consent required before uploading photo", async () => {
  await mocked(async()=>{throw new Error("network must not run");},async()=>{
    await assert.rejects(()=>provider.createAvatar({photoBuffer:Buffer.from("x"),mimeType:"image/jpeg",consentGiven:false}),e=>e instanceof AvatarProviderError && e.reason==="consent_missing");
  });
});
test("recovery uses GET only, no new generation cost", async () => {
  await mocked(async(url,init)=>{assert.notEqual(init?.method,"POST");return String(url).includes("/v3/videos/") ? json({data:{status:"completed",video_url:"https://result.test/video.mp4"}}) : new Response("video");},async()=>{
    const r=await provider.recoverVideo!("existing");assert.equal(r.costUsd,0);
  });
});
