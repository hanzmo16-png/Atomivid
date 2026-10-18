/**
 * CORRECCIÓN-1 of the HTTP annex (T32): exclusion per request across the WHOLE retry chain, including both waits.
 * Codex reproduced (audit 1QvrG6Wfn5E6RLP7BXd3MHch7lrfO26Tw) that, during the 2 s / 4 s backoff after a 429/529, the
 * refunded attempt left the request without a live row, so a concurrent POST got `gen-N+1` and both ended COMMITTED.
 * Now the retry's row is reserved BEFORE the rejected one is refunded (never a gap), the intent selector holds a
 * concurrent POST off (in_flight) during the waits, and the retry re-checks the request before calling again.
 * Real SDK error classes, in-memory stores, real (short) waits so the interleaving is genuine; no network, no key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { RELEASED_RETRY_REF } from "@/lib/paid-calls/gate";
import { currentSupplyScope, guardScriptLedgerCall, withScriptGenerationContext } from "./anthropic";
import { scriptBlockState, ScriptReconciliationRequiredError, type ScriptOpRow } from "./script-intent";

const REQUEST = "cd71a440-0000-4000-8000-00000000c0c0";
const PARAMS = { model: "synthetic-model", max_tokens: 2000, messages: [{ role: "user", content: "tema sintético" }] };
const sdkError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());
const e429 = () => sdkError(429, "rate_limit_error", "rate limited");
const e529 = () => sdkError(529, "overloaded_error", "Overloaded");
const WAIT_MS = 60;
const ok = async () => ({ title: "guion", usage: { input_tokens: 1, output_tokens: 1 } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let calls = 0;
  const waits: number[] = [];
  const rows = async (projectId: string): Promise<ScriptOpRow[]> => [...store.ops.values()]
    .filter(o => o.projectId === projectId && o.provider === "anthropic" && o.method === "generate_script")
    .map(o => ({ status: o.status, shot_id: o.shotId, updated_at: o.updatedAt, idempotency_key: o.idempotencyKey }));
  /** One POST /script of this request, exactly as the route runs it (intent selection + claim + guarded call). */
  const post = <T>(invoke: (attempt: number) => Promise<T>) =>
    withScriptGenerationContext(REQUEST, () => guardScriptLedgerCall<T>(
      { store, results, load: rows, retryDelayMs: (n) => { waits.push(n); return WAIT_MS; } },
      currentSupplyScope()!, PARAMS, 0.0468, () => 0.01, () => { calls++; return invoke(calls); }), { guard: true, load: rows, store });
  const untilCalls = async (n: number) => { for (let i = 0; i < 200 && calls < n; i++) await sleep(2); await sleep(5); };
  const ops = () => [...store.ops.values()].map(o => ({ gen: o.shotId.split(":")[1], kind: o.attemptKind, status: o.status, usd: o.committedUsd, ref: o.resultRef }));
  return { store, rows, post, waits, ops, calls: () => calls, untilCalls };
}

for (const [label, reject] of [["429", e429], ["529", e529]] as const) {
  test(`${label}: un POST concurrente durante la 1.ª espera queda bloqueado (in_flight) y la cadena termina con UNA sola generación pagable`, async () => {
    const h = harness();
    const a = h.post(async (attempt) => { if (attempt === 1) throw reject(); return ok(); });
    await h.untilCalls(1);
    // Inside A's first wait: the request is never "settled" and a second POST cannot open gen-1.
    assert.equal(scriptBlockState(await h.rows(REQUEST), Date.now()), "in_flight", "no instant without a live row");
    await assert.rejects(h.post(ok), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "in_flight");
    const r = await a;
    assert.equal(r.reused, false);
    assert.equal(h.calls(), 2, "A's initial call + A's retry; the concurrent POST never called");
    assert.deepEqual(h.ops().map(o => [o.gen, o.kind, o.status, o.usd]), [["gen-0", "initial", "REFUNDED", 0], ["gen-0", "rejected_retry", "COMMITTED", 0.01]]);
    assert.equal(h.ops().filter(o => o.status === "COMMITTED").length, 1, "exactly one billable generation");
  });

  test(`${label}: un POST concurrente durante la 2.ª espera también queda bloqueado; A se recupera al 3.º intento`, async () => {
    const h = harness();
    const a = h.post(async (attempt) => { if (attempt <= 2) throw reject(); return ok(); });
    await h.untilCalls(2);
    assert.equal(scriptBlockState(await h.rows(REQUEST), Date.now()), "in_flight");
    await assert.rejects(h.post(ok), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "in_flight");
    await a;
    assert.equal(h.calls(), 3);
    assert.deepEqual(h.waits, [1, 2]);
    assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED", "REFUNDED", "COMMITTED"]);
  });
}

