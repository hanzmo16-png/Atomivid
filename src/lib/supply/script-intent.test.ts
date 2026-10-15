/**
 * Synthetic regressions for incident 1561fdb2 (Reel script, 2026-10-11): a call whose provider outcome is uncertain
 * (ledger RECONCILIATION_REQUIRED) followed by a retry/double click. In-memory ledger and result stores only:
 * no network, no provider, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { memoryLedgerStore, ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { currentSupplyScope, guardScriptLedgerCall, withScriptGenerationContext, withSupplyContext } from "./anthropic";
import { claimScriptOperation, decideScriptIntent, RELEASED_STALE_REF, scriptBlockState, ScriptReconciliationRequiredError, type ScriptOpRow } from "./script-intent";
import { paidCallKey } from "@/lib/paid-calls/gate";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { runScriptGeneration } from "@/lib/video/script-generation";
import type { GeneratedScript } from "@/lib/providers/types";
import { classifyScriptError, logScriptError, scriptErrorCode, SCRIPT_NO_RETRY_PREFIX } from "@/lib/video/script-error";
import { RequestCard } from "@/components/video/RequestCard";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const REQUEST = "c6027b4b-0000-4000-8000-000000000000"; // synthetic id shaped like the incident's
const NOW = Date.now(); // the engine stamps rows with the real clock
const PARAMS = { model: "synthetic-model", max_tokens: 2000, messages: [{ role: "user", content: "tema sintético" }] };

function harness() {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let now = NOW, calls = 0;
  const rows = async (projectId: string): Promise<ScriptOpRow[]> => [...store.ops.values()]
    .filter(o => o.projectId === projectId && o.provider === "anthropic" && o.method === "generate_script")
    .map(o => ({ status: o.status, shot_id: o.shotId, updated_at: o.updatedAt, idempotency_key: o.idempotencyKey }));
  /** One POST /script: persistent intent, then one guarded provider call. */
  const post = <T>(invoke: () => Promise<T>, params: Record<string, unknown> & { model: string } = PARAMS, load: (p: string) => Promise<ScriptOpRow[]> = rows) =>
    withScriptGenerationContext(REQUEST, () => guardScriptLedgerCall<T>({ store, results, now: () => now }, currentSupplyScope()!, params, 0.0461, () => 0.01,
      () => { calls++; return invoke(); }), { guard: true, load, store, now: () => now });
  return { store, results, rows, post, calls: () => calls, advance: (ms: number) => { now += ms; } };
}
const ok = async () => ({ title: "guion", usage: { input_tokens: 1, output_tokens: 1 } });
const uncertain = async (): Promise<never> => { throw new Error("synthetic: response arrived but could not be parsed"); };

test("antes del arreglo: cada POST tenía una intención aleatoria distinta (por eso el reintento esquivaba el bloqueo)", async () => {
  const a = await withSupplyContext(REQUEST, async () => currentSupplyScope()!.intentId);
  const b = await withSupplyContext(REQUEST, async () => currentSupplyScope()!.intentId);
  assert.notEqual(a, b);
});

