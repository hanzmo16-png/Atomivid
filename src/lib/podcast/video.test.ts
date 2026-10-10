import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPodcastMontage, readySignal } from "./video-montage";
import { requestPodcastVideo, narrationRunsInBackground, DISPATCH_UNCONFIRMED } from "./video-jobs";
import { isStalledVideo, PODCAST_VIDEO_STALE_MS, type PodcastEpisode } from "./episode";

const AUDIO = { path: "audio/episode.m4a", size: 100, sha256: "a".repeat(64) };

test("montage: 30 min → 6 cached 5-min chapter cards over the untouched premixed audio", () => {
  const m = buildPodcastMontage({ episodeId: "0b6f0c3e-8a51-4c2e-9d55-2f3c1a7e9b10", version: 2, title: "  Mi episodio  ", durationSeconds: 1800, audio: AUDIO });
  assert.equal(m.schema, "podcast-editor/montaje@2");
  assert.equal(m.assembly_version, 2);
  assert.equal(m.timeline.length, 6);
  assert.equal(m.timeline.reduce((s, x) => s + x.duration, 0), 1800);
  assert.ok(m.timeline.every((s) => s.type === "card" && s.duration <= 300));
  assert.deepEqual(m.timeline[5].lines, ["Mi episodio", "Parte 6 de 6"]);
  assert.deepEqual(m.audio, { modo: "mezcla_final", source: "mezcla", timeline: "extender_ultimo" });
  assert.equal(m.files[0].role, "mezcla_final");
  assert.equal(m.output.width, 1920);
  assert.match(m.episode_id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/, "episode id matches the editor contract");
  const short = buildPodcastMontage({ episodeId: "e1", version: 1, title: "", durationSeconds: 34.7, audio: AUDIO });
  assert.equal(short.timeline.length, 1);
  assert.deepEqual(short.timeline[0].lines, ["Episodio"]);
  assert.deepEqual(readySignal("b".repeat(64), m), { manifest_sha256: "b".repeat(64), file_count: 1, episode_id: m.episode_id, assembly_version: 2 });
});

function episode(over: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return { id: "11111111-1111-4111-8111-111111111111", user_id: "u", title: "t", language: "es", source: "tts", script: "x".repeat(40), voice_id: "v", voice_name: "n",
    characters: 40, estimated_usd: 0.01, status: "ready", run_token: null, run_started_at: null, audio_path: "p", audio_mime: "audio/mp4", duration_seconds: 30,
    audio_sha256: null, audio_bytes: null, loudness: null, cost_usd: 0, error: null, created_at: "", updated_at: "", video_status: "none", video_attempts: 0, ...over };
}
function fakeService(rowsMatched = 1) {
  const updates: Record<string, unknown>[] = [];
  const filters: string[] = [];
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, { get: (_t, k: string) => {
    if (k === "update") return (patch: Record<string, unknown>) => { updates.push(patch); return self; };
    if (k === "select") return async () => ({ data: Array.from({ length: rowsMatched }, () => ({ id: "x" })) });
    if (k === "then") return (r: (v: unknown) => unknown) => r({ data: null });
    return (...a: unknown[]) => { filters.push(`${k}:${JSON.stringify(a)}`); return self; };
  } });
  return { service: { from: () => self } as never, updates, filters };
}

test("video request: queues once, fenced by status/attempts, increments attempts; dispatch failure leaves a retryable message", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.GH_WORKER_TOKEN; delete process.env.GH_WORKER_REPO;
    const f = fakeService();
    const out = await requestPodcastVideo(f.service, episode());
    assert.deepEqual(out, { error: DISPATCH_UNCONFIRMED, status: 503 });
    assert.equal(f.updates[0].video_status, "queued");
    assert.equal(f.updates[0].video_attempts, 1);
    assert.equal(f.updates[1].video_status, "failed");
    assert.ok(f.filters.some((x) => x.startsWith("in:") && x.includes("none")), "only from a non-running state");
  } finally { process.env = saved; }
});

test("video request: refuses while a live job runs; allows retry when the job stopped beating", async () => {
  const now = Date.now();
  const live = episode({ video_status: "running", video_heartbeat_at: new Date(now - 60_000).toISOString(), video_attempts: 1 });
  assert.equal((await requestPodcastVideo(fakeService().service, live, now) as { status: number }).status, 409);
  const dead = episode({ video_status: "running", video_heartbeat_at: new Date(now - PODCAST_VIDEO_STALE_MS - 1000).toISOString(), video_attempts: 1 });
  assert.equal(isStalledVideo(dead, now), true);
  const f = fakeService();
  await requestPodcastVideo(f.service, dead, now);
  assert.ok(f.filters.some((x) => x.startsWith("eq:") && x.includes("video_attempts")), "a stale run is retaken only if nobody else retook it");
  assert.equal((await requestPodcastVideo(fakeService().service, episode({ source: "upload", status: "draft" })) as { status: number }).status, 409);
  assert.equal((await requestPodcastVideo(fakeService(0).service, episode()) as { status: number }).status, 409, "lost race → no dispatch");
});

test("long scripts narrate in the background worker; short ones stay in the request", () => {
  assert.equal(narrationRunsInBackground({ source: "tts", characters: 28_000 }), true);
  assert.equal(narrationRunsInBackground({ source: "tts", characters: 2_000 }), false);
  assert.equal(narrationRunsInBackground({ source: "upload", characters: 28_000 }), false);
});

test("worker: delivers only an editor-verified video, stores it privately, never uses the editor exchange account", () => {
  const w = readFileSync("scripts/podcast-video-worker.ts", "utf8");
  assert.match(w, /rep\.status !== "done" \|\| rep\.verification\?\.ok !== true/);
  assert.match(w, /\.eq\("video_run_token", token\)/, "every write fenced by the run token");
  assert.match(w, /from\("videos"\)/);
  assert.doesNotMatch(w, /podcast-editor"|PODCAST_EDITOR_(EMAIL|PASSWORD)/);
  const wf = readFileSync(".github/workflows/podcast-video.yml", "utf8");
  assert.match(wf, /types: \[podcast-video\]/);
  assert.doesNotMatch(wf, /PODCAST_EDITOR_/);
});
