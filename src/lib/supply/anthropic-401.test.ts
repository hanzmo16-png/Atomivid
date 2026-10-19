/**
 * P0 chatgpt-32 (diagnóstico 90e3e91d, 2026-10-16): Anthropic rechazó la credencial con HTTP 401 antes de generar
 * nada y el guion del Reel quedó como cobro incierto (RECONCILIATION_REQUIRED), bloqueando toda generación posterior.
 * Un 401 del SDK es un rechazo FINAL previo a la generación: no hay tokens facturables ni resultado. Debe quedar
 * REFUNDED (committedUsd 0, trazable) y el error original debe salir intacto hacia la UI de configuración.
 * Todo en memoria y con el SDK real de Anthropic para fabricar la excepción: sin red, sin credencial, sin DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { currentSupplyScope, guardScriptLedgerCall, withScriptGenerationContext } from "./anthropic";
import { classifyAnthropicError } from "./anthropic-error";
import { scriptBlockState, ScriptReconciliationRequiredError, type ScriptOpRow } from "./script-intent";
import { classifyScriptError, scriptErrorCode } from "@/lib/video/script-error";

const REQUEST = "cd71a440-0000-4000-8000-000000000000"; // synthetic id shaped like the incident's request
const NOW = Date.now();
const PARAMS = { model: "synthetic-model", max_tokens: 2000, messages: [{ role: "user", content: "tema sintético" }] };
const sdkError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message } }, undefined, new Headers());
/** The exact shape the SDK raised in production: `{ status: 401, type: 'authentication_error' }`. */
const auth401 = () => sdkError(401, "authentication_error", "invalid x-api-key");

function harness() {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let now = NOW, calls = 0;
  const rows = async (projectId: string): Promise<ScriptOpRow[]> => [...store.ops.values()]
    .filter(o => o.projectId === projectId && o.provider === "anthropic" && o.method === "generate_script")
    .map(o => ({ status: o.status, shot_id: o.shotId, updated_at: o.updatedAt, idempotency_key: o.idempotencyKey }));
  const post = <T>(invoke: () => Promise<T>) =>
    withScriptGenerationContext(REQUEST, () => guardScriptLedgerCall<T>({ store, results, now: () => now }, currentSupplyScope()!, PARAMS, 0.0468, () => 0.01,
      () => { calls++; return invoke(); }), { guard: true, load: rows, store, now: () => now });
  return { store, rows, post, calls: () => calls, advance: (ms: number) => { now += ms; }, ops: () => [...store.ops.values()] };
}
const ok = async () => ({ title: "guion", usage: { input_tokens: 1, output_tokens: 1 } });

test("el 401 del SDK es la clase AuthenticationError y el producto ya lo nombra como fallo de configuración", () => {
  const e = auth401();
  assert.ok(e instanceof Anthropic.AuthenticationError);
  assert.equal(e.status, 401);
  assert.equal(scriptErrorCode(e), "anthropic_authentication_error");
  assert.match(classifyScriptError(e, "90e3e91d"), /revisión de configuración.*repetir ahora no resolverá/);
  assert.doesNotMatch(classifyScriptError(e, "90e3e91d"), /No reintentes: no pudimos confirmar/);
});

test("clasificación: 401 = rechazo final; 500, 400 genérico, red, timeout y errores tras recibir datos siguen inciertos", () => {
  assert.deepEqual(classifyAnthropicError(auth401()), { kind: "rejected_final" });
  assert.deepEqual(classifyAnthropicError(sdkError(401, "api_error", "x")), { kind: "rejected_final" }, "401 by status is still a pre-generation rejection; body type is not what decides");
  const uncertain = [
    sdkError(500, "api_error", "internal"),
    sdkError(400, "invalid_request_error", "Other invalid request"),
    new Anthropic.APIConnectionError({ message: "socket hang up" }),
    new Anthropic.APIConnectionTimeoutError({ message: "timeout" }),
    new Error("synthetic: response arrived but could not be parsed"),
  ];
  for (const e of uncertain) assert.deepEqual(classifyAnthropicError(e), { kind: "uncertain" }, String(e));
  // 403 (permission refused before generation) and 429/529 (admission refused) are covered by anthropic-http-policy.test.ts.
});

test("incidente 90e3e91d: 401 → fila REFUNDED (0 USD, trazable), error original hacia la UI, una sola llamada; el siguiente POST no queda bloqueado", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw auth401(); }), (e: unknown) => e instanceof Anthropic.AuthenticationError, "the SDK error reaches the route untouched");
  assert.equal(h.calls(), 1, "provider invoked once");
  const [op] = h.ops();
  assert.equal(h.ops().length, 1, "one reservation only");
  assert.equal(op.status, "REFUNDED", "a pre-generation rejection is not an uncertain charge");
  assert.equal(op.committedUsd, 0);
  assert.equal(op.reservedUsd, 0.0468, "the reservation stays recorded for the audit trail");
  assert.match(op.resultRef ?? "", /^rejected:rejected_final:/, "the refusal and its message are kept on the row");
  assert.match(op.resultRef ?? "", /401/);
  assert.equal(scriptBlockState(await h.rows(REQUEST), NOW), null, "nothing to reconcile");
  // Credential fixed (simulated): the same request generates again under a NEW intent, one more call, no replay of the refused key.
  h.advance(5_000);
  const next = await h.post(ok);
  assert.equal(next.reused, false);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => [o.shotId.split(":")[1], o.status]), [["gen-0", "REFUNDED"], ["gen-1", "COMMITTED"]]);
});

test("sin credencial arreglada el 401 se repite: cada intento es un rechazo final nuevo, nunca un reintento del SDK ni un cobro", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) { await assert.rejects(h.post(async () => { throw auth401(); })); h.advance(5_000); }
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.ops().map(o => o.status), ["REFUNDED", "REFUNDED"]);
  assert.equal(h.ops().reduce((s, o) => s + (o.committedUsd ?? 0), 0), 0);
});

test("regresión conservada: un desenlace realmente incierto sigue en RECONCILIATION_REQUIRED y bloquea el siguiente POST", async () => {
  const h = harness();
  await assert.rejects(h.post(async () => { throw new Error("synthetic: response arrived but could not be parsed"); }));
  assert.deepEqual(h.ops().map(o => o.status), ["RECONCILIATION_REQUIRED"]);
  h.advance(60_000);
  await assert.rejects(h.post(ok), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "requires_reconciliation");
  assert.equal(h.calls(), 1);
});

test("ledger preexistente RECONCILIATION_REQUIRED (como el del propietario): la reparación no lo relanza ni lo muta; un 401 posterior tampoco", async () => {
  const h = harness();
  const stale = { idempotencyKey: "op_owner", projectId: REQUEST, shotId: "script:gen-0:legacy", provider: "anthropic", model: "claude-model", method: "generate_script",
    attemptKind: "initial", reservedUsd: 0.0468, status: "RECONCILIATION_REQUIRED" as const, providerJobId: null, resultRef: null, committedUsd: null, updatedAt: new Date(NOW - 3_600_000).toISOString() };
  await h.store.insert(stale);
  await assert.rejects(h.post(async () => { throw auth401(); }), (e: unknown) => e instanceof ScriptReconciliationRequiredError && e.state === "requires_reconciliation");
  assert.equal(h.calls(), 0, "no provider call while a row awaits an operator");
  assert.deepEqual(h.ops(), [stale], "the owner's row is untouched: only an explicit operator reconciliation may change it");
});