test("decideScriptIntent: misma intención al repetir, nueva solo tras un intento resuelto, bloqueo tipado si hay incertidumbre", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  assert.deepEqual(decideScriptIntent([], NOW), { intentId: "gen-0" });
  assert.deepEqual(decideScriptIntent([{ status: "COMMITTED", shot_id: "script:gen-0:a", updated_at: at(9e5) }, { status: "COMMITTED", shot_id: "script:gen-0:b", updated_at: at(9e5) }], NOW), { intentId: "gen-1" });
  assert.deepEqual(decideScriptIntent([{ status: "REFUNDED", shot_id: "script:gen-3:a", updated_at: at(9e5) }], NOW), { intentId: "gen-4" });
  // Legacy random intents do not count as generations but still block when uncertain.
  assert.deepEqual(decideScriptIntent([{ status: "COMMITTED", shot_id: "script:6f1c-uuid:a", updated_at: at(9e5) }], NOW), { intentId: "gen-0" });
  const state = (rows: ScriptOpRow[]) => { try { decideScriptIntent(rows, NOW); return "allowed"; } catch (e) { assert.ok(e instanceof ScriptReconciliationRequiredError); return e.state; } };
  assert.equal(state([{ status: "RECONCILIATION_REQUIRED", shot_id: "script:6f1c-uuid:a", updated_at: at(9e5) }]), "requires_reconciliation");
  assert.equal(state([{ status: "PROVIDER_JOB_RECORDED", shot_id: "script:gen-0:a", updated_at: at(1) }]), "requires_reconciliation");
  assert.equal(state([{ status: "SUBMITTED", shot_id: "script:gen-0:a", updated_at: at(5_000) }]), "in_flight");
  assert.equal(state([{ status: "SUBMITTED", shot_id: "script:gen-0:a", updated_at: at(120_000) }]), "requires_reconciliation");
  assert.equal(state([{ status: "RESERVED", shot_id: "script:gen-0:a", updated_at: at(5_000) }]), "in_flight");
  assert.equal(state([{ status: "RESERVED", shot_id: "script:gen-0:a", updated_at: at(600_000) }]), "allowed");
  assert.equal(scriptBlockState([], NOW), null);
});

test("incidente: desenlace incierto y luego reintento → ni segunda llamada, ni segunda reserva, ni segundo cobro", async () => {
  const h = harness();
  await assert.rejects(h.post(uncertain), /could not be parsed/);
  assert.deepEqual([...h.store.ops.values()].map(o => o.status), ["RECONCILIATION_REQUIRED"]);
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), "requires_reconciliation");
  for (const params of [PARAMS, { ...PARAMS, messages: [{ role: "user", content: "tema editado" }] }]) {
    h.advance(60_000);
    await assert.rejects(h.post(ok, params), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "requires_reconciliation");
  }
  assert.equal(h.calls(), 1, "provider invoked once");
  assert.equal(h.store.ops.size, 1, "one reservation");
  assert.equal([...h.store.ops.values()].reduce((s, o) => s + (o.committedUsd ?? 0), 0), 0, "nothing committed");
});

test("aunque algo esquivara la decisión, la misma clave persistente topa con el ledger (motor) sin llamar", async () => {
  const h = harness();
  await assert.rejects(h.post(uncertain));
  const scope = { projectId: REQUEST, intentId: "gen-0" };
  await assert.rejects(guardScriptLedgerCall({ store: h.store, results: h.results }, scope, PARAMS, 0.0461, () => 0.01, async () => { throw new Error("must not be called"); }),
    (e: unknown) => e instanceof ReconciliationRequiredError);
  assert.equal(h.store.ops.size, 1);
});

test("doble clic concurrente: una sola llamada; el segundo recibe «en curso» sin tocar la fila del primero", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const first = h.post(async () => { await gate; return ok(); });
  const second = h.post(ok);
  await assert.rejects(second, (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "in_flight");
  release();
  assert.equal((await first).result.title, "guion");
  assert.equal(h.calls(), 1);
  assert.deepEqual([...h.store.ops.values()].map(o => o.status), ["COMMITTED"]);
});

test("reclamo atómico: dos peticiones con la misma clave ya decidida → solo una entra al motor", async () => {
  const store = memoryLedgerStore();
  const op = { idempotencyKey: "op_x", projectId: REQUEST, shotId: "script:gen-0:a", provider: "anthropic", model: "m", method: "generate_script", attemptKind: "initial", reservedUsd: 0.05 };
  await claimScriptOperation(store, op, NOW);
  await assert.rejects(claimScriptOperation(store, op, NOW + 10), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "in_flight");
  await store.update("op_x", "RESERVED", { status: "COMMITTED", committedUsd: 0.01, resultRef: "r" });
  await claimScriptOperation(store, op, NOW + 20); // settled: the engine reuses it at no cost
});

