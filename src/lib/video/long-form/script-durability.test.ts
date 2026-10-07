/** Acceptance tests for durable documentary preparation (zero external cost).
 * Real SDK serialization; scripted provider via fetch; in-memory job table. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueScriptJob, runScriptJobStep, reconcileStaleScriptJobs, retryScriptJob, STALE_RUNNING_MS } from "./script-jobs";
import { scriptJobView, type ScriptJobSummary } from "./script-job-types";
import { fakeService, fakeProvider, type ProviderMode } from "./script-durability.test-fixtures";
import { collectFragments, missingFragments, topLevelObjects } from "./narrative-fragments";
import { locateNormalized } from "./text-locate";
import { selectResubmission } from "@/lib/supply/anthropic";
import { paidCallKey } from "@/lib/paid-calls/gate";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { editorialBlockers, validateEditorialReview } from "./editorial";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { z } from "zod";

const owner = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
const fields = { topic: "A legend examined", durationMinutes: "3", sources: "", openQuestions: "", language: "en" as const };

// The SDK client is cached per process and keeps the fetch it was built with:
// install ONE dispatcher and swap the scripted provider behind it per test.
let current: ((url: unknown, init?: { body?: unknown }) => Promise<Response>) | null = null;
const dispatcher = ((url: unknown, init?: { body?: unknown }) => current!(url, init)) as typeof fetch;
async function harness(mode: ProviderMode = {}) {
  const service = fakeService(owner), provider = fakeProvider(mode);
  const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, AVATAR_PREPARATION_OWNER_EMAIL: process.env.AVATAR_PREPARATION_OWNER_EMAIL };
  const oldFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "offline-fixture-key";
  process.env.AVATAR_PREPARATION_OWNER_EMAIL = owner.email;
  current = provider.fetch; globalThis.fetch = dispatcher;
  const db = service as unknown as SupabaseClient;
  const job = await enqueueScriptJob(db, { id: owner.id, email_confirmed_at: "2026-01-01" }, fields, db);
  const row = () => service.tables.documentary_script_jobs.find(r => r.id === job.id)! as unknown as ScriptJobSummary & Record<string, unknown>;
  /** Same loop as scripts/documentary-script-worker.ts. */
  const work = async () => { let last = ""; for (let i = 0; i < 80; i++) { last = (await runScriptJobStep(job.id, db)).state; if (last !== "queued") break; } return last; };
  const restore = () => { globalThis.fetch = oldFetch; for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return { service, provider, db, job, row, work, restore };
}

test("1-3: the request is persisted before any provider work and finishes with no page open", async () => {
  const h = await harness();
  try {
    assert.equal(h.provider.state.requests, 0, "nothing paid before the job row exists");
    assert.equal(h.row().status, "queued");
    // The user leaves: no HTTP request is held. The worker advances the saved job.
    assert.equal(await h.work(), "completed");
    // Returning later reads persisted state only.
    const view = scriptJobView(h.row(), Date.now());
    assert.equal(view.label, "Guion listo");
    assert.equal(h.service.tables.video_requests.length, 1);
    assert.equal(h.service.tables.video_requests[0].status, "script_ready");
    // A reload mid-processing reads the same row; queued/running keep auto-refresh on.
    assert.equal(scriptJobView({ ...h.row(), status: "running", updated_at: new Date().toISOString() }, Date.now()).refresh, true);
  } finally { h.restore(); }
});

test("4: a forced technical failure is persisted, readable, classified and retryable", async () => {
  const h = await harness({ failWriterFormat: true });
  try {
    assert.equal(await h.work(), "failed");
    const r = h.row();
    assert.equal(r.failure_kind, "technical");
    assert.match(String(r.error_code), /^[0-9a-f]{8}$/);
    assert.match(String(r.error_message), /Código: [0-9a-f]{8}/);
    const view = scriptJobView(r, Date.now());
    assert.equal(view.label, "Fallo técnico");
    assert.ok(view.action);
  } finally { h.restore(); }
});

