/**
 * Application side of the recovery budget. The cap itself is enforced in Postgres (pi_submit_with_supply, see
 * supabase/migrations/verify/documentary_recovery_budget*.{sql,sh}); here: a refusal reaches no provider, leaves
 * the operation RESERVED, stops the job with a clear message (never "waiting for supply"), and stored amounts
 * are rounded UP so the database can never under-count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { guardPaidCall, paidCallKey } from "@/lib/paid-calls/gate";
import { submitWithSupply } from "./server";
import { SupplyUnavailableError } from "./policy";
import { RecoveryBudgetExceededError, isRecoveryBudgetRefusal } from "./recovery-budget";
import { ceilLedgerUsd } from "./anthropic-cost";
import { documentaryFormError } from "@/lib/video/long-form/form-error";
import { scriptFailureKind } from "@/lib/video/long-form/script-jobs";

type Rpc = { reason: string; submitted: boolean } & Record<string, unknown>;
function fakeService(answer: () => Rpc) {
  const calls: { fn: string; args: unknown }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), { data: answer(), error: null }) } as any;
  return { service, calls };
}
const EXCEEDED: Rpc = { submitted: false, reason: "recovery budget exceeded", capUsd: 2.1, committedUsd: 1.9, pendingUsd: 0.1, requestedUsd: 0.2696 };
const spec = (shot = "script:documentary:abc") => ({ projectId: "documentary:owner:bigfoot", shotId: shot, provider: "anthropic", model: "claude-sonnet-5",
  method: "generate_script", inputFingerprint: { shot }, reservedUsd: 0.2696 });

test("a budget refusal from the database is a terminal RecoveryBudgetExceededError, not 'wait for supply'", async () => {
  const { service } = fakeService(() => EXCEEDED);
  const op = { idempotencyKey: "k", projectId: "p", shotId: "s", provider: "anthropic", model: "m", method: "generate_script", attemptKind: "initial",
    reservedUsd: 0.2696, status: "RESERVED" as const, providerJobId: null, resultRef: null, committedUsd: null, updatedAt: "" };
  await assert.rejects(submitWithSupply(service, op), (e: unknown) => e instanceof RecoveryBudgetExceededError && !(e instanceof SupplyUnavailableError)
    && e.capUsd === 2.1 && e.requestedUsd === 0.2696);
  for (const reason of ["recovery budget exceeded", "recovery budget closed", "recovery budget: cost unverified"]) assert.ok(isRecoveryBudgetRefusal(reason));
  assert.equal(isRecoveryBudgetRefusal("provider funded spend ceiling"), false, "other supply refusals keep their existing handling");
  // Existing behaviour unchanged for the other answers.
  assert.equal(await submitWithSupply(fakeService(() => ({ submitted: false, reason: "already_claimed" })).service, op), false);
  assert.equal(await submitWithSupply(fakeService(() => ({ submitted: true, reason: "admitted" })).service, op), true);
  await assert.rejects(submitWithSupply(fakeService(() => ({ submitted: false, reason: "concurrency" })).service, op), SupplyUnavailableError);
});

test("refused before the provider: zero provider calls and the operation stays RESERVED (it does not consume the budget)", async () => {
  const store = memoryLedgerStore(), results = memoryResultStore();
  const { service } = fakeService(() => EXCEEDED);
  store.submit = (op) => submitWithSupply(service, op);
  let providerCalls = 0;
  await assert.rejects(guardPaidCall(store, spec(), {
    async call({ key }) { providerCalls++; await results.putJson(key, {}); return { result: {}, costUsd: 0.01, resultRef: key }; },
    load: (r) => results.getJson(r), maxRejectedRetries: 0,
  }), RecoveryBudgetExceededError);
  assert.equal(providerCalls, 0);
  assert.equal([...store.ops.values()][0].status, "RESERVED");
});

test("a COMMITTED result is reused without asking the budget again (no new reservation, no second charge)", async () => {
  const store = memoryLedgerStore(), results = memoryResultStore();
  let answers = 0;
  const { service } = fakeService(() => (answers++ === 0 ? { submitted: true, reason: "admitted" } : EXCEEDED));
  store.submit = async (op) => { const ok = await submitWithSupply(service, op); if (ok) await store.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED" }); return ok; };
  let providerCalls = 0;
  const hooks = { async call({ key }: { key: string }) { providerCalls++; await results.putJson(key, { ok: 1 }); return { result: { ok: 1 }, costUsd: 0.05, resultRef: key }; },
    load: (r: string) => results.getJson<{ ok: number }>(r), maxRejectedRetries: 0 };
  const first = await guardPaidCall(store, spec(), hooks);
  const again = await guardPaidCall(store, spec(), hooks); // the budget would now refuse a NEW call; the committed one is reused
  assert.deepEqual([first.reused, again.reused, again.costUsd, providerCalls, answers], [false, true, 0, 1, 1]);
});

test("stored amounts are rounded UP to the ledger's 4 decimals: the database can never under-count", () => {
  assert.equal(ceilLedgerUsd(0.2696), 0.2696);
  assert.equal(ceilLedgerUsd(0.26961), 0.2697);
  assert.equal(ceilLedgerUsd(0.03800000000000001), 0.038);
  for (let i = 0; i < 20000; i++) {
    const x = Math.random() * 3;
    const c = ceilLedgerUsd(x);
    assert.ok(c >= x - 1e-12 && c - x < 0.0001 + 1e-9 && Math.abs(c * 1e4 - Math.round(c * 1e4)) < 1e-6, String(x));
  }
  assert.throws(() => ceilLedgerUsd(Number.NaN));
  assert.throws(() => ceilLedgerUsd(-1));
});

test("the ledger key does not depend on the reservation: rounding cannot orphan the five paid responses", () => {
  assert.equal(paidCallKey({ ...spec(), reservedUsd: 0.26961234 }), paidCallKey({ ...spec(), reservedUsd: 0.2697 }));
});

test("the job stops with a clear, technical failure (Reintentar re-checks the same budget; nothing waits or auto-raises)", () => {
  const e = new RecoveryBudgetExceededError(EXCEEDED);
  assert.equal(scriptFailureKind(e), "technical");
  assert.match(documentaryFormError(e, "abcd1234"), /presupuesto autorizado para recuperar este guion \(USD 2\.10\).*No se hizo ninguna llamada nueva.*\(Código: abcd1234\)/);
  const jobs = readFileSync(path.join(__dirname, "../video/long-form/script-jobs.ts"), "utf8");
  assert.match(jobs, /if\(error instanceof SupplyUnavailableError\)/, "only supply unavailability waits");
  assert.ok(!(e instanceof SupplyUnavailableError));
  const server = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.doesNotMatch(server, /pi_submit_with_supply_core/, "the application never calls the uncapped core");
});