test("regeneración legítima tras un guion resuelto: nueva intención (gen-1) que sigue pasando por el ledger; repetir no paga dos veces", async () => {
  const h = harness();
  await h.post(ok);
  h.advance(300_000);
  await h.post(ok);
  assert.equal(h.calls(), 2);
  assert.deepEqual([...h.store.ops.values()].map(o => [o.shotId.split(":")[1], o.status]), [["gen-0", "COMMITTED"], ["gen-1", "COMMITTED"]]);
  // Replaying gen-1's exact key (e.g. a lost response) reuses the stored result: zero calls.
  const replay = await guardScriptLedgerCall({ store: h.store, results: h.results }, { projectId: REQUEST, intentId: "gen-1" }, PARAMS, 0.0461, () => 0.01, async () => { throw new Error("must not be called"); });
  assert.equal(replay.reused, true);
  assert.equal(h.calls(), 2);
});

test("sin guardia de suministro (local/fixtures) se conserva el comportamiento anterior y no se consulta el ledger", async () => {
  let loaded = false;
  const intent = await withScriptGenerationContext(REQUEST, async () => currentSupplyScope()!.intentId, { guard: false, load: async () => { loaded = true; return []; } });
  assert.equal(loaded, false);
  assert.ok(!intent.startsWith("gen-"));
});

test("mensaje seguro: con desenlace incierto nunca dice «intenta de nuevo»; en curso pide esperar", () => {
  for (const err of [new ScriptReconciliationRequiredError("requires_reconciliation", "x"), new ReconciliationRequiredError("op_secret_key: reconcile")]) {
    const m = classifyScriptError(err, "abcd1234");
    assert.ok(m.startsWith(SCRIPT_NO_RETRY_PREFIX), m);
    assert.ok(!/intenta de nuevo|reintenta/i.test(m), m);
    assert.ok(!m.includes("op_secret_key"), "never echoes the ledger key");
    assert.ok(m.endsWith("(Código: abcd1234)"));
    assert.equal(scriptErrorCode(err), "script_reconciliation_required");
  }
  const busy = classifyScriptError(new ScriptReconciliationRequiredError("in_flight", "x"), "abcd1234");
  assert.ok(busy.includes("en curso") && !busy.startsWith(SCRIPT_NO_RETRY_PREFIX));
  const logged: unknown[][] = [], orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try { logScriptError("POST /script", new ReconciliationRequiredError("op_secret_key: reconcile"), "abcd1234"); } finally { console.error = orig; }
  assert.deepEqual(logged[0][1], { errorName: "Error", errorClass: "ReconciliationRequiredError" });
  assert.ok(!JSON.stringify(logged).includes("op_secret_key"));
});

test("historial: con «No reintentes» no aparece el botón Reintentar del guion; con un fallo normal sí", () => {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
  const card = (error_message: string) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(RequestCard, {
    nowMs: NOW, request: { id: REQUEST, mode: "reel", topic: "Tema", style: "s", duration_seconds: 30, language: "es", status: "failed", video_path: null,
      error_message, script_json: null, progress_stage: null, render_attempts: 0, render_started_at: null, created_at: "2026-10-11T20:11:00Z" } as VideoRequestSummary })));
  const blocked = card(classifyScriptError(new ScriptReconciliationRequiredError("requires_reconciliation", "x"), "abcd1234"));
  assert.ok(blocked.includes("No reintentes"));
  assert.ok(blocked.includes("Reintentar está desactivado"));
  assert.ok(!blocked.includes(">Reintentar<"));
  const normal = card(classifyScriptError(new Error("boom"), "abcd1234"));
  assert.ok(normal.includes(">Reintentar<"));
});

// ---- Corrección 1 (auditoría de Codex del PR #102): reserva caducada y respuesta completa de la ruta ----