test("5: a truncated draft continues from the last complete block, without duplicates", async () => {
  const h = await harness({ truncateWriter: true });
  try {
    assert.equal(await h.work(), "completed");
    assert.equal(h.provider.state.continuations, 1);
    const beats = (h.service.tables.video_requests[0].script_json as { beats: { narration: string }[] }).beats;
    assert.deepEqual(beats.map(b => b.narration), h.provider.script.beats.map(b => b.narration));
    assert.equal(new Set(beats.map(b => b.narration)).size, beats.length);
  } finally { h.restore(); }
});

test("5b: fragment collection keeps only complete objects and refuses repeated paragraphs", () => {
  const plan = z.object({ fragment: z.literal("plan"), storyPlan: z.object({ sections: z.array(z.unknown()) }) });
  const beat = z.object({ fragment: z.literal("beat"), index: z.number(), type: z.string(), purpose: z.string(), narration: z.string() });
  const text = ['{"fragment":"plan","storyPlan":{"sections":[1,2,3]}}', '{"fragment":"beat","index":0,"type":"hook","purpose":"p","narration":"A {brace} \\"quoted\\" opening."}',
    '{"fragment":"beat","index":1,"type":"x","purpose":"p","narration":"A {brace} \\"quoted\\" opening."}', '{"fragment":"beat","index":2,"type":"x","purpose":"p","narra'].join("\n");
  assert.equal(topLevelObjects(text).length, 3);
  const set = collectFragments({ beats: new Map(), rejected: 0 }, { stop_reason: "max_tokens", content: [{ type: "text", text }] }, plan, beat);
  assert.deepEqual([...set.beats.keys()], [0]);
  assert.equal(set.rejected, 1, "duplicated paragraph under another number is refused");
  assert.deepEqual(missingFragments(set), { plan: false, beats: [1, 2] });
});

test("6: reviewer and planner select stable IDs; copied text and trivial differences never break", async () => {
  const h = await harness({ reviewerExtraKeys: true });
  try {
    assert.equal(await h.work(), "completed");
    const sj = h.service.tables.video_requests[0].script_json as { beats: { narration: string; visuals: { quote: string }[] }[]; editorial: { reviews: { sections: { quote: string; beatIndex: number }[] }[] } };
    for (const s of sj.editorial.reviews[0].sections) assert.ok(sj.beats[s.beatIndex].narration.includes(s.quote), "text is derived from the original");
    for (const b of sj.beats) for (const v of b.visuals) assert.ok(b.narration.includes(v.quote));
  } finally { h.restore(); }
  const narration = "Herodotus wrote: “The Spartans — three hundred — stayed.”  Then the pass fell.";
  assert.equal(locateNormalized(narration, '"the spartans - three hundred - stayed."'), "The Spartans — three hundred — stayed");
  assert.equal(locateNormalized(narration, "the persians won easily"), null);
});

test("7: a valid but repetitive draft is an editorial objection, never a technical failure", async () => {
  const h = await harness({ repetitive: true });
  try {
    assert.equal(await h.work(), "failed");
    const r = h.row();
    assert.equal(r.failure_kind, "editorial");
    assert.doesNotMatch(String(r.error_message), /No se pudo completar/);
    const view = scriptJobView(r, Date.now());
    assert.equal(view.label, "Objeción editorial");
    assert.equal(view.action, "Pedir otra corrección editorial");
    assert.ok((r.editorial_checkpoint as { status: string }).status === "unapproved", "the draft stays visible, unapproved");
    // Owner requests one more correction: earlier stages replay, only the new correction is new.
    const paidBefore = h.provider.state.paid;
    assert.equal(await retryScriptJob(owner.id, h.job.id, h.db), "queued");
    assert.equal(await h.work(), "failed");
    assert.equal(h.row().editorial_rounds, 1);
    // One new correction request; the review of an identical draft replays from the saved response.
    assert.equal(h.provider.state.paid - paidBefore, 1);
  } finally { h.restore(); }
});

test("7b: a closing callback the reviewer accepts as resolution is not also a repetition blocker", () => {
  const script = editorialFixture(), review = passingReview(script);
  review.sections[4].function = "restatement";
  assert.deepEqual(editorialBlockers(validateEditorialReview(review, script)), []);
  review.sections[2].function = "restatement";
  assert.equal(editorialBlockers(validateEditorialReview(review, script)).length, 1, "a middle block that only repeats still blocks");
});

