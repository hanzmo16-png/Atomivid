import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaidOperation } from "@/lib/production-intelligence/ledger";
import { submitWithSupply } from "./server";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";

for (const reason of ["reel budget exceeded", "reel budget: cost unverified", "reel budget: project id noncanonical"]) {
  test(`${reason}: terminal customer explanation, no provider or balance refresh`, async () => {
    let refreshes = 0;
    const service = { rpc: async () => ({ data: { submitted: false, reason, capUsd: 1.5 }, error: null }) } as unknown as SupabaseClient;
    const op = { idempotencyKey: "one", provider: "elevenlabs", reservedUsd: .2 } as PaidOperation;
    await assert.rejects(submitWithSupply(service, op, { refresh: async () => { refreshes++; return true; } }),
      (error: unknown) => {
        const e = error as Error & { customerMessage?: string };
        assert.equal(e.name, "ReelBudgetExceededError");
        assert.match(e.customerMessage ?? "", /No se hizo ninguna llamada nueva/);
        assert.doesNotMatch(e.customerMessage ?? "", /reintenta|intenta de nuevo/i);
        return true;
      });
    assert.equal(refreshes, 0);
  });
}

test("the real paid gate never reaches a provider when the total budget refuses admission", async () => {
  const memory = memoryLedgerStore();
  const service = { rpc: async () => ({ data: { submitted: false, reason: "reel budget exceeded", capUsd: 1.5 }, error: null }) } as unknown as SupabaseClient;
  const store = { ...memory, submit: (op: PaidOperation) => submitWithSupply(service, op) };
  let calls = 0;
  const spec = { projectId: "reel", shotId: "voice", provider: "elevenlabs", model: "test", method: "tts", inputFingerprint: "same", reservedUsd: .2 };
  const hooks = { call: async () => { calls++; return { result: "audio", costUsd: .2, resultRef: "audio" }; }, load: async () => null };
  await assert.rejects(guardPaidCall(store, spec, hooks), { name: "ReelBudgetExceededError" });
  assert.equal(calls, 0);
});

test("a stored paid result can still be reused after the budget is exhausted", async () => {
  const memory = memoryLedgerStore();
  let admissions = 0, calls = 0;
  const store = { ...memory, submit: async (op: PaidOperation) => {
    admissions++;
    if (admissions > 1) throw new Error("budget exhausted");
    return memory.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED" });
  } };
  const spec = { projectId: "reel", shotId: "voice", provider: "elevenlabs", model: "test", method: "tts", inputFingerprint: "same", reservedUsd: .2 };
  const hooks = { call: async () => { calls++; return { result: "audio", costUsd: .2, resultRef: "audio" }; }, load: async () => "audio" };
  assert.equal((await guardPaidCall(store,spec,hooks)).reused,false);
  assert.equal((await guardPaidCall(store,spec,hooks)).reused,true);
  assert.equal(admissions,1); assert.equal(calls,1);
});