/** A RESERVED row left by a request that died before submitting (never reached the provider). */
function staleReserved(h: ReturnType<typeof harness>, params: Record<string, unknown> & { model: string }, intentId = "gen-0", ageMs = 600_000) {
  const spec = { projectId: REQUEST, shotId: `script:${intentId}:${stableHash(params, 16)}`, provider: "anthropic", model: params.model, method: "generate_script", inputFingerprint: params, reservedUsd: 0.0461 };
  const key = paidCallKey(spec);
  h.store.ops.set(key, { idempotencyKey: key, projectId: REQUEST, shotId: spec.shotId, provider: "anthropic", model: params.model, method: "generate_script", attemptKind: "initial",
    reservedUsd: 0.0461, committedUsd: null, status: "RESERVED", providerJobId: null, resultRef: null, updatedAt: new Date(NOW - ageMs).toISOString() });
  return key;
}
const live = (h: ReturnType<typeof harness>) => [...h.store.ops.values()].filter(o => o.status === "RESERVED" || o.status === "SUBMITTED");

test("RESERVED caducado con la misma clave: se libera (nunca llegó al proveedor), la nueva generación es gen-1, una llamada, ninguna fila huérfana", async () => {
  const h = harness();
  const stale = staleReserved(h, PARAMS);
  const paid = await h.post(ok);
  assert.equal(paid.result.title, "guion");
  assert.equal(h.calls(), 1);
  const released = h.store.ops.get(stale)!;
  assert.deepEqual([released.status, released.committedUsd, released.resultRef], ["REFUNDED", 0, RELEASED_STALE_REF], "released, never declared a completed call");
  assert.deepEqual([...h.store.ops.values()].filter(o => o.status === "COMMITTED").map(o => o.shotId.split(":")[1]), ["gen-1"]);
  assert.equal(live(h).length, 0, "no orphan reservation left");
});

test("RESERVED caducado con otra clave (tema editado): también se libera; nunca quedan dos reservas vivas", async () => {
  const h = harness();
  staleReserved(h, { ...PARAMS, messages: [{ role: "user", content: "tema anterior" }] });
  await h.post(ok);
  assert.equal(h.calls(), 1);
  assert.equal(live(h).length, 0);
  assert.deepEqual([...h.store.ops.values()].map(o => o.status).sort(), ["COMMITTED", "REFUNDED"]);
});

test("si la liberación pierde la carrera (otro la envió), se usa el estado real: nunca se confunde un envío con una reserva liberada", async () => {
  const h = harness();
  const stale = staleReserved(h, PARAMS);
  const update = h.store.update.bind(h.store);
  h.store.update = async (k, expected, patch) => {
    if (k === stale && expected === "RESERVED" && patch.status === "REFUNDED") { h.store.ops.set(k, { ...h.store.ops.get(k)!, status: "SUBMITTED", updatedAt: new Date(NOW).toISOString() }); return false; }
    return update(k, expected, patch);
  };
  await assert.rejects(h.post(ok), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "in_flight");
  assert.equal(h.calls(), 0);
  assert.equal(h.store.ops.get(stale)!.status, "SUBMITTED");
});

test("sin clave en la lectura (no se puede liberar): el motor reutiliza la misma fila RESERVED con un único envío CAS, sin segunda reserva", async () => {
  const h = harness();
  const stale = staleReserved(h, PARAMS);
  const noKeys = async (p: string) => (await h.rows(p)).map(r => ({ status: r.status, shot_id: r.shot_id, updated_at: r.updated_at }));
  await h.post(ok, PARAMS, noKeys);
  assert.equal(h.calls(), 1);
  assert.equal(h.store.ops.size, 1, "same row, no second reservation");
  assert.equal(h.store.ops.get(stale)!.status, "COMMITTED");
});

