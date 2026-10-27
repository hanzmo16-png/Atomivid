/** Next-period supply waits of the documentary script job (zero external cost: in-memory job table, scripted provider).
 * Real incident (2026-10-27): the 21st Anthropic call of the day was refused («daily request quota», max 20); the job
 * answered «waiting» and the worker asked again 156 times in 48 min until its deadline, with a generic message. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueScriptJob, runScriptJobStep } from "./script-jobs";
import { fakeService, fakeProvider } from "./script-durability.test-fixtures";
import { SupplyUnavailableError, waitsForNextPeriod, nextPeriodMessage, NEXT_PERIOD_REASONS } from "@/lib/supply/policy";
import { workerNextAction } from "./script-worker-step";
import { researchDocumentary } from "./research";

const owner = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com" };
const fields = { topic: "Un día en la sabana", durationMinutes: "3", sources: "", openQuestions: "", language: "es" as const };

let current: ((url: unknown, init?: { body?: unknown }) => Promise<Response>) | null = null;
const dispatcher = ((url: unknown, init?: { body?: unknown }) => current!(url, init)) as typeof fetch;
async function harness() {
  const service = fakeService(owner), provider = fakeProvider();
  const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, AVATAR_PREPARATION_OWNER_EMAIL: process.env.AVATAR_PREPARATION_OWNER_EMAIL };
  const oldFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "offline-fixture-key";
  process.env.AVATAR_PREPARATION_OWNER_EMAIL = owner.email;
  current = provider.fetch; globalThis.fetch = dispatcher;
  const db = service as unknown as SupabaseClient;
  const job = await enqueueScriptJob(db, { id: owner.id, email_confirmed_at: "2026-01-01" }, fields, db);
  const row = () => service.tables.documentary_script_jobs.find(r => r.id === job.id)! as Record<string, unknown>;
  const restore = () => { globalThis.fetch = oldFetch; for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return { service, provider, db, job, row, restore };
}
const refusing = (reason: string): typeof researchDocumentary => async () => { throw new SupplyUnavailableError("anthropic", reason); };

test("classification: daily quota and period spend ceilings wait for the next period; transient refusals do not", () => {
  for (const r of ["daily request quota", "provider funded spend ceiling", "global funded spend ceiling"]) assert.equal(waitsForNextPeriod(r), true, r);
  for (const r of ["concurrency", "balance unverified or stale", "new work paused", "insufficient unreserved balance", "supplier unavailable", "control unavailable", ""]) assert.equal(waitsForNextPeriod(r), false, r);
  assert.equal(new SupplyUnavailableError("anthropic", "daily request quota").waitsForNextPeriod, true);
  for (const r of Object.keys(NEXT_PERIOD_REASONS)) {
    const m = nextPeriodMessage(r);
    assert.match(m, /No se hizo ninguna llamada nueva ni se cobró/);
    assert.match(m, /Reanudar/);
    assert.doesNotMatch(m, /anthropic|quota|ceiling|USD/i, "no internal provider names or codes in the customer text");
  }
});

test("daily quota: the real step persists a specific wait and answers waiting_period; nothing is sent to the provider", async () => {
  const h = await harness();
  try {
    const out = await runScriptJobStep(h.job.id, h.db, { research: refusing("daily request quota") });
    assert.equal(out.state, "waiting_period");
    const r = h.row();
    assert.equal(r.status, "queued");
    assert.equal(r.run_token, null, "released: the next resume can claim it");
    assert.equal(r.stage, "En espera del próximo periodo del proveedor");
    assert.match(String(r.error_message), /número máximo de solicitudes del día/);
    assert.equal(h.provider.state.requests, 0, "no provider request");
    assert.deepEqual(workerNextAction(out.state), { kind: "stop_waiting_period" }, "the worker stops instead of polling");
  } finally { h.restore(); }
});

test("transient refusal (concurrency) keeps the short bounded wait and the generic message", async () => {
  const h = await harness();
  try {
    const out = await runScriptJobStep(h.job.id, h.db, { research: refusing("concurrency") });
    assert.equal(out.state, "waiting");
    assert.equal(h.row().stage, "Esperando disponibilidad");
    assert.deepEqual(workerNextAction(out.state), { kind: "retry", afterMs: 15_000 });
  } finally { h.restore(); }
});

test("recovery: after the period resets, the same queued job resumes and completes (no new job, no duplicated request)", async () => {
  const h = await harness();
  try {
    assert.equal((await runScriptJobStep(h.job.id, h.db, { research: refusing("daily request quota") })).state, "waiting_period");
    // Owner presses «Reanudar» the next day: the normal step runs with the real research again.
    let last = "";
    for (let i = 0; i < 80; i++) { last = (await runScriptJobStep(h.job.id, h.db)).state; if (last !== "queued") break; }
    assert.equal(last, "completed");
    assert.equal(h.service.tables.documentary_script_jobs.length, 1, "same job row");
    assert.equal(h.provider.state.paid, h.provider.state.requests, "every provider request is distinct (nothing paid twice)");
  } finally { h.restore(); }
});

test("long waits: the worker's per-answer decisions (bounded; only short waits poll)", () => {
  assert.deepEqual(workerNextAction("completed"), { kind: "done" });
  assert.deepEqual(workerNextAction("probe_ok"), { kind: "done" });
  assert.deepEqual(workerNextAction("waiting_period"), { kind: "stop_waiting_period" });
  assert.deepEqual(workerNextAction("running"), { kind: "retry", afterMs: 60_000 });
  assert.deepEqual(workerNextAction("queued"), { kind: "retry", afterMs: 0 });
  assert.equal(workerNextAction("failed").kind, "error");
  // The incident: 156 «waiting» answers in a row. With a next-period refusal the worker now stops after ONE answer.
  let polls = 0; for (const s of ["waiting_period", "waiting_period"]) { polls++; if (workerNextAction(s).kind === "stop_waiting_period") break; }
  assert.equal(polls, 1);
});