test("cadena agotada (3 rechazos): mientras dura, el request está bloqueado; al terminar queda libre y una regeneración legítima obtiene gen-1", async () => {
  const h = harness();
  const a = h.post(async () => { throw e429(); });
  await h.untilCalls(1);
  assert.equal(scriptBlockState(await h.rows(REQUEST), Date.now()), "in_flight");
  await assert.rejects(a, (e: unknown) => e instanceof Anthropic.RateLimitError);
  assert.equal(h.calls(), 3);
  assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED", "REFUNDED", "REFUNDED"], "every attempt settled: nothing reserved is left behind");
  assert.equal(scriptBlockState(await h.rows(REQUEST), Date.now()), null, "the request is free once the chain ends");
  const b = await h.post(ok);
  assert.equal(b.reused, false);
  assert.equal(h.calls(), 4);
  assert.deepEqual(h.ops().map(o => [o.gen, o.status]), [["gen-0", "REFUNDED"], ["gen-0", "REFUNDED"], ["gen-0", "REFUNDED"], ["gen-1", "COMMITTED"]]);
});

test("operación incierta de OTRA intención aparecida durante la espera: el reintento no llama al proveedor, libera su reserva y bloquea", async () => {
  const h = harness();
  const a = h.post(async () => { throw e429(); });
  await h.untilCalls(1);
  // Simulates an uncertain row of another intent of the same request surfacing while A sleeps (e.g. an older
  // interrupted call reconciled as uncertain by an operator path): the retry must not add a call on top of it.
  await h.store.insert({ idempotencyKey: "op_foreign_uncertain", projectId: REQUEST, shotId: "script:gen-7:legacy", provider: "anthropic", model: "claude-model", method: "generate_script",
    attemptKind: "initial", reservedUsd: 0.0468, status: "RECONCILIATION_REQUIRED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: new Date().toISOString() });
  await assert.rejects(a, (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "requires_reconciliation");
  assert.equal(h.calls(), 1, "no second provider call while the request has an unresolved operation");
  const own = h.ops().filter(o => o.gen === "gen-0");
  assert.deepEqual(own.map(o => [o.kind, o.status, o.usd]), [["initial", "REFUNDED", 0], ["rejected_retry", "REFUNDED", 0]]);
  assert.equal(own[1].ref, RELEASED_RETRY_REF, "the reserved retry row is released, never left as an orphan reservation");
  assert.equal(scriptBlockState(await h.rows(REQUEST), Date.now()), "requires_reconciliation", "the uncertain row still blocks the request");
});

test("sin huecos: en ningún muestreo durante la cadena el request aparece liquidado", async () => {
  const h = harness();
  const samples: (string | null)[] = [];
  let done = false;
  const a = h.post(async (attempt) => { if (attempt <= 2) throw e529(); return ok(); }).finally(() => { done = true; });
  await h.untilCalls(1);
  // From the first provider call until the chain settles (COMMITTED is a legitimate "settled"), every sample must block.
  while (!done) { samples.push(scriptBlockState(await h.rows(REQUEST), Date.now())); await sleep(3); }
  await a;
  assert.ok(samples.length >= 10, `sampled ${samples.length} times`);
  assert.ok(samples.every(s => s === "in_flight"), `every sample must be in_flight, got ${JSON.stringify([...new Set(samples)])}`);
  assert.equal(h.ops().filter(o => o.status === "COMMITTED").length, 1);
});

test("política conservada: 401 no se reintenta ni reserva un siguiente intento; 500 sigue incierto con una sola llamada", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw sdkError(401, "authentication_error", "invalid x-api-key"); }), (e: unknown) => e instanceof Anthropic.AuthenticationError);
  assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED"], "no reserved retry row for a final rejection");
  await sleep(5);
  await assert.rejects(h.post(async () => { throw sdkError(500, "api_error", "internal"); }), (e: unknown) => e instanceof Anthropic.InternalServerError);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED", "RECONCILIATION_REQUIRED"]);
  assert.deepEqual(h.waits, [], "no backoff for final or uncertain outcomes");
});
