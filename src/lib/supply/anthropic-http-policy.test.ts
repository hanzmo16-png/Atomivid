/**
 * HTTP policy of the script provider (Anthropic) under the ledger guard, status by status, with the REAL SDK error
 * classes and in-memory stores: no network, no credential, no database. Each case fixes the ledger state, the number of
 * provider calls, whether a later POST of the same request is blocked, the owner-facing message and that no secret
 * reaches the log.
 *   401/403 → rejected_final: REFUNDED, 1 call, request free, "configuration" message.
 *   429/529 → rejected: bounded retries with a progressive wait, every attempt REFUNDED under its own key, request free.
 *   500 (and other 5xx) → uncertain: RECONCILIATION_REQUIRED, 1 call, request blocked until an operator reconciles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { currentSupplyScope, guardScriptLedgerCall, withScriptGenerationContext } from "./anthropic";
import { classifyAnthropicError, SCRIPT_REJECTED_RETRIES, scriptRetryDelayMs } from "./anthropic-error";
import { scriptBlockState, ScriptReconciliationRequiredError, type ScriptOpRow } from "./script-intent";
import { classifyScriptError, logScriptError, scriptErrorCode } from "@/lib/video/script-error";

const REQUEST = "cd71a440-0000-4000-8000-0000000000ff";
const NOW = Date.now();
const PARAMS = { model: "synthetic-model", max_tokens: 2000, messages: [{ role: "user", content: "tema sintético" }] };
const sdkError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());
const e401 = () => sdkError(401, "authentication_error", "invalid x-api-key");
const e403 = () => sdkError(403, "permission_error", "Your API key does not have permission to use the specified resource.");
const e429 = () => sdkError(429, "rate_limit_error", "This request would exceed your organization's rate limit");
const e529 = () => sdkError(529, "overloaded_error", "Overloaded");
const e500 = () => sdkError(500, "api_error", "An unexpected error has occurred internal to Anthropic's systems.");

function harness(opts: { retries?: number } = {}) {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let now = NOW, calls = 0;
  const waits: number[] = [];
  const rows = async (projectId: string): Promise<ScriptOpRow[]> => [...store.ops.values()]
    .filter(o => o.projectId === projectId && o.provider === "anthropic" && o.method === "generate_script")
    .map(o => ({ status: o.status, shot_id: o.shotId, updated_at: o.updatedAt, idempotency_key: o.idempotencyKey }));
  const post = <T>(invoke: (attempt: number) => Promise<T>) =>
    withScriptGenerationContext(REQUEST, () => guardScriptLedgerCall<T>(
      { store, results, now: () => now, maxRejectedRetries: opts.retries, retryDelayMs: (n) => { waits.push(scriptRetryDelayMs(n)); return 0; } },
      currentSupplyScope()!, PARAMS, 0.0468, () => 0.01, () => { calls++; return invoke(calls); }), { guard: true, load: rows, store, now: () => now });
  return { store, rows, post, waits, calls: () => calls, advance: (ms: number) => { now += ms; }, ops: () => [...store.ops.values()] };
}
const ok = async () => ({ title: "guion", usage: { input_tokens: 1, output_tokens: 1 } });
const captureLog = (fn: () => void) => { const out: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); }; try { fn(); } finally { console.error = orig; } return out.join("\n"); };

test("clasificación por estado: 401/403 final, 429/529 rechazo reintentable, 500/502/503 y red inciertos", () => {
  assert.deepEqual(classifyAnthropicError(e401()), { kind: "rejected_final" });
  assert.deepEqual(classifyAnthropicError(e403()), { kind: "rejected_final" });
  assert.deepEqual(classifyAnthropicError(e429()), { kind: "rejected" });
  assert.deepEqual(classifyAnthropicError(e529()), { kind: "rejected" });
  assert.deepEqual(classifyAnthropicError(sdkError(503, "overloaded_error", "overloaded")), { kind: "rejected" }, "el cuerpo overloaded_error también es admisión rechazada");
  for (const e of [e500(), sdkError(502, "api_error", "bad gateway"), sdkError(503, "api_error", "unavailable"), sdkError(400, "invalid_request_error", "x"), sdkError(404, "not_found_error", "model"),
    new Anthropic.APIConnectionError({ message: "socket hang up" }), new Anthropic.APIConnectionTimeoutError({ message: "timeout" }), new Error("response arrived but could not be parsed")]) {
    assert.deepEqual(classifyAnthropicError(e), { kind: "uncertain" }, String(e));
  }
  assert.equal(SCRIPT_REJECTED_RETRIES, 2);
  assert.deepEqual([1, 2, 3, 4].map(scriptRetryDelayMs), [2000, 4000, 8000, 8000], "espera progresiva acotada");
});

test("403: rechazo final igual que 401 → REFUNDED, 1 llamada, mensaje de configuración, el request no queda bloqueado", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw e403(); }), (e: unknown) => e instanceof Anthropic.PermissionDeniedError);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.ops().map(o => [o.status, o.committedUsd]), [["REFUNDED", 0]]);
  assert.match(h.ops()[0].resultRef ?? "", /^rejected:rejected_final:/);
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), null);
  assert.equal(scriptErrorCode(e403()), "anthropic_permission_denied");
  assert.match(classifyScriptError(e403(), "d1"), /revisión de configuración.*repetir ahora no resolverá/);
  h.advance(5_000);
  await h.post(ok);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => [o.shotId.split(":")[1], o.status]), [["gen-0", "REFUNDED"], ["gen-1", "COMMITTED"]]);
});

test("429: reintentos acotados con espera progresiva; cada intento REFUNDED bajo su propia clave; agotados, el error sale y el request queda libre", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw e429(); }), (e: unknown) => e instanceof Anthropic.RateLimitError);
  assert.equal(h.calls(), 1 + SCRIPT_REJECTED_RETRIES, "intento inicial + reintentos acotados");
  assert.deepEqual(h.waits, [2000, 4000], "espera antes de cada reintento");
  const ops = h.ops();
  assert.equal(ops.length, 3, "una fila por intento: nunca se reutiliza una clave rechazada");
  assert.equal(new Set(ops.map(o => o.idempotencyKey)).size, 3);
  assert.deepEqual(ops.map(o => [o.status, o.committedUsd, o.attemptKind]), [["REFUNDED", 0, "initial"], ["REFUNDED", 0, "rejected_retry"], ["REFUNDED", 0, "rejected_retry"]]);
  for (const o of ops) assert.match(o.resultRef ?? "", /^rejected:rejected:/);
  assert.equal(ops.reduce((s, o) => s + (o.committedUsd ?? 0), 0), 0, "ningún cargo");
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), null, "sin reconciliación pendiente: no hay trabajo atrapado");
  assert.match(classifyScriptError(e429(), "d2"), /demasiadas solicitudes.*espera unos minutos y reintenta/);
  // Recovered (simulated): the same request generates under a new intent with one call.
  h.advance(60_000);
  await h.post(ok);
  assert.equal(h.calls(), 4);
  assert.equal(h.ops().filter(o => o.status === "COMMITTED").length, 1);
});

test("429 que se recupera en el segundo intento: una sola fila COMMITTED, las rechazadas quedan REFUNDED a 0", async () => {
  const h = harness();
  const r = await h.post(async (attempt) => { if (attempt === 1) throw e429(); return ok(); });
  assert.equal(r.reused, false); assert.equal(r.costUsd, 0.01);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => [o.status, o.committedUsd]), [["REFUNDED", 0], ["COMMITTED", 0.01]]);
  assert.deepEqual(h.waits, [2000]);
});

test("529 overloaded: misma política que 429 (admisión rechazada, reintento acotado)", async () => {
  const h = harness({ retries: 1 });
  await assert.rejects(h.post(async () => { throw e529(); }), (e: unknown) => e instanceof Anthropic.InternalServerError);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED", "REFUNDED"]);
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), null);
});

test("500: incierto, sin reintento automático → RECONCILIATION_REQUIRED, 1 llamada, el siguiente POST se bloquea (nunca un segundo cobro)", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw e500(); }), (e: unknown) => e instanceof Anthropic.InternalServerError);
  assert.equal(h.calls(), 1, "un 5xx genérico nunca se reintenta: el proveedor pudo haber procesado la petición");
  assert.deepEqual(h.ops().map(o => o.status), ["RECONCILIATION_REQUIRED"]);
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), "requires_reconciliation");
  h.advance(60_000);
  await assert.rejects(h.post(ok), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "requires_reconciliation");
  assert.equal(h.calls(), 1);
  assert.match(classifyScriptError(e500(), "d3"), /no está disponible en este momento/);
});

test("rechazos inciertos de billing nunca se reintentan aunque el cupo lo permita (regla COST-A2b conservada)", async () => {
  const h = harness({ retries: 3 });
  await assert.rejects(h.post(async () => { throw new Anthropic.APIConnectionError({ message: "socket hang up" }); }));
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.ops().map(o => o.status), ["RECONCILIATION_REQUIRED"]);
});

test("logs: el registro del error nunca incluye la credencial ni el cuerpo; solo código, estado y tipo", () => {
  const key = "sk-ant-api03-SECRETO-DE-PRUEBA-0000";
  for (const err of [e401(), e403(), e429(), e529(), e500()]) {
    (err as { message: string }).message = `${err.message} ${key}`;
    const out = captureLog(() => logScriptError("POST /script", err, "diag-1"));
    assert.ok(!out.includes(key), `clave filtrada en el log de ${err.status}`);
    assert.ok(!out.includes("SECRETO"), "ni el mensaje del proveedor");
    assert.match(out, new RegExp(`\\[script\\] \\[diag-1\\] POST /script: anthropic_[a-z_]+ \\{"status":${err.status},"type":`));
    assert.ok(!classifyScriptError(err, "diag-1").includes(key), "ni en el mensaje al usuario");
  }
});
