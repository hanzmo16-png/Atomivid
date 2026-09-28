import { test } from "node:test";
import assert from "node:assert/strict";
import { runwayVideoProvider, buildRunwayPayload } from "./runway";
import { GenerativeProviderError, type VideoGenerationRequest } from "../types";

const request: VideoGenerationRequest = { prompt: "The worker takes two steps. Stable corridor.", referenceImageUrl: "https://example.com/reference.png", aspectRatio: "16:9", durationSeconds: 5, maxCostUsd: 0.25 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
async function mock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>) {
  const originalFetch = global.fetch;
  const names = ["RUNWAY_API_KEY", "RUNWAYML_API_SECRET", "RUNWAY_MODEL"];
  const saved = names.map(name => process.env[name]);
  names.forEach(name => delete process.env[name]);
  process.env.RUNWAY_API_KEY = "test-key";
  global.fetch = (async (url, init) => handler(String(url), init)) as typeof fetch;
  try { await fn(); } finally {
    global.fetch = originalFetch;
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
  }
}

test("image-to-video sends the approved reference, API version and exact 720p ratio; persists before polling", async () => {
  let accepted = false;
  let posts = 0;
  await mock((url, init) => {
    if (init?.method === "POST") {
      posts++;
      assert.equal(url, "https://api.dev.runwayml.com/v1/image_to_video");
      assert.equal(new Headers(init.headers).get("X-Runway-Version"), "2024-11-06");
      assert.deepEqual(JSON.parse(String(init.body)), { model: "gen4_turbo", promptImage: request.referenceImageUrl, promptText: request.prompt, ratio: "1280:720", duration: 5 });
      return json({ id: "task-1" });
    }
    if (url.includes("/tasks/")) {
      assert.ok(accepted);
      assert.equal(new Headers(init?.headers).get("X-Runway-Version"), "2024-11-06");
      return json({ status: "SUCCEEDED", output: ["https://media.example.com/clip.mp4"] });
    }
    assert.equal(init?.headers, undefined);
    return new Response("video-bytes");
  }, async () => {
    const asset = await runwayVideoProvider.generateVideo({ ...request, onProviderJobAccepted: id => { assert.equal(id, "task-1"); accepted = true; } });
    assert.equal(asset.providerJobId, "task-1");
    assert.equal(asset.costUsd, 0.25);
    assert.equal(asset.costBasis, "estimated");
    assert.equal(posts, 1);
  });
});

test("missing reference, invalid duration and invalid budget fail before any paid request", async () => {
  await mock(() => { assert.fail("network must not be called"); }, async () => {
    for (const patch of [{ referenceImageUrl: undefined }, { durationSeconds: 8 }, { maxCostUsd: 0.24 }, { maxCostUsd: NaN }, { prompt: "" }, { seed: "-1" }]) {
      await assert.rejects(runwayVideoProvider.generateVideo({ ...request, ...patch }), e => e instanceof GenerativeProviderError && e.chargeOutcome === "not_sent");
    }
  });
});

test("429 rejection performs one POST and no automatic retry", async () => {
  let calls = 0;
  await mock(() => { calls++; return json({}, 429); }, async () => {
    await assert.rejects(runwayVideoProvider.generateVideo(request), e => e instanceof GenerativeProviderError && e.reason === "rate_limited" && e.chargeOutcome === "rejected");
    assert.equal(calls, 1);
  });
});

test("ambiguous POST response is marked uncertain and never retried", async () => {
  let calls = 0;
  await mock(() => { calls++; throw new Error("connection lost"); }, async () => {
    await assert.rejects(runwayVideoProvider.generateVideo(request), e => e instanceof GenerativeProviderError && e.chargeOutcome === "uncertain");
    assert.equal(calls, 1);
  });
});

test("accepted job survives polling failure; resume uses only GET and downloads the same job", async () => {
  let posts = 0;
  let recover = false;
  await mock((url, init) => {
    if (init?.method === "POST") { posts++; return json({ id: "saved-task" }); }
    if (url.includes("/tasks/")) return recover ? json({ status: "SUCCEEDED", output: ["https://media.example.com/clip.mp4"] }) : json({}, 503);
    return new Response("video");
  }, async () => {
    await assert.rejects(runwayVideoProvider.generateVideo(request), e => e instanceof GenerativeProviderError && e.providerJobId === "saved-task");
    recover = true;
    const asset = await runwayVideoProvider.resumeGeneration!("saved-task", request);
    assert.equal(asset.providerJobId, "saved-task");
    assert.equal(posts, 1);
  });
});

test("callback persistence failure does not re-submit an accepted task", async () => {
  let posts = 0;
  await mock((url, init) => {
    if (init?.method === "POST") { posts++; return json({ id: "saved-task" }); }
    if (url.includes("/tasks/")) return json({ status: "SUCCEEDED", output: ["https://media.example.com/clip.mp4"] });
    return new Response("video");
  }, async () => {
    const asset = await runwayVideoProvider.generateVideo({ ...request, onProviderJobAccepted: () => { throw new Error("disk unavailable"); } });
    assert.equal(asset.providerJobId, "saved-task");
    assert.equal(posts, 1);
  });
});

test("empty download preserves operation id for recovery", async () => {
  await mock(url => url.includes("/tasks/") ? json({ status: "SUCCEEDED", output: ["https://media.example.com/clip.mp4"] }) : new Response(""), async () => {
    await assert.rejects(runwayVideoProvider.resumeGeneration!("saved-task", request), e => e instanceof GenerativeProviderError && e.reason === "download_failed" && e.providerJobId === "saved-task");
  });
});

test("portrait payload uses 720:1280 and requested ten seconds", () => {
  assert.equal(buildRunwayPayload({ ...request, aspectRatio: "9:16", durationSeconds: 10, maxCostUsd: 0.5 }).ratio, "720:1280");
});
