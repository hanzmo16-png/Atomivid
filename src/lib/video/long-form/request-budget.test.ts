import { test } from "node:test";
import assert from "node:assert/strict";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { memoryLedgerStore, type PaidOperation } from "@/lib/production-intelligence/ledger";
import {
  authorizeRequestBudget,
  memoryAuthorizationStore,
  operationExposureUsd,
  RELEASED_REQUEST_BUDGET_REF,
  RequestBudgetExceededError,
  RequestBudgetNotAuthorizedError,
  requestSpend,
  withRequestBudget,
} from "./request-budget";
import { PILOT_COST_STAGES, type PilotStageEstimate } from "./pilot-budget-envelope";

const REQ = "req-budget";
const SCRIPT = "documentary:user-1:abc";
const stages = (over: Partial<Record<(typeof PILOT_COST_STAGES)[number], number | null>> = {}): PilotStageEstimate[] =>
  PILOT_COST_STAGES.map((stage) => ({ stage, ceilingUsd: over[stage] === undefined ? 0 : over[stage]!, retryPolicy: "reuse_paid_results" as const }));

function call(store: ReturnType<typeof withRequestBudget>, shotId: string, usd: number, calls: string[], opts: { fail?: "uncertain" } = {}) {
  return guardPaidCall(store, { projectId: REQ, shotId, provider: "elevenlabs", model: "m", method: "tts", inputFingerprint: { shotId }, reservedUsd: usd }, {
    call: async () => {
      calls.push(shotId);
      if (opts.fail === "uncertain") throw new Error("socket hang up");
      return { result: shotId, costUsd: usd, resultRef: `ref:${shotId}` };
    },
    load: async (ref) => ref.slice(4),
  });
}
const op = (o: Partial<PaidOperation>): PaidOperation => ({ idempotencyKey: Math.random().toString(36), projectId: REQ, shotId: "s", provider: "p", model: "m", method: "x", attemptKind: "initial", reservedUsd: 1, committedUsd: null, status: "COMMITTED", providerJobId: null, resultRef: null, updatedAt: "t", ...o });

test("A2-1 límite exacto: llegar justo al techo se permite; 0.0001 USD más se rechaza sin llamar al proveedor", async () => {
  const inner = memoryLedgerStore();
  const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ] });
  const calls: string[] = [];
  await call(store, "a", 0.6, calls);
  await call(store, "b", 0.4, calls); // = 1.0000 exacto
  await assert.rejects(call(store, "c", 0.0001, calls), RequestBudgetExceededError);
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(requestSpend([...inner.ops.values()]).totalUsd, 1);
  assert.equal([...inner.ops.values()].find((o) => o.shotId === "c"), undefined, "rechazo previo: no se escribe ninguna reserva");
});

test("A2-2 exceso: cuenta el gasto previo del guion (otro proyecto del ledger) y las reservas pendientes", async () => {
  const inner = memoryLedgerStore();
  await inner.insert(op({ projectId: SCRIPT, committedUsd: 0.7, status: "COMMITTED" }));
  await inner.insert(op({ projectId: REQ, reservedUsd: 0.2, status: "SUBMITTED" })); // interrumpido: cuenta lo reservado
  const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ, SCRIPT] });
  const calls: string[] = [];
  await assert.rejects(call(store, "voice-1", 0.2, calls), (e: Error) => e instanceof RequestBudgetExceededError && /0\.9000/.test(e.message));
  assert.deepEqual(calls, []);
  await call(store, "voice-small", 0.1, calls); // 0.7 + 0.2 + 0.1 = 1.0
  assert.deepEqual(calls, ["voice-small"]);
});

