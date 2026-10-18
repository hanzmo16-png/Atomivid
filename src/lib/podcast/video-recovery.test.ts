import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { requestPodcastVideo } from "./video-jobs";
import { PODCAST_VIDEO_STALE_MS, type PodcastEpisode } from "./episode";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const OLD = new Date(NOW - PODCAST_VIDEO_STALE_MS - 1).toISOString();
const FRESH = new Date(NOW).toISOString();

function episode(status: "queued" | "running"): PodcastEpisode {
  return {
    id: "11111111-1111-4111-8111-111111111111", user_id: "owner", title: "Fixture", language: "es",
    source: "upload", script: null, voice_id: null, voice_name: null, characters: 0, estimated_usd: 0,
    status: "ready", run_token: null, run_started_at: null, audio_path: "fixture.m4a", audio_mime: "audio/mp4",
    duration_seconds: 30, audio_sha256: null, audio_bytes: 100, loudness: null, cost_usd: 0, error: null,
    created_at: OLD, updated_at: OLD, video_status: status, video_attempts: 1, retry_count: 0,
    video_run_token: "22222222-2222-4222-8222-222222222222", video_heartbeat_at: OLD, video_requested_at: OLD,
  };
}

/** Real Supabase client and request function; all HTTP is intercepted before reaching any service. */
function fixture(row: PodcastEpisode, beforeUpdate: () => void = () => undefined) {
  let writes = 0;
  const service = createClient("https://fixture.supabase.co", "fixture-only-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/v1/podcast_episodes");
      assert.equal(init?.method, "PATCH");
      beforeUpdate();
      const matches = [...url.searchParams].every(([key, filter]) => {
        if (key === "select") return true;
        const value = row[key as keyof PodcastEpisode];
        if (filter === "is.null") return value == null;
        if (filter.startsWith("eq.")) return value != null && String(value) === filter.slice(3);
        if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(String(value));
        throw new Error(`Unexpected filter: ${key}=${filter}`);
      });
      if (matches) { Object.assign(row, JSON.parse(String(init?.body))); writes++; }
      return new Response(JSON.stringify(matches ? [{ id: row.id }] : []), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } },
  });
  return { service, writes: () => writes };
}

function interceptDispatch(t: TestContext) {
  let calls = 0;
  const token = process.env.GH_WORKER_TOKEN, repo = process.env.GH_WORKER_REPO;
  process.env.GH_WORKER_TOKEN = "fixture-only-token"; process.env.GH_WORKER_REPO = "fixture/repository";
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 204 }); });
  t.after(() => {
    if (token === undefined) delete process.env.GH_WORKER_TOKEN; else process.env.GH_WORKER_TOKEN = token;
    if (repo === undefined) delete process.env.GH_WORKER_REPO; else process.env.GH_WORKER_REPO = repo;
  });
  return () => calls;
}

for (const state of ["queued", "running"] as const) {
  for (const scenario of ["heartbeat", "token", "fallback-request", "missing-heartbeat", "missing-token", "owner", "attempt", "completed"] as const) {
    test(`recovery ${state}: changed ${scenario} cannot be replaced by a stale snapshot`, async (t) => {
      const row = episode(state);
      if (scenario === "fallback-request" || scenario === "missing-heartbeat") row.video_heartbeat_at = null;
      if (scenario === "missing-token") row.video_run_token = null;
      const snapshot = { ...row };
      let current: PodcastEpisode;
      const f = fixture(row, () => {
        if (scenario === "heartbeat" || scenario === "missing-heartbeat") row.video_heartbeat_at = FRESH;
        if (scenario === "token" || scenario === "missing-token") row.video_run_token = "33333333-3333-4333-8333-333333333333";
        if (scenario === "fallback-request") row.video_requested_at = FRESH;
        if (scenario === "owner") row.user_id = "other-owner";
        if (scenario === "attempt") row.video_attempts = 2;
        if (scenario === "completed") row.video_status = "ready";
        current = { ...row };
      });
      const dispatches = interceptDispatch(t);
      const result = await requestPodcastVideo(f.service, snapshot, {}, NOW);
      assert.ok("error" in result && result.status === 409);
      assert.equal(f.writes(), 0);
      assert.equal(dispatches(), 0);
      assert.deepEqual(row, current!);
    });
  }

  for (const missing of [false, true]) test(`recovery ${state}: unchanged stale snapshot, missing timestamps/token=${missing}, has one winner`, async (t) => {
    const row = episode(state);
    if (missing) { row.video_heartbeat_at = null; row.video_requested_at = null; row.video_run_token = null; }
    const snapshot = { ...row }, f = fixture(row);
    const dispatches = interceptDispatch(t);
    const results = await Promise.all([requestPodcastVideo(f.service, snapshot, {}, NOW), requestPodcastVideo(f.service, snapshot, {}, NOW)]);
    assert.equal(results.filter(r => "ok" in r).length, 1);
    assert.equal(results.filter(r => "error" in r && r.status === 409).length, 1);
    assert.equal(f.writes(), 1); assert.equal(dispatches(), 1);
    assert.equal(row.video_attempts, 2); assert.equal(row.video_status, "queued");
    assert.notEqual(row.video_run_token, snapshot.video_run_token);
    assert.equal(row.video_heartbeat_at, FRESH);

  });
}
