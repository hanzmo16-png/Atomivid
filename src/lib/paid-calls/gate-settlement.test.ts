/**
 * CORRECCIÓN-2 (T32): the settlement of a rejected attempt (SUBMITTED → REFUNDED) is a compare-and-set. Codex showed
 * (audit 1hPfi9fjIQbWvaFzcyVWot_C7fEabwkXs) that C1 ignored its boolean: one injected `false` and the chain slept,
 * called the provider again and left SUBMITTED + COMMITTED for the same logical attempt. Now a lost settlement (false
 * or a write error) means: no further provider call, release of the retry reservation this chain owns (own cause),
 * re-read of both rows (never rewritten) and a typed conservative block. In-memory ledger with fault injection; no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryLedgerStore, type LedgerStore, type PaidOperation, type PaidOpStatus } from "@/lib/production-intelligence/ledger";
import { guardPaidCall, paidCallKey, PaidCallSettlementLostError, RELEASED_SETTLEMENT_LOST_REF, type PaidCallSpec } from "./gate";
import { ProviderRejectedError } from "./errors";

const NOW = () => "2026-10-18T00:00:00.000Z";
const spec: PaidCallSpec = { projectId: "req-c2", shotId: "script:gen-0:abc", provider: "anthropic", model: "m", method: "generate_script", inputFingerprint: { t: 1 }, reservedUsd: 0.05 };
const K0 = paidCallKey(spec, 0), K1 = paidCallKey(spec, 1);
const isSettlement = (k: string, e: PaidOpStatus, p: Partial<PaidOperation>) => k === K0 && e === "SUBMITTED" && p.status === "REFUNDED";
const isRelease = (k: string, e: PaidOpStatus, p: Partial<PaidOperation>) => k === K1 && e === "RESERVED" && p.status === "REFUNDED";

type Fault = { when: (k: string, e: PaidOpStatus, p: Partial<PaidOperation>) => boolean; do: "false" | "throw" | "race-then-cas"; mutate?: (ops: Map<string, PaidOperation>) => void };
/** The in-memory ledger with one-shot faults on `update` (each fault fires once, then the store behaves normally). */
function faultyStore(faults: Fault[]) {
  const base = memoryLedgerStore();
  const transitions: string[] = [];
  const store: LedgerStore & { ops: Map<string, PaidOperation>; transitions: string[] } = {
    ops: base.ops, transitions,
    get: (k) => base.get(k), insert: (op) => base.insert(op),
    async update(key, expected, patch) {
      transitions.push(`${key === K0 ? "k0" : key === K1 ? "k1" : "other"}:${expected}->${patch.status}`);
      const f = faults.find((x) => x.when(key, expected, patch));
      if (f) {
        faults.splice(faults.indexOf(f), 1);
        if (f.do === "throw") throw new Error("ledger write failed (injected)");
        if (f.do === "false") return false;
        f.mutate?.(base.ops); // another execution changed the row first; the real CAS then loses honestly
      }
      return base.update(key, expected, patch);
    },
  };
  return store;
}
const chain = (calls: { n: number }) => ({ maxRejectedRetries: 2, call: async () => { calls.n++; throw new ProviderRejectedError(`HTTP 429 on submit #${calls.n}`); }, load: async () => null, now: NOW, retryDelayMs: () => 0 });
const committed = (s: { ops: Map<string, PaidOperation> }) => [...s.ops.values()].filter((o) => o.status === "COMMITTED").length;

test("ROJO/VERDE 1 — update(SUBMITTED→REFUNDED) devuelve false: una sola llamada, ningún reintento, ninguna fila COMMITTED; la reserva del reintento se libera con causa propia y la fila previa no se reescribe", async () => {
  const calls = { n: 0 };
  const store = faultyStore([{ when: isSettlement, do: "false" }]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "in_flight" && e.key === K0 && e.nextKey === K1
    && e.rows.previous === "SUBMITTED" && e.rows.retry === "REFUNDED" && e.rows.retryReleased === true && e.cause === undefined);
  assert.equal(calls.n, 1, "no second provider call after a lost settlement");
  assert.equal(store.ops.get(K0)!.status, "SUBMITTED", "the previous row is re-read, never overwritten");
  const retry = store.ops.get(K1)!;
  assert.deepEqual([retry.status, retry.resultRef, retry.committedUsd], ["REFUNDED", RELEASED_SETTLEMENT_LOST_REF, 0]);
  assert.equal(committed(store), 0);
  assert.deepEqual(store.transitions, ["k0:RESERVED->SUBMITTED", "k0:SUBMITTED->REFUNDED", "k1:RESERVED->REFUNDED"], "settlement attempted once; then only the release");
});