test("A2-3 concurrencia: dos reservas que juntas exceden nunca se pagan ambas", async () => {
  for (let round = 0; round < 20; round++) {
    const inner = memoryLedgerStore();
    const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ] });
    const calls: string[] = [];
    const results = await Promise.allSettled([call(store, "x", 0.6, calls), call(store, "y", 0.6, calls), call(store, "z", 0.6, calls)]);
    assert.ok(calls.length <= 1, `ronda ${round}: ${calls.join(",")}`);
    assert.ok(requestSpend([...inner.ops.values()]).totalUsd <= 1);
    for (const o of inner.ops.values()) if (o.status === "REFUNDED") assert.equal(o.resultRef, RELEASED_REQUEST_BUDGET_REF, "solo se liberan reservas propias nunca enviadas");
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof RequestBudgetExceededError));
  }
});

test("A2-4 interrupción: una llamada de resultado incierto queda contando su reserva; el reintento no se paga dos veces", async () => {
  const inner = memoryLedgerStore();
  const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ] });
  const calls: string[] = [];
  await assert.rejects(call(store, "u", 0.5, calls, { fail: "uncertain" }));
  assert.equal([...inner.ops.values()][0].status, "RECONCILIATION_REQUIRED");
  assert.equal(requestSpend([...inner.ops.values()]).totalUsd, 0.5, "lo ambiguo no se libera como «sin cargo»");
  await assert.rejects(call(store, "u", 0.5, calls)); // misma operación: bloqueada para reconciliar, no se reenvía
  await assert.rejects(call(store, "v", 0.6, calls), RequestBudgetExceededError);
  assert.deepEqual(calls, ["u"]);
});

test("A2-5 recuperación: lo COMMITTED se reutiliza sin contar dos veces ni llamar al proveedor", async () => {
  const inner = memoryLedgerStore();
  const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ] });
  const calls: string[] = [];
  await call(store, "a", 0.9, calls);
  const again = await call(store, "a", 0.9, calls);
  assert.equal(again.reused, true);
  assert.deepEqual(calls, ["a"]);
  assert.equal(requestSpend([...inner.ops.values()]).totalUsd, 0.9);
});

test("A2-6 exposición: solo «released» / rechazo final cuentan 0; reembolsos de facturación incierta cuentan lo reservado", () => {
  assert.equal(operationExposureUsd(op({ status: "REFUNDED", reservedUsd: 0.3, committedUsd: 0, resultRef: RELEASED_REQUEST_BUDGET_REF })), 0);
  assert.equal(operationExposureUsd(op({ status: "REFUNDED", reservedUsd: 0.3, committedUsd: 0, resultRef: "rejected:rejected_final:moderation" })), 0);
  assert.equal(operationExposureUsd(op({ status: "REFUNDED", reservedUsd: 0.3, committedUsd: 0, resultRef: "rejected:rejected:HTTP 500" })), 0.3);
  assert.equal(operationExposureUsd(op({ status: "REFUNDED", reservedUsd: 0.3, committedUsd: 0, resultRef: null })), 0.3);
  assert.equal(operationExposureUsd(op({ status: "REFUNDED", reservedUsd: 0.3, committedUsd: 0, resultRef: "reconciled:not_charged:invoice-123" })), 0, "solo con prueba del proveedor");
  assert.equal(operationExposureUsd(op({ status: "PROVIDER_JOB_RECORDED", reservedUsd: 0.3 })), 0.3);
  assert.equal(operationExposureUsd(op({ status: "COMMITTED", reservedUsd: 0.3, committedUsd: 0.25 })), 0.25);
});

test("A2-7 autorización: precio no verificado bloquea; un reintento NUNCA amplía el techo guardado", async () => {
  const store = memoryAuthorizationStore();
  await assert.rejects(authorizeRequestBudget({ requestId: REQ, stages: stages({ music: null }), hardMaxUsd: 50, ledgerScopes: [REQ], store }), RequestBudgetNotAuthorizedError);
  assert.equal(store.rows.size, 0);
  const first = await authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 1, images: 1 }), contingencyPct: 20, hardMaxUsd: 12, ledgerScopes: [REQ], store });
  assert.equal(first.ceilingUsd, 2.4);
  const retry = await authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 5, images: 5 }), contingencyPct: 20, hardMaxUsd: 100, ledgerScopes: [REQ], store });
  assert.equal(retry.ceilingUsd, 2.4, "el reintento no amplía");
  assert.equal(store.rows.get(REQ)!.ceilingUsd, 2.4, "la autorización guardada no se sobrescribe");
  // Etapas que no caben en el techo de producto: se rechaza antes de pagar (antes se recortaba a 12 en silencio).
  await assert.rejects(authorizeRequestBudget({ requestId: "r2", stages: stages({ voice: 30 }), hardMaxUsd: 12, ledgerScopes: ["r2"], store }), RequestBudgetNotAuthorizedError);
  const capped = await authorizeRequestBudget({ requestId: "r3", stages: stages({ voice: 11 }), hardMaxUsd: 12, ledgerScopes: ["r3"], store });
  assert.equal(capped.ceilingUsd, 12, "nunca por encima del techo de producto (solo se recorta la contingencia)");
});