test("8: double submit and double retry create one job and one requeue; replays are free", async () => {
  const h = await harness({ failWriterFormat: true });
  try {
    const again = await enqueueScriptJob(h.db, { id: owner.id }, fields, h.db);
    assert.equal(again.id, h.job.id);
    assert.equal(h.service.tables.documentary_script_jobs.length, 1);
    await h.work();
    const paid = h.provider.state.paid;
    const [a, b] = await Promise.all([retryScriptJob(owner.id, h.job.id, h.db), retryScriptJob(owner.id, h.job.id, h.db)]);
    assert.deepEqual([a, b].sort(), ["queued", "refused"]);
    assert.equal(h.row().retry_count, 1);
    await h.work();
    assert.equal(h.provider.state.paid, paid, "the retry replays saved requests; nothing is paid twice");
    // Bounded: retries stop at the cap.
    for (let i = 0; i < 5; i++) { await retryScriptJob(owner.id, h.job.id, h.db); await h.work(); }
    assert.equal(h.row().retry_count, 3);
    assert.equal(scriptJobView(h.row(), Date.now()).action, null);
  } finally { h.restore(); }
});

test("9: a killed worker becomes a persisted interrupted state, resumable, and a late result cannot overwrite", async () => {
  const mode: ProviderMode = { hangOn: "writer" };
  const h = await harness(mode);
  try {
    // Research, then the writer request hangs (Vercel would kill the invocation).
    let step: Promise<unknown> | null = null;
    for (let i = 0; i < 5 && !step; i++) {
      const p = runScriptJobStep(h.job.id, h.db);
      const raced = await Promise.race([p, new Promise(r => setTimeout(() => r("hung"), 50))]);
      if (raced === "hung") step = p;
    }
    assert.ok(step, "writer step is in flight");
    assert.equal(h.row().status, "running");
    // 10+ minutes later nobody is working on it: the page load persists that.
    h.service.setClock(Date.parse(String(h.row().updated_at)) + STALE_RUNNING_MS + 60_000);
    await reconcileStaleScriptJobs(owner.id, h.db, Date.parse(h.service.now()));
    assert.equal(h.row().status, "failed");
    assert.equal(h.row().failure_kind, "interrupted");
    assert.equal(scriptJobView(h.row(), Date.now()).label, "Interrumpido");
    // The dead invocation finally returns: its writes are fenced by run_token.
    h.provider.state.release();
    await assert.rejects(step as Promise<unknown>, /ownership lost/);
    assert.equal(h.row().status, "failed");
    assert.equal(h.row().failure_kind, "interrupted");
    // Owner resumes: one bounded re-submission is authorized; the job completes.
    assert.equal(await retryScriptJob(owner.id, h.job.id, h.db), "queued");
    assert.equal(h.row().resubmit_allowance, 1);
    mode.hangOn = undefined;
    assert.equal(await h.work(), "completed");
    assert.equal(h.service.tables.video_requests.length, 1, "one approved script, no duplicate");
  } finally { h.restore(); }
});

test("9b: re-submission keys skip only uncertain rows and always reuse committed results", async () => {
  const store = memoryLedgerStore();
  const spec = () => ({ projectId: "documentary:x", shotId: "script:documentary:abc", provider: "anthropic", model: "m", method: "generate_script", inputFingerprint: {}, reservedUsd: 1 });
  const put = async (s: ReturnType<typeof spec>, status: "SUBMITTED" | "COMMITTED") => store.ops.set(paidCallKey(s), { status } as never);
  const base = spec();
  await put(base, "SUBMITTED");
  const without = spec(); await selectResubmission(store, without, 0);
  assert.equal(without.shotId, base.shotId, "no allowance: the uncertain key stays blocked");
  const once = spec(); assert.equal((await selectResubmission(store, once, 1)) ?? undefined, undefined);
  assert.equal(once.shotId, `${base.shotId}:resubmit-1`);
  await put(once, "COMMITTED");
  const replay = spec(); assert.equal((await selectResubmission(store, replay, 2))?.status, "COMMITTED");
  assert.equal(replay.shotId, `${base.shotId}:resubmit-1`, "a committed re-submission is reused, never paid again");
});