test("ROJO/VERDE 2 — el mismo CAS lanza error de almacenamiento: una sola llamada y propagación segura (error tipado con la causa), reserva liberada", async () => {
  const calls = { n: 0 };
  const store = faultyStore([{ when: isSettlement, do: "throw" }]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "in_flight" && e.cause instanceof Error && /injected/.test(e.cause.message) && /write failed/.test(e.message));
  assert.equal(calls.n, 1);
  assert.equal(store.ops.get(K0)!.status, "SUBMITTED");
  assert.equal(store.ops.get(K1)!.resultRef, RELEASED_SETTLEMENT_LOST_REF);
  assert.equal(committed(store), 0);
});

test("ROJO/VERDE 3 — la liberación RESERVED→REFUNDED del reintento devuelve false (otra ejecución tomó esa fila): relectura del estado real, cero llamadas adicionales, nada reescrito", async () => {
  const calls = { n: 0 };
  const store = faultyStore([
    { when: isSettlement, do: "false" },
    { when: isRelease, do: "race-then-cas", mutate: (ops) => { ops.get(K1)!.status = "SUBMITTED"; } },
  ]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "in_flight" && e.rows.previous === "SUBMITTED" && e.rows.retry === "SUBMITTED" && e.rows.retryReleased === false);
  assert.equal(calls.n, 1);
  assert.equal(store.ops.get(K1)!.status, "SUBMITTED", "the retry row owned by the other execution is preserved");
  assert.equal(store.ops.get(K1)!.resultRef, null);
  assert.equal(committed(store), 0);
});

test("ROJO/VERDE 4 — la liberación lanza error: cero llamadas adicionales; el error lleva la evidencia durable (filas releídas, liberación fallida) y la reserva queda tal cual", async () => {
  const calls = { n: 0 };
  const store = faultyStore([{ when: isSettlement, do: "false" }, { when: isRelease, do: "throw" }]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "in_flight" && e.rows.retryReleased === "write_failed" && e.rows.retry === "RESERVED" && /released=write_failed/.test(e.message));
  assert.equal(calls.n, 1);
  assert.equal(store.ops.get(K1)!.status, "RESERVED");
  assert.equal(committed(store), 0);
});

test("ROJO/VERDE 5 — carrera: otra ejecución pasó la fila previa a RECONCILIATION_REQUIRED antes de la liquidación: el CAS pierde de verdad, la fila no se sobrescribe y el bloqueo es requires_reconciliation", async () => {
  const calls = { n: 0 };
  const store = faultyStore([{ when: isSettlement, do: "race-then-cas", mutate: (ops) => { ops.get(K0)!.status = "RECONCILIATION_REQUIRED"; } }]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "requires_reconciliation" && e.rows.previous === "RECONCILIATION_REQUIRED" && e.rows.retry === "REFUNDED");
  assert.equal(calls.n, 1);
  assert.equal(store.ops.get(K0)!.status, "RECONCILIATION_REQUIRED", "a row whose state changed concurrently is never refunded over");
  assert.equal(store.ops.get(K1)!.resultRef, RELEASED_SETTLEMENT_LOST_REF);
  assert.equal(committed(store), 0);
});

test("ROJO/VERDE 6 — la reserva del reintento no es nuestra (insert false) y además se pierde la liquidación: no se toca la fila ajena, cero llamadas adicionales", async () => {
  const calls = { n: 0 };
  const store = faultyStore([{ when: isSettlement, do: "false" }]);
  await store.insert({ idempotencyKey: K1, projectId: spec.projectId, shotId: spec.shotId, provider: spec.provider, model: spec.model, method: spec.method, attemptKind: "rejected_retry", reservedUsd: 0.05, status: "SUBMITTED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: NOW() });
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), (e: unknown) =>
    e instanceof PaidCallSettlementLostError && e.block === "in_flight" && e.rows.retryReleased === "not_owned" && e.rows.retry === "SUBMITTED");
  assert.equal(calls.n, 1);
  assert.equal(store.ops.get(K1)!.status, "SUBMITTED");
  assert.ok(!store.transitions.includes("k1:RESERVED->REFUNDED"), "no release attempted on a row this chain does not own");
});

test("verde conservado — sin fallos inyectados la cadena sigue igual: 3 rechazos → 3 filas REFUNDED y el último rechazo; rechazo + éxito → una sola COMMITTED", async () => {
  const calls = { n: 0 };
  const store = faultyStore([]);
  await assert.rejects(guardPaidCall(store, spec, chain(calls)), /HTTP 429 on submit #3/);
  assert.equal(calls.n, 3);
  assert.deepEqual([K0, K1, paidCallKey(spec, 2)].map((k) => store.ops.get(k)!.status), ["REFUNDED", "REFUNDED", "REFUNDED"]);
  const ok = faultyStore([]);
  let n = 0;
  const r = await guardPaidCall(ok, spec, { maxRejectedRetries: 2, retryDelayMs: () => 0, now: NOW, load: async () => null, call: async () => { n++; if (n === 1) throw new ProviderRejectedError("HTTP 529"); return { result: "guion", costUsd: 0.01, resultRef: "ref" }; } });
  assert.deepEqual([r.result, r.attemptOrdinal, n, committed(ok)], ["guion", 1, 2, 1]);
});