test("A2-8 fail-closed: un ledger que no permite sumar el gasto del pedido no paga; operaciones de otro pedido se rechazan", async () => {
  const inner = memoryLedgerStore();
  const { listByProjects: _omit, ...noList } = inner;
  void _omit;
  assert.throws(() => withRequestBudget(noList, { ceilingUsd: 1, ledgerScopes: [REQ] }));
  const store = withRequestBudget(inner, { ceilingUsd: 1, ledgerScopes: [REQ] });
  await assert.rejects(guardPaidCall(store, { projectId: "otro", shotId: "s", provider: "p", model: "m", method: "x", inputFingerprint: {}, reservedUsd: 0.1 }, { call: async () => ({ result: 1, costUsd: 0.1, resultRef: "r" }), load: async () => 1 }), /fuera del pedido/);
});

test("A2-9 reintento con autorización previa: un hardMax reducido siempre se aplica (precio desconocido o envelope válido); una subida del entorno no amplía", async () => {
  const store = memoryAuthorizationStore();
  const first = await authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 1, images: 1 }), contingencyPct: 20, hardMaxUsd: 12, ledgerScopes: [REQ], store });
  assert.equal(first.ceilingUsd, 2.4);
  const unknownPrice = await authorizeRequestBudget({ requestId: REQ, stages: stages({ music: null }), hardMaxUsd: 1, ledgerScopes: [REQ], store });
  assert.equal(unknownPrice.ceilingUsd, 1, "precio desconocido + hardMax reducido → el hardMax manda");
  const validEnvelope = await authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 1, images: 1 }), contingencyPct: 20, hardMaxUsd: 1.5, ledgerScopes: [REQ], store });
  assert.equal(validEnvelope.ceilingUsd, 1.5, "envelope válido + hardMax reducido → el hardMax manda");
  const raised = await authorizeRequestBudget({ requestId: REQ, stages: stages({ music: null }), hardMaxUsd: 100, ledgerScopes: [REQ], store });
  assert.equal(raised.ceilingUsd, 2.4, "subir el techo del entorno no amplía la autorización guardada");
  assert.equal(store.rows.get(REQ)!.ceilingUsd, 2.4, "la autorización guardada no se reescribe");
});

test("A2-10 las etapas sin contingencia no caben en el techo de producto: se rechaza ANTES de pagar (no se recorta en silencio)", async () => {
  const store = memoryAuthorizationStore();
  // 12.14 de etapas frente a un techo de 12: recortar autorizaría menos de lo que el plan necesita.
  await assert.rejects(authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 6.14, images: 6 }), contingencyPct: 20, hardMaxUsd: 12, ledgerScopes: [REQ], store }),
    (e: unknown) => e instanceof RequestBudgetNotAuthorizedError && /subtotal_exceeds_ceiling:12\.14>12\.00/.test(e.message));
  assert.equal(store.rows.size, 0, "nothing authorized");
  // Etapas 11 (caben); solo la contingencia se recorta: 13.2 → 12.
  const ok = await authorizeRequestBudget({ requestId: REQ, stages: stages({ voice: 5, images: 6 }), contingencyPct: 20, hardMaxUsd: 12, ledgerScopes: [REQ], store });
  assert.equal(ok.ceilingUsd, 12);
});
