/**
 * Audit F1 (#200 @ 7153c35): the video route opened the episode's immutable spend authorization BEFORE the pure checks
 * of requestPodcastVideo, so a refused request fixed its cap for good. The checks now live in
 * validatePodcastVideoRequest and the route runs them first. USD 0, no network.
 * Run: node --import tsx --test src/lib/podcast/video-request-validation.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePodcastVideoRequest, requestPodcastVideo } from "./video-jobs";
import type { PodcastEpisode } from "./episode";
import type { SupabaseClient } from "@supabase/supabase-js";

function episode(over: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return { id: "11111111-1111-4111-8111-111111111111", user_id: "u", title: "t", language: "es", source: "tts", script: "x".repeat(40), voice_id: "v", voice_name: "n",
    characters: 40, estimated_usd: 0.01, status: "ready", run_token: null, run_started_at: null, audio_path: "p", audio_mime: "audio/mp4", duration_seconds: 30,
    audio_sha256: null, audio_bytes: null, loudness: null, cost_usd: 0, error: null, created_at: "", updated_at: "", video_status: "none", video_attempts: 0, ...over };
}
const okOptions = { budgetUsd: 5, spentUsd: 0, pendingUsd: 0.5, pendingChunks: 1, runBudgetUsd: 5, runBudgetColumn: true, uncertainCharges: 0 };
const status = (r: ReturnType<typeof validatePodcastVideoRequest>) => (r.ok === true ? 200 : r.status);

test("F1 a valid request passes the pure checks", () => {
  const r = validatePodcastVideoRequest(episode(), okOptions);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("F1 every refusal is decided by the pure checks (402 / 402 / 409 / 409 / 429 / 400)", () => {
  const now = Date.now();
  assert.equal(status(validatePodcastVideoRequest(episode(), { ...okOptions, budgetUsd: 0.01, pendingUsd: 0.0123 })), 402, "total budget too small (the F1 reproduction)");
  assert.equal(status(validatePodcastVideoRequest(episode(), { ...okOptions, runBudgetUsd: 0.0001 })), 402, "run limit too small");
  assert.equal(status(validatePodcastVideoRequest(episode(), { ...okOptions, uncertainCharges: 1 })), 409, "uncertain charge");
  assert.equal(status(validatePodcastVideoRequest(episode({ video_status: "running", video_heartbeat_at: new Date(now - 60_000).toISOString(), video_attempts: 1 }), okOptions, now)), 409, "already producing");
  assert.equal(status(validatePodcastVideoRequest(episode({ video_status: "failed", retry_count: 4 }), okOptions)), 429, "attempts exhausted");
  assert.equal(status(validatePodcastVideoRequest(episode(), { ...okOptions, scheduleAt: "not-a-date" })), 400, "invalid schedule");
});

test("F1 an uncertain charge is reported as such (not as a budget/authorization message)", () => {
  const r = validatePodcastVideoRequest(episode(), { ...okOptions, uncertainCharges: 1 });
  assert.ok(r.ok !== true && /incierto|confirmar|concili/i.test(r.error), JSON.stringify(r));
});

test("F1 the route validates BEFORE it opens the spend authorization, and passes the same options to requestPodcastVideo", () => {
  const src = readFileSync("src/app/api/podcast/[id]/video/route.ts", "utf8");
  const v = src.indexOf("validatePodcastVideoRequest(episode, options)");
  const a = src.indexOf("ensurePodcastSpendAuthorization(service");
  const r = src.indexOf("requestPodcastVideo(service, episode, options)");
  assert.ok(v > 0 && a > 0 && r > 0, "all three calls present");
  assert.ok(v < a && a < r, "validate → authorize → request");
});

test("F1 requestPodcastVideo keeps refusing on its own (defence in depth, no write on refusal)", async () => {
  let writes = 0;
  const service = { from: () => { writes++; throw new Error("must not write"); } } as unknown as SupabaseClient;
  const out = await requestPodcastVideo(service, episode(), { ...okOptions, budgetUsd: 0.01, pendingUsd: 0.0123 });
  assert.equal((out as { status: number }).status, 402);
  assert.equal(writes, 0);
});
