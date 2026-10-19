/** D-RACE (T-20261019-1602), unidad con store en memoria. La versión PG con RPC real: scripts/harness/adversarial. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executePaidOperation, flagStaleSubmission, memoryLedgerStore, reconcileWithProviderEvidence, ReconciliationRequiredError, SubmissionInFlightError } from "./ledger";

const op = { idempotencyKey: "k1", projectId: "p", shotId: "s", provider: "x", model: "m", method: "t", attemptKind: "initial", reservedUsd: 0.05 };
const T0 = "2026-10-19T20:00:00.000Z";

test("perdedor ante SUBMITTED: SubmissionInFlightError y la fila NO se modifica; el ganador liquida", async () => {
  const s = memoryLedgerStore();
  let release!: () => void; let calls = 0;
  const winner = executePaidOperation(s, op, { submit: () => new Promise((r) => { calls++; release = () => r({ providerJobId: "j1" }); }), poll: async () => ({ resultRef: "r", actualUsd: 0.04 }) }, () => T0);
  await new Promise((r) => setImmediate(r));
  const before = JSON.stringify(s.ops.get("k1"));
  const err = await executePaidOperation(s, op, { submit: async () => { calls++; return { providerJobId: "j2" }; }, poll: async () => ({ resultRef: "r2", actualUsd: 1 }) }, () => T0).catch((e) => e);
  assert.ok(err instanceof SubmissionInFlightError && err instanceof ReconciliationRequiredError);
  assert.equal(JSON.stringify(s.ops.get("k1")), before);
  release();
  const w = await winner;
  assert.equal(w.status, "COMMITTED"); assert.equal(w.committedUsd, 0.04); assert.equal(calls, 1);
});

test("flagStaleSubmission: nunca antes de la antigüedad mínima; después sólo RECONCILIATION_REQUIRED (jamás RESERVED)", async () => {
  const s = memoryLedgerStore();
  await s.insert({ ...op, status: "SUBMITTED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: T0 });
  assert.equal(await flagStaleSubmission(s, "k1", { minAgeMs: 900_000, now: () => "2026-10-19T20:10:00.000Z" }), false);
  assert.equal(s.ops.get("k1")!.status, "SUBMITTED");
  assert.equal(await flagStaleSubmission(s, "k1", { minAgeMs: 900_000, now: () => "2026-10-19T20:16:00.000Z" }), true);
  assert.equal(s.ops.get("k1")!.status, "RECONCILIATION_REQUIRED");
  let calls = 0;
  await assert.rejects(executePaidOperation(s, op, { submit: async () => { calls++; return { providerJobId: "j" }; }, poll: async () => ({ resultRef: "r", actualUsd: 1 }) }, () => T0), ReconciliationRequiredError);
  assert.equal(calls, 0);
});

test("reconcileWithProviderEvidence: not_charged exige prueba; committed liquida una vez; ninguna rama reabre la clave", async () => {
  const s = memoryLedgerStore();
  await s.insert({ ...op, status: "RECONCILIATION_REQUIRED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: T0 });
  await assert.rejects(reconcileWithProviderEvidence(s, "k1", { kind: "not_charged", proof: "  " }, () => T0));
  const r = await reconcileWithProviderEvidence(s, "k1", { kind: "committed", providerJobId: "j", resultRef: "ref", actualUsd: 0.04 }, () => T0);
  assert.equal(r.status, "COMMITTED");
  await assert.rejects(reconcileWithProviderEvidence(s, "k1", { kind: "committed", providerJobId: "j", resultRef: "ref", actualUsd: 0.04 }, () => T0));
});

test("liquidación perdida (CAS falla) no se oculta: ReconciliationRequiredError sin sobrescribir", async () => {
  const s = memoryLedgerStore();
  const orig = s.update.bind(s);
  s.update = async (k, e, p) => (p.status === "COMMITTED" ? false : orig(k, e, p));
  await assert.rejects(executePaidOperation(s, op, { submit: async () => ({ providerJobId: "j" }), poll: async () => ({ resultRef: "r", actualUsd: 0.04 }) }, () => T0), ReconciliationRequiredError);
  assert.equal(s.ops.get("k1")!.status, "PROVIDER_JOB_RECORDED");
});
