import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { runSchedulerTick } from "./pilot-server";
import type { PodcastEpisode } from "./episode";

function episode(id = "e1"): PodcastEpisode {
  return { id, user_id: "owner", title: "Fixture", language: "es", source: "upload", script: null,
    voice_id: null, voice_name: null, characters: 0, estimated_usd: 0, status: "ready", run_token: null,
    run_started_at: null, audio_path: "fixture.m4a", audio_mime: "audio/mp4", duration_seconds: 30,
    audio_sha256: null, audio_bytes: 100, loudness: null, cost_usd: 0, error: null, created_at: "", updated_at: "",
    video_status: "scheduled", video_attempts: 0, retry_count: 0, scheduled_at: "2026-10-01T00:00:00Z" };
}

/** Real query builder with in-memory rows; writes to any financial table are rejected. */
function fixture(rows = [episode()]) {
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const service = createClient("https://fixture.supabase.co", "fixture-only-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)), table = url.pathname.split("/").at(-1);
      let data: unknown;
      if (table === "pi_paid_operations") {
        assert.equal(init?.method, "GET", "ledger remains read-only"); data = [];
      } else {
        assert.equal(table, "podcast_episodes");
        const matching = rows.filter(row => [...url.searchParams].every(([key, filter]) => {
          if (["select", "limit", "order"].includes(key)) return true;
          const value = row[key as keyof PodcastEpisode];
          if (filter.startsWith("eq.")) return value != null && String(value) === filter.slice(3);
          if (filter.startsWith("lte.")) return value != null && Date.parse(String(value)) <= Date.parse(filter.slice(4));
          throw new Error(`Unexpected filter ${key}=${filter}`);
        }));
        if (init?.method === "PATCH") {
          const patch = JSON.parse(String(init.body));
          for (const row of matching) { Object.assign(row, patch); writes.push({ id: row.id, patch }); }
          data = matching.map(row => ({ id: row.id }));
        } else {
          assert.equal(init?.method, "GET");
          data = url.searchParams.get("select") === "run_budget_usd" ? { run_budget_usd: 0 } : matching.map(row => ({ ...row }));
        }
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    } },
  });
  return { service, rows, writes };
}

for (const mode of ["false", "throw"] as const) test(`scheduler ${mode}: lost acknowledgement preserves claim and the next tick does not resend`, async () => {
  const f = fixture(); let calls = 0; let accepted: PodcastEpisode;
  const dispatch = async () => {
    calls++; if (calls === 1) accepted = { ...f.rows[0] };
    if (mode === "throw") throw new Error("private-network-error");
    return false;
  };
  const first = await runSchedulerTick(f.service, "*", dispatch);
  const second = await runSchedulerTick(f.service, "*", dispatch);
  assert.equal(calls, 1, "lost acknowledgement must not cause a second dispatch on the next tick");
  assert.deepEqual(f.rows[0], accepted!);
  assert.equal(f.rows[0].video_status, "queued");
  assert.deepEqual(first, { due: 1, dispatched: 0, blocked: 0, requeued: 0, unconfirmed: 1 });
  assert.equal(second.due, 0); assert.equal(calls, 1); assert.equal(f.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(first), /private-network/);
});

test("scheduler: confirmed dispatch counts once and no subsequent tick repeats it", async () => {
  const f = fixture(); let calls = 0;
  const dispatch = async () => { calls++; return true; };
  assert.deepEqual(await runSchedulerTick(f.service, "*", dispatch), { due: 1, dispatched: 1, blocked: 0, requeued: 0, unconfirmed: 0 });
  await runSchedulerTick(f.service, "*", dispatch);
  assert.equal(calls, 1); assert.equal(f.writes.length, 1);
});

for (const state of ["running", "ready", "queued"] as const) test(`scheduler: delayed negative acknowledgement cannot mutate a newer ${state} state`, async () => {
  const f = fixture(); let current: PodcastEpisode;
  await runSchedulerTick(f.service, "*", async () => {
    Object.assign(f.rows[0], { video_status: state, video_run_token: "new-token", video_attempts: 8 });
    current = { ...f.rows[0] }; return false;
  });
  assert.deepEqual(f.rows[0], current!);
  assert.equal(f.writes.length, 1);
});

test("scheduler: one unconfirmed dispatch does not abort other independently claimed episodes", async () => {
  const f = fixture([episode("e1"), episode("e2")]), calls: string[] = [];
  const out = await runSchedulerTick(f.service, "*", async id => {
    calls.push(id); if (id === "e1") throw new Error("lost response"); return true;
  });
  assert.deepEqual(calls, ["e1", "e2"]);
  assert.deepEqual(out, { due: 2, dispatched: 1, blocked: 0, requeued: 0, unconfirmed: 1 });
  assert.ok(f.rows.every(row => row.video_status === "queued" && row.video_attempts === 1));
});

test("scheduler: concurrent ticks dispatch one claim even when the acknowledgement is lost", async () => {
  const f = fixture(); let calls = 0;
  const dispatch = async () => { calls++; return false; };
  await Promise.all([runSchedulerTick(f.service, "*", dispatch), runSchedulerTick(f.service, "*", dispatch)]);
  assert.equal(calls, 1); assert.equal(f.writes.length, 1);
  assert.equal(f.rows[0].video_status, "queued"); assert.equal(f.rows[0].video_attempts, 1);
});
