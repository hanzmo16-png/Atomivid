/**
 * SIMULATED HeyGen v3 compatibility. No live HeyGen call, no API key, no charge.
 * These tests prove the local contract against fixtures. They do not prove production compatibility.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { heygenAvatarProvider as provider } from "./heygen";
import { AvatarProviderError } from "../types";
import { avatarStatusesThatMayAdvanceTo, handleAvatarWebhook } from "@/lib/video/avatar/webhook";
import { Conversation, DISCLAIMER } from "@/lib/podcast/v2/conversation";
import { jobSupplyDemands } from "@/lib/supply/job";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { inputFromReel } from "@/lib/video/director/from-reel";
import type { GeneratedScript } from "../types";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const req = { providerAvatarId: "asset:photo-one", script: "texto que no debe ir al proveedor", audioUrl: "https://storage.test/elevenlabs-narration.wav?token=private", audioDurationSeconds: 5, maxCostUsd: 2 };

async function mocked(fn: typeof fetch, body: () => Promise<void>) {
  const old = global.fetch;
  const key = process.env.HEYGEN_API_KEY;
  global.fetch = fn;
  process.env.HEYGEN_API_KEY = "test-secret";
  try { await body(); } finally {
    global.fetch = old;
    if (key === undefined) delete process.env.HEYGEN_API_KEY;
    else process.env.HEYGEN_API_KEY = key;
  }
}

test("1 SIMULATED normal avatar generation stays on POST /v3/videos at the verified 720p sample", async () => {
  const calls: string[] = [];
  await mocked(async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://storage.test")) return new Response("RIFF0000WAVE");
    if (u.endsWith("/v3/assets")) { calls.push("POST /v3/assets"); return json({ data: { id: "audio-from-id-field" } }); }
    if (u.endsWith("/v3/videos")) {
      const p = JSON.parse(String(init?.body));
      assert.equal(p.resolution, "720p");
      assert.equal(p.aspect_ratio, "auto");
      assert.equal(p.type, "image");
      assert.equal(p.engine, undefined);
      assert.equal(p.script, undefined);
      assert.equal(p.voice_id, undefined);
      assert.equal(p.audio_asset_id, "audio-from-id-field");
      calls.push("POST /v3/videos");
      return json({ data: { video_id: "vid_normal", status: "waiting" } });
    }
    if (u.endsWith("/v3/videos/vid_normal")) { calls.push("GET /v3/videos/vid_normal"); return json({ data: { id: "vid_normal", status: "completed", video_url: "https://files.heygen.ai/out.mp4" } }); }
    return new Response(new Uint8Array([1, 2, 3, 4]));
  }, async () => {
    const result = await provider.generateVideo({ ...req, onJobCreated: async (id) => { assert.equal(id, "vid_normal"); calls.push("persist"); } });
    assert.equal(result.providerJobId, "vid_normal");
    assert.equal(result.mimeType, "video/mp4");
    assert.deepEqual(calls, ["POST /v3/assets", "POST /v3/videos", "persist", "GET /v3/videos/vid_normal"]);
  });
});

test("2 SIMULATED video still processing maps pending and processing without another create", async () => {
  const posts: string[] = [];
  await mocked(async (url, init) => {
    if (init?.method === "POST") posts.push(String(url));
    const status = String(url).endsWith("pending-job") ? "pending" : "processing";
    return json({ data: { id: "job", status } });
  }, async () => {
    assert.equal(await provider.checkVideoStatus("pending-job"), "queued");
    assert.equal(await provider.checkVideoStatus("processing-job"), "processing");
  });
  assert.deepEqual(posts, []);
});

test("3 SIMULATED completed video downloads video_url and ignores gif and caption sidecars", async () => {
  const fetched: string[] = [];
  await mocked(async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.endsWith("/v3/videos/done-job")) {
      return json({ data: { id: "done-job", status: "completed", video_url: "https://files.heygen.ai/video/done.mp4", gif_url: "https://files.heygen.ai/gif/done.gif", captioned_video_url: "https://files.heygen.ai/video/done-captioned.mp4" } });
    }
    return new Response(new Uint8Array([9, 9]));
  }, async () => {
    const result = await provider.recoverVideo!("done-job");
    assert.equal(result.providerJobId, "done-job");
    assert.equal(result.extension, "mp4");
    assert.equal(result.costUsd, 0);
  });
  assert.deepEqual(fetched, ["https://api.heygen.com/v3/videos/done-job", "https://files.heygen.ai/video/done.mp4"]);
});

test("4 SIMULATED provider failure is terminal and does not create a replacement", async () => {
  let posts = 0;
  await mocked(async (url) => {
    const u = String(url);
    if (u.startsWith("https://storage.test")) return new Response("RIFF");
    if (u.endsWith("/v3/assets")) return json({ data: { asset_id: "audio" } });
    if (u.endsWith("/v3/videos")) { posts += 1; return json({ data: { video_id: "vid_fail", status: "waiting" } }); }
    return json({ data: { id: "vid_fail", status: "failed", failure_code: "rendering_failed", failure_message: "https://private.example/secret" } });
  }, async () => {
    await assert.rejects(() => provider.generateVideo(req), (e: unknown) => e instanceof AvatarProviderError && e.reason === "upstream_error" && !String(e).includes("private.example"));
  });
  assert.equal(posts, 1);
});

test("5 SIMULATED timeout stops the poll and a later read does not create again", async () => {
  let posts = 0;
  let gets = 0;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let tick = 0;
  const start = realNow();
  Date.now = () => start + tick++ * 250_000;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => realSetTimeout(fn as never, (ms ?? 0) >= 1000 ? 0 : ms, ...args as never[])) as unknown as typeof setTimeout;
  try {
    await mocked(async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://storage.test")) return new Response("RIFF");
      if (u.endsWith("/v3/assets")) return json({ data: { asset_id: "audio" } });
      if (init?.method === "POST" && u.endsWith("/v3/videos")) { posts += 1; return json({ data: { video_id: "vid_wait", status: "waiting" } }); }
      gets += 1;
      return json({ data: { id: "vid_wait", status: "processing" } });
    }, async () => {
      await assert.rejects(() => provider.generateVideo(req), (e: unknown) => e instanceof AvatarProviderError && e.reason === "timeout");
      assert.equal(await provider.checkVideoStatus("vid_wait"), "processing");
    });
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(posts, 1);
  assert.ok(gets >= 2 && gets < 30);
});

test("6 SIMULATED duplicate official webhook is idempotent and creates nothing", async () => {
  const row = { status: "processing" as string };
  const payload = { event_type: "avatar_video.success", event_data: { video_id: "vid_dupe", callback_id: "cb-1" } };
  const update = async (id: string, status: "queued" | "processing" | "completed" | "failed" | "cancelled") => {
    assert.equal(id, "vid_dupe");
    if (avatarStatusesThatMayAdvanceTo(status).includes(row.status as "processing")) row.status = status;
    return { error: null as string | null };
  };
  const first = await handleAvatarWebhook({ provider, rawPayload: payload, updateJobStatus: update });
  const second = await handleAvatarWebhook({ provider, rawPayload: payload, updateJobStatus: update });
  const late = await handleAvatarWebhook({ provider, rawPayload: { event_type: "avatar_video.fail", event_data: { video_id: "vid_dupe" } }, updateJobStatus: update });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(late.status, 200);
  assert.equal(row.status, "completed");
  assert.equal(provider.processWebhookPayload({ event_type: "avatar_video_gif.success", event_data: { video_id: "vid_dupe" } }), null);
});

test("7 SIMULATED legacy and incompatible payloads do not advance a job or repeat a create", async () => {
  assert.equal(provider.processWebhookPayload({ providerJobId: "old", status: "completed" }), null);
  assert.equal(provider.processWebhookPayload({ event_type: "avatar_video.success", data: { video_id: "vid_x" } }), null);
  let posts = 0;
  await mocked(async (url, init) => {
    if (init?.method === "POST") posts += 1;
    return json({ data: { id: "vid_odd", status: "rendering" } });
  }, async () => {
    await assert.rejects(() => provider.checkVideoStatus("vid_odd"), (e: unknown) => e instanceof AvatarProviderError && e.reason === "invalid_response");
  });
  assert.equal(posts, 0);
  await mocked(async () => json({ error: { code: "unauthorized", message: "bad key" } }, 401), async () => {
    await assert.rejects(() => provider.checkVideoStatus("vid_auth"), (e: unknown) => e instanceof AvatarProviderError && /kind=auth/.test((e as Error).message));
  });
});

test("8 SIMULATED podcast participant avatar does not call HeyGen", () => {
  const parsed = Conversation.parse({
    version: "podcast-conversation/1", topic: "Control simulado", target_minutes: 8,
    participants: [
      { id: "A", display_name: "Ana", source: "mock", voice_id: null, visual: "avatar" },
      { id: "B", display_name: "Luis", source: "mock", voice_id: null, visual: "none" },
    ],
    turns: ["uno", "dos", "tres", "cuatro"].map((text, i) => ({ turn_id: `t${i}`, speaker: i % 2 ? "B" as const : "A" as const, text: `Turno simulado ${text}.`, kind: i % 2 ? "answer" as const : "question" as const, claim: "opinion" as const, source_url: null, gap_after_ms: 0 })),
    disclaimer: DISCLAIMER,
  });
  assert.equal(parsed.participants[0].visual, "avatar");
  for (const file of ["src/lib/podcast/video-jobs.ts", "src/lib/podcast/video-montage.ts", "src/lib/podcast/v2/conversation.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /api\.heygen\.com|\/v1\/video\.list|\/v2\/video\/generate/);
  }
});

test("9 SIMULATED reel with a locked avatar does not call HeyGen; avatar mode only reserves the v3 provider", () => {
  const script: GeneratedScript = { title: "Reel simulado", segments: [{ text: "Una idea corta.", visualQuery: "presenter" }, { text: "Sin generar avatar.", visualQuery: "city" }] };
  const input = inputFromReel(simulateStoryboard(script), { avatarScenes: [{ sceneId: "scene-0", assetId: "avatar-approved" }] });
  assert.equal(input.segments[0].locked?.assetId, "avatar-approved");
  assert.doesNotMatch(readFileSync("src/lib/video/director/from-reel.ts", "utf8"), /api\.heygen\.com|\/v2\/video\/generate/);
  const flags = { ...getFeatureFlags(), avatarProvider: "heygen", maxAvatarCostUsd: 3 };
  const demands = jobSupplyDemands({ mode: "avatar", script_json: script, recorded_audio_path: "owner/reel.wav", long_form_production_plan: null }, "elevenlabs", flags);
  assert.deepEqual(demands.map((d) => d.provider), ["heygen"]);
});

test("10 SIMULATED ElevenLabs audio is uploaded and lip-synced; HeyGen TTS stays off", async () => {
  let audioDownloads = 0;
  await mocked(async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://storage.test")) { audioDownloads += 1; return new Response("RIFF-elevenlabs"); }
    if (u.endsWith("/v3/assets")) return json({ data: { asset_id: "el-audio" } });
    if (u.endsWith("/v3/videos")) {
      const p = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(p).sort(), ["aspect_ratio", "audio_asset_id", "image", "resolution", "type"]);
      return json({ data: { video_id: "vid_el", status: "pending" } });
    }
    return json({ data: { id: "vid_el", status: "completed", video_url: "https://files.heygen.ai/el.mp4" } });
  }, async () => {
    const result = await provider.generateVideo(req);
    assert.equal(result.providerJobId, "vid_el");
  });
  assert.equal(audioDownloads, 1);
});
