/**
 * PI V2 Fase B2.1 — hold accounting. The B1 gate and the B2 hold share ONE pi_paid_operations
 * table (fake PostgREST here). The function that sums a provider's held units is
 * `acquireCapacityHolds` (capacity-hold.ts: `held = open.reduce((t, h) => t + h.units, 0)`),
 * fed by `supabaseCapacityHoldStore.listHolds`, which selects only `method = capacity_hold`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireCapacityHolds, CAPACITY_HOLD_METHOD, memoryCapacityHoldStore, settleCapacityHolds, supabaseCapacityHoldStore } from "./capacity-hold";
import { fakeBalancePort } from "./capacity-port";
import { supabaseLedgerStore } from "./supabase-ledger-store";
import { guardPaidCall } from "./gate";

const SNAPSHOT_AT = "2026-10-02T10:00:00.000Z";
const clock = (() => { let t = Date.parse(SNAPSHOT_AT); return () => new Date((t += 1000)).toISOString(); })();

/** One fake table serving both stores: select(cols).eq()…(.maybeSingle()|await), insert, update().eq()…select(). */
function fakePaidOperationsTable() {
  type R = Record<string, unknown>;
  const rows = new Map<string, R>();
  const from = (table: string) => {
    assert.equal(table, "pi_paid_operations");
    const filters: Array<[string, unknown]> = [];
    const matches = (r: R) => filters.every(([k, v]) => r[k] === v);
    const chain = {
      eq(k: string, v: unknown) { filters.push([k, v]); return chain; },
      async maybeSingle() { return { data: [...rows.values()].find(matches) ?? null, error: null }; },
      then(resolve: (v: { data: R[]; error: null }) => void) { resolve({ data: [...rows.values()].filter(matches), error: null }); },
    };
    return {
      select: () => chain,
      async insert(row: R) {
        if (rows.has(row.idempotency_key as string)) return { error: { code: "23505", message: "dup" } };
        rows.set(row.idempotency_key as string, { ...row, created_at: (row.created_at as string | undefined) ?? clock() });
        return { error: null };
      },
      update(patch: R) {
        const upd = {
          eq(k: string, v: unknown) { filters.push([k, v]); return upd; },
          select: async () => { const hit = [...rows.values()].filter(matches); for (const r of hit) Object.assign(r, patch); return { data: hit.map((r) => ({ idempotency_key: r.idempotency_key })), error: null }; },
        };
        return upd;
      },
    };
  };
  return { client: { from } as never, rows };
}

const VOICE = { provider: "elevenlabs", units: 1000, usd: 0.1 };

test("B2.1-1: balance 10000; a job holds 1000 and the gate leaves its TTS COMMITTED at 1000 → the next job sees 9000 free, not 8000 (one count per job)", async () => {
  const { client, rows } = fakePaidOperationsTable();
  const holds = supabaseCapacityHoldStore(client);
  const ledger = supabaseLedgerStore(client);
  const balance = fakeBalancePort({ elevenlabs: { available: 10000, checkedAt: SNAPSHOT_AT } });
  let providerCalls = 0;

  // Job 1: admission hold, then the B1 gate pays once and commits the TTS row in the same table.
  const admitted = await acquireCapacityHolds({ store: holds, balance, now: clock }, { requestId: "job-1", demands: [VOICE] });
  assert.ok(admitted.acquired);
  await guardPaidCall(ledger, { projectId: "job-1", shotId: "voice:x", provider: "elevenlabs", model: "m", method: "tts_with_timestamps", inputFingerprint: { text: "x" }, reservedUsd: 0.1 }, {
    call: async () => { providerCalls++; return { result: "audio", costUsd: 0.1, resultRef: "job-1/paid/k.json" }; },
    load: async () => "audio",
  });
  await settleCapacityHolds(holds, admitted.holds, "COMMITTED");
  assert.equal([...rows.values()].filter((r) => r.status === "COMMITTED").length, 2, "one hold row + one gate row, both COMMITTED");

  // Job 2 must see exactly 9000 free: 1000 held once, never 2000.
  const probe = await acquireCapacityHolds({ store: holds, balance, now: clock }, { requestId: "job-2", demands: [{ provider: "elevenlabs", units: 9000, usd: 0.9 }] });
  assert.ok(probe.acquired, "9000 fits: held is 1000, not 2000");
  const over = await acquireCapacityHolds({ store: holds, balance, now: clock }, { requestId: "job-3", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] });
  assert.equal(over.acquired, false);
  if (!over.acquired) assert.match(over.reason, /available 10000 − held 10000$/, "held = 1000 (job-1) + 9000 (job-2); the gate's COMMITTED row is not summed");
  assert.equal(providerCalls, 1);
  // Only capacity_hold rows feed the sum.
  assert.deepEqual([...rows.values()].map((r) => r.method).sort(), [CAPACITY_HOLD_METHOD, CAPACITY_HOLD_METHOD, "tts_with_timestamps"]);
});

test("B2.1-2: a RESERVED hold whose process died keeps consuming balance; no provider call is made to 'cure' it (automatic repair forbidden)", async () => {
  const store = memoryCapacityHoldStore();
  const balance = fakeBalancePort({ elevenlabs: { available: 1500, checkedAt: SNAPSHOT_AT } });
  let providerCalls = 0;
  const dead = await acquireCapacityHolds({ store, balance, now: clock }, { requestId: "job-dead", demands: [VOICE] });
  assert.ok(dead.acquired);
  // The process dies here: no settle, no release. The hold stays RESERVED.
  assert.equal([...store.rows.values()][0].status, "RESERVED");

  // Another request: only 500 free. 1000 is refused; nothing calls the provider, nothing touches the dead hold.
  const next = await acquireCapacityHolds({ store, balance, now: clock }, { requestId: "job-next", demands: [VOICE] }).then((r) => { if (r.acquired) providerCalls++; return r; });
  assert.equal(next.acquired, false);
  if (!next.acquired) assert.match(next.reason, /held 1000/);
  assert.equal(providerCalls, 0);
  assert.equal([...store.rows.values()].filter((h) => h.status === "RESERVED").length, 1, "the dead hold is still RESERVED: nobody repaired it");
  // Documented behaviour: the balance stays reduced until a later attempt of THAT request or an operator settles it.
  const later = await acquireCapacityHolds({ store, balance, now: clock }, { requestId: "job-later", demands: [{ provider: "elevenlabs", units: 500, usd: 0.05 }] });
  assert.ok(later.acquired, "only the remaining 500 are admitted");
});

test("B2.1-3: when the sequence-conflict retry budget is exhausted the job is refused; the provider mock stays at 0", async () => {
  const base = memoryCapacityHoldStore();
  let inserts = 0;
  const alwaysConflict = { ...base, insertHold: async () => { inserts++; return false; } };
  const balance = fakeBalancePort({ elevenlabs: { available: 10000, checkedAt: SNAPSHOT_AT } });
  let providerCalls = 0;
  const r = await acquireCapacityHolds({ store: alwaysConflict, balance, now: clock }, { requestId: "job-c", demands: [VOICE] }).then((r) => { if (r.acquired) providerCalls++; return r; });
  assert.equal(r.acquired, false);
  if (!r.acquired) assert.match(r.reason, /could not acquire a hold after 100 rounds/);
  assert.equal(inserts, 100, "bounded: exactly the retry budget, then refuse");
  assert.equal(providerCalls, 0);
  assert.equal(base.rows.size, 0);
});