/** The route's response path (runScriptGeneration) over the in-memory ledger: what the HTTP client receives. */
function route(h: ReturnType<typeof harness>, invoke: () => Promise<{ title: string; usage?: { input_tokens: number; output_tokens: number } }>, opts: { loadRows?: () => Promise<ScriptOpRow[]>; guard?: boolean } = {}) {
  const persisted: Record<string, unknown>[] = [];
  const outcome = runScriptGeneration({
    generate: async () => (await h.post(invoke)).result as unknown as GeneratedScript,
    persist: async patch => { persisted.push(patch); },
    guard: opts.guard ?? true,
    loadRows: opts.loadRows ?? (() => h.rows(REQUEST)),
  });
  return { outcome, persisted };
}
const quiet = async <T>(fn: () => Promise<T>) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

test("ruta: doble clic concurrente → 200 para el primero, 409 «en curso» para el segundo, que no marca la solicitud como fallida", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const a = route(h, async () => { await gate; return ok(); });
  const b = route(h, ok);
  const second = await quiet(() => b.outcome);
  release();
  const first = await a.outcome;
  assert.equal(first.status, 200);
  assert.deepEqual([second.status, "reconciliation" in second.body && second.body.reconciliation], [409, "in_flight"]);
  assert.deepEqual(b.persisted, [], "the second click never touches the request");
  assert.deepEqual(a.persisted.map(p => p.status), ["script_ready"]);
  assert.equal(h.calls(), 1);
});

test("ruta: llamada incierta y fallo de lectura del ledger después → 409 «No reintentes» persistido; el reintento posterior también es 409 sin llamar", async () => {
  const h = harness();
  const r1 = route(h, uncertain, { loadRows: async () => { throw new Error("ledger down"); } });
  const o1 = await quiet(() => r1.outcome);
  assert.equal(o1.status, 409);
  assert.ok("error" in o1.body && o1.body.error.startsWith(SCRIPT_NO_RETRY_PREFIX));
  assert.deepEqual(r1.persisted.map(p => [p.status, String(p.error_message).startsWith(SCRIPT_NO_RETRY_PREFIX), p.script_json]), [["failed", true, null]]);
  h.advance(60_000);
  const r2 = route(h, ok);
  const o2 = await quiet(() => r2.outcome);
  assert.deepEqual([o2.status, "reconciliation" in o2.body && o2.body.reconciliation], [409, "requires_reconciliation"]);
  assert.equal(h.calls(), 1, "no second provider call");
  assert.equal(h.store.ops.size, 1, "no second reservation");
});

test("ruta: ledger ilegible ANTES de llamar → 503 «no se hizo ningún cobro», sin persistir ni llamar", async () => {
  const h = harness();
  const persisted: unknown[] = [];
  const outcome = await runScriptGeneration({
    generate: async () => (await withScriptGenerationContext(REQUEST, async () => ({ title: "x", segments: [] }) as unknown as GeneratedScript,
      { guard: true, load: async () => { throw new Error("ledger down"); }, store: h.store })),
    persist: async p => { persisted.push(p); }, guard: true, loadRows: () => h.rows(REQUEST),
  });
  assert.equal(outcome.status, 503);
  assert.ok("error" in outcome.body && outcome.body.error.includes("No se hizo ningún cobro"));
  assert.deepEqual(persisted, []);
  assert.equal(h.calls(), 0);
});

test("ruta: sin guardia, un fallo normal sigue siendo 500 con «Intenta de nuevo» (comportamiento anterior)", async () => {
  const h = harness();
  const persisted: Record<string, unknown>[] = [];
  const outcome = await quiet(() => runScriptGeneration({ generate: async () => { throw new Error("boom"); }, persist: async p => { persisted.push(p); }, guard: false, loadRows: () => h.rows(REQUEST) }));
  assert.equal(outcome.status, 500);
  assert.ok("error" in outcome.body && outcome.body.error.includes("Intenta de nuevo"));
  assert.equal(persisted[0].status, "failed");
});
