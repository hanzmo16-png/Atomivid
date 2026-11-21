import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPodcastMontage, readySignal } from "./video-montage";
import { requestPodcastVideo, narrationRunsInBackground, VIDEO_DISPATCH_UNCONFIRMED } from "./video-jobs";
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

test("video request: queues once, fenced by status/attempts, increments attempts; unconfirmed dispatch preserves the queued claim", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.GH_WORKER_TOKEN; delete process.env.GH_WORKER_REPO;
    const f = fakeService();
    const out = await requestPodcastVideo(f.service, episode());
    assert.deepEqual(out, { error: VIDEO_DISPATCH_UNCONFIRMED, status: 503 });
    assert.equal(f.updates[0].video_status, "queued");
    assert.equal(f.updates[0].video_attempts, 1);
    assert.equal(f.updates.length, 1, "unconfirmed dispatch must not undo admission");
    assert.ok(f.filters.some((x) => x.startsWith("in:") && x.includes("none")), "only from a non-running state");
  } finally { process.env = saved; }
});

test("video request: refuses while a live job runs; allows retry when the job stopped beating", async () => {
  const now = Date.now();
  const live = episode({ video_status: "running", video_heartbeat_at: new Date(now - 60_000).toISOString(), video_attempts: 1 });
  assert.equal((await requestPodcastVideo(fakeService().service, live, {}, now) as { status: number }).status, 409);
  const dead = episode({ video_status: "running", video_heartbeat_at: new Date(now - PODCAST_VIDEO_STALE_MS - 1000).toISOString(), video_attempts: 1 });
  assert.equal(isStalledVideo(dead, now), true);
  const f = fakeService();
  await requestPodcastVideo(f.service, dead, {}, now);
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
  // A cancelled run is marked failed by its own token at once (not after the 12-minute stall), never a newer one.
  assert.match(w, /writeFile\(process\.env\.PODCAST_TOKEN_FILE, token\)/);
  const mf = readFileSync("scripts/podcast-video-mark-failed.ts", "utf8");
  assert.match(mf, /query\.eq\("video_run_token", token\)/);
  assert.match(mf, /\.in\("video_status", \["queued", "running"\]\)/);
  assert.equal(wf.match(/PODCAST_TOKEN_FILE: \$\{\{ runner\.temp \}\}\/podcast-run-token/g)?.length, 2, "worker and mark-failed share the file");
});

/** Real request function with stateful CAS semantics; no real GitHub/provider access. */
function dispatchFixture(options: { claimError?: boolean; claimThrows?: boolean } = {}) {
  const row = episode();
  const writes: Record<string, unknown>[] = [];
  const service = { from: () => {
    let patch: Record<string, unknown>;
    const filters: Array<() => boolean> = [];
    const execute = () => {
      writes.push(patch);
      if (options.claimThrows) throw new Error("private-db");
      if (options.claimError) return { data: null, error: { message: "private-db" } };
      const matches = filters.every(f => f());
      if (matches) Object.assign(row, patch);
      return { data: matches ? [{ id: row.id }] : [], error: null };
    };
    const q = {
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      eq: (key: string, value: unknown) => { filters.push(() => row[key as keyof PodcastEpisode] === value); return q; },
      in: (key: string, values: unknown[]) => { filters.push(() => values.includes(row[key as keyof PodcastEpisode])); return q; },
      select: async () => execute(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(execute).then(resolve, reject),
    };
    return q;
  } } as unknown as Parameters<typeof requestPodcastVideo>[0];
  return { row, writes, service };
}

async function withFakeDispatch(fetcher: typeof fetch, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_WORKER_TOKEN, originalRepo = process.env.GH_WORKER_REPO;
  globalThis.fetch = fetcher;
  process.env.GH_WORKER_TOKEN = "fixture-only-not-a-real-token";
  process.env.GH_WORKER_REPO = "fixture/repository";
  try { await run(); } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_WORKER_TOKEN; else process.env.GH_WORKER_TOKEN = originalToken;
    if (originalRepo === undefined) delete process.env.GH_WORKER_REPO; else process.env.GH_WORKER_REPO = originalRepo;
  }
}

test("dispatch uncertainty: accepted request with lost response stays queued and blocks immediate duplicate", async () => {
  const f = dispatchFixture(); let calls = 0;
  await withFakeDispatch(async () => { calls++; throw new Error("response lost after acceptance"); }, async () => {
    const result = await requestPodcastVideo(f.service, { ...f.row });
    assert.ok("error" in result && result.status === 503);
    if ("error" in result) assert.doesNotMatch(result.error, /Pulsa.*Reintentar|no se cobra nada dos veces/i);
    assert.equal(f.row.video_status, "queued");
    assert.equal(f.writes.length, 1, "no terminal write on an ambiguous network response");
    const duplicate = await requestPodcastVideo(f.service, { ...f.row });
    assert.ok("error" in duplicate && duplicate.status === 409);
    assert.equal(calls, 1);
  });
});
for (const status of ["queued", "running", "ready"] as const) test(`dispatch uncertainty: delayed response cannot change a newer ${status} attempt`, async () => {
  const f = dispatchFixture();
  await withFakeDispatch(async () => {
    Object.assign(f.row, { video_run_token: "new-token", user_id: "new-owner", video_status: status, video_error: "new-state" });
    throw new Error("old response failed");
  }, async () => {
    await requestPodcastVideo(f.service, { ...f.row });
    assert.equal(f.row.video_status, status);
    assert.equal(f.row.video_run_token, "new-token");
    assert.equal(f.row.video_error, "new-state");
    assert.equal(f.writes.length, 1);
  });
});
for (const options of [{ claimError: true }, { claimThrows: true }]) test("dispatch uncertainty: failed claim never dispatches or mislabels a database error as competition", async () => {
  const f = dispatchFixture(options); let calls = 0;
  await withFakeDispatch(async () => { calls++; return new Response(null, { status: 204 }); }, async () => {
    const out = await requestPodcastVideo(f.service, { ...f.row });
    assert.ok("error" in out && out.status === 500);
    assert.doesNotMatch(JSON.stringify(out), /private-db/);
    assert.equal(calls, 0);
  });
});
test("dispatch uncertainty: HTTP 503 also preserves the admitted attempt", async () => {
  const f = dispatchFixture();
  await withFakeDispatch(async () => new Response(null, { status: 503 }), async () => {
    const out = await requestPodcastVideo(f.service, { ...f.row });
    assert.ok("error" in out && out.status === 503);
    assert.equal(f.row.video_status, "queued");
    assert.equal(f.writes.length, 1);
  });
});
test("dispatch uncertainty: two simultaneous admissions dispatch exactly once", async () => {
  const f = dispatchFixture(); const snapshot = { ...f.row }; let calls = 0;
  await withFakeDispatch(async () => { calls++; return new Response(null, { status: 204 }); }, async () => {
    const out = await Promise.all([requestPodcastVideo(f.service, snapshot), requestPodcastVideo(f.service, snapshot)]);
    assert.equal(out.filter(x => "ok" in x).length, 1);
    assert.equal(out.filter(x => "error" in x && x.status === 409).length, 1);
    assert.equal(calls, 1);
    assert.equal(f.row.video_attempts, 1);
  });
});
