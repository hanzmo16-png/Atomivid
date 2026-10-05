/**
 * PI V2 Fase B2 — RB-02 atomic capacity hold. Mocks only. Mandatory cases (user-specified):
 *  - balance 3 units, 10 parallel reservations → exactly 3 acquire, 7 rejected;
 *  - the 7 never run the provider mock;
 *  - a balance read that throws → all 10 rejected, mock count 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { acquireCapacityHolds, holdKey, memoryCapacityHoldStore, parseHoldSeq, releaseOpenHoldsForRequest, settleCapacityHolds, supabaseCapacityHoldStore, unitsFromRef } from "./capacity-hold";
import { fakeBalancePort, snapshotBalancePort } from "./capacity-port";
import { PaidLedgerUnavailableError } from "./errors";

const SNAPSHOT_AT = "2026-10-02T10:00:00.000Z";
const later = (() => { let t = Date.parse(SNAPSHOT_AT) + 1000; return () => new Date((t += 1000)).toISOString(); })();

async function tenJobs(deps: Parameters<typeof acquireCapacityHolds>[0], mock: { calls: number }) {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      acquireCapacityHolds(deps, { requestId: `req-${i}`, demands: [{ provider: "elevenlabs", units: 1, usd: 0.0001 }] }).then(async (r) => {
        if (r.acquired) mock.calls++; // the provider mock runs only behind an acquired hold
        return r;
      }),
    ),
  );
  return results;
}

test("B2-1: balance 3, 10 parallel reservations → exactly 3 acquire, 7 rejected, the 7 never run the provider mock", async () => {
  const store = memoryCapacityHoldStore();
  const mock = { calls: 0 };
  const results = await tenJobs({ store, balance: fakeBalancePort({ elevenlabs: { available: 3, checkedAt: SNAPSHOT_AT } }), now: later }, mock);
  const acquired = results.filter((r) => r.acquired);
  const rejected = results.filter((r) => !r.acquired);
  assert.equal(acquired.length, 3);
  assert.equal(rejected.length, 7);
  assert.equal(mock.calls, 3);
  assert.equal([...store.rows.values()].filter((h) => h.status === "RESERVED").length, 3);
  // The sequence is dense and unique: the PK serialised the inserts.
  assert.deepEqual([...store.rows.keys()].sort(), [holdKey("elevenlabs", 1), holdKey("elevenlabs", 2), holdKey("elevenlabs", 3)]);
  for (const r of rejected) if (!r.acquired) assert.match(r.reason, /demand 1 character > available 3 − held 3/);
});

test("B2-2: a balance read that throws → all 10 rejected, mock stays at 0, no hold written", async () => {
  const store = memoryCapacityHoldStore();
  const mock = { calls: 0 };
  const results = await tenJobs({ store, balance: { async read() { throw new Error("provider API 500"); } }, now: later }, mock);
  assert.equal(results.filter((r) => r.acquired).length, 0);
  assert.equal(mock.calls, 0);
  assert.equal(store.rows.size, 0);
});

test("B2-3: UNKNOWN balance → zero jobs; a hold-ledger write failure → zero jobs", async () => {
  const mock = { calls: 0 };
  const unknown = await tenJobs({ store: memoryCapacityHoldStore(), balance: fakeBalancePort({}), now: later }, mock);
  assert.equal(unknown.filter((r) => r.acquired).length, 0);
  const broken = { ...memoryCapacityHoldStore(), insertHold: async () => { throw new PaidLedgerUnavailableError("relation does not exist"); } };
  const failed = await tenJobs({ store: broken, balance: fakeBalancePort({ elevenlabs: { available: 3 } }), now: later }, mock);
  assert.equal(failed.filter((r) => r.acquired).length, 0);
  assert.equal(mock.calls, 0);
});

test("B2-4: settled holds — COMMITTED after the snapshot still counts, REFUNDED frees, a newer snapshot frees COMMITTED", async () => {
  const store = memoryCapacityHoldStore();
  const deps = { store, balance: fakeBalancePort({ elevenlabs: { available: 3, checkedAt: SNAPSHOT_AT } }), now: later };
  const a = await acquireCapacityHolds(deps, { requestId: "r1", demands: [{ provider: "elevenlabs", units: 2, usd: 0 }] });
  assert.ok(a.acquired);
  await settleCapacityHolds(store, a.holds, "COMMITTED");
  // 2 committed after the snapshot → only 1 unit left.
  const b = await acquireCapacityHolds(deps, { requestId: "r2", demands: [{ provider: "elevenlabs", units: 2, usd: 0 }] });
  assert.equal(b.acquired, false);
  // A refund frees the units.
  const c = await acquireCapacityHolds(deps, { requestId: "r3", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] });
  assert.ok(c.acquired);
  await settleCapacityHolds(store, c.holds, "REFUNDED");
  const d = await acquireCapacityHolds(deps, { requestId: "r4", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] });
  assert.ok(d.acquired);
  // A newer snapshot (balance already net of the committed units) no longer double-counts them.
  const fresh = { ...deps, balance: fakeBalancePort({ elevenlabs: { available: 1, checkedAt: later() } }) };
  await settleCapacityHolds(store, d.holds, "COMMITTED");
  const e = await acquireCapacityHolds(fresh, { requestId: "r5", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] });
  assert.ok(e.acquired);
});

test("B2-5: a new attempt of the same request releases its fenced-out predecessor's hold; all-or-nothing across providers", async () => {
  const store = memoryCapacityHoldStore();
  const deps = { store, balance: fakeBalancePort({ elevenlabs: { available: 1, checkedAt: SNAPSHOT_AT }, openai: { available: 0, checkedAt: SNAPSHOT_AT } }), now: later };
  const first = await acquireCapacityHolds(deps, { requestId: "req-A", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] });
  assert.ok(first.acquired);
  // Attempt 2 (process died without settling): the stale hold blocks until released.
  assert.equal((await acquireCapacityHolds(deps, { requestId: "req-A", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }] })).acquired, false);
  assert.equal(await releaseOpenHoldsForRequest(store, "req-A", { noProviderSubmission: true }), 1);
  // Two demands, the second unavailable: the first hold is rolled back (REFUNDED), nothing stays held.
  const both = await acquireCapacityHolds(deps, { requestId: "req-B", demands: [{ provider: "elevenlabs", units: 1, usd: 0 }, { provider: "openai", units: 1, usd: 0 }] });
  assert.equal(both.acquired, false);
  assert.equal([...store.rows.values()].filter((h) => h.status === "RESERVED").length, 0);
});

test("B2-6: pi_paid_operations rows — key/units encoding and the Supabase store's CAS settle on a fake PostgREST", async () => {
  assert.equal(parseHoldSeq(holdKey("elevenlabs", 42)), 42);
  assert.equal(parseHoldSeq("op_abc"), null);
  assert.equal(unitsFromRef("units:1200"), 1200);
  const rows = new Map<string, Record<string, unknown>>();
  type R = Record<string, unknown>;
  const from = (table: string) => {
    assert.equal(table, "pi_paid_operations");
    const filters: Array<[string, unknown]> = [];
    const matches = (r: R) => filters.every(([k, v]) => r[k] === v);
    const listChain = {
      eq(k: string, v: unknown) { filters.push([k, v]); return listChain; },
      then(resolve: (v: { data: R[]; error: null }) => void) { resolve({ data: [...rows.values()].filter(matches), error: null }); },
    };
    return {
      select: () => listChain,
      async insert(row: R) {
        if (rows.has(row.idempotency_key as string)) return { error: { code: "23505", message: "dup" } };
        rows.set(row.idempotency_key as string, { ...row });
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
  const store = supabaseCapacityHoldStore({ from } as never);
  assert.equal(await store.insertHold({ key: holdKey("elevenlabs", 1), provider: "elevenlabs", projectId: "r", units: 5, usd: 0.0005, createdAt: SNAPSHOT_AT }), true);
  assert.equal(await store.insertHold({ key: holdKey("elevenlabs", 1), provider: "elevenlabs", projectId: "r", units: 5, usd: 0.0005, createdAt: SNAPSHOT_AT }), false);
  const listed = await store.listHolds("elevenlabs");
  assert.deepEqual(listed.map((h) => [h.seq, h.units, h.status]), [[1, 5, "RESERVED"]]);
  assert.equal(rows.get(holdKey("elevenlabs", 1))!.method, "capacity_hold");
  assert.equal(await store.settleHold(holdKey("elevenlabs", 1), "COMMITTED"), true);
  assert.equal(await store.settleHold(holdKey("elevenlabs", 1), "REFUNDED"), false, "CAS: already settled");
});

test("B2-7: snapshot port — GREEN/YELLOW fresh snapshot with a balance is known; RED/UNKNOWN/stale/none is UNKNOWN; a read error throws", async () => {
  const mk = (row: Record<string, unknown> | null, error: { code: string; message: string } | null = null) =>
    snapshotBalancePort({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }) }) }) } as never, { now: () => Date.parse(SNAPSHOT_AT) + 60_000 });
  const base = { provider: "elevenlabs", unit: "character", available: "9000", reliability: "manual_entry", checked_at: SNAPSHOT_AT };
  assert.deepEqual(await mk({ ...base, status: "GREEN" }).read("elevenlabs"), { known: true, provider: "elevenlabs", available: 9000, unit: "character", checkedAt: SNAPSHOT_AT });
  assert.equal((await mk({ ...base, status: "YELLOW" }).read("elevenlabs")).known, true);
  assert.equal((await mk({ ...base, status: "RED" }).read("elevenlabs")).known, false);
  assert.equal((await mk({ ...base, status: "UNKNOWN", available: null }).read("elevenlabs")).known, false);
  assert.equal((await mk({ ...base, status: "GREEN", reliability: "derived_from_ledger" }).read("elevenlabs")).known, false);
  assert.equal((await mk({ ...base, status: "GREEN", checked_at: "2026-09-01T00:00:00.000Z" }).read("elevenlabs")).known, false, "stale");
  assert.equal((await mk(null).read("elevenlabs")).known, false);
  await assert.rejects(mk(null, { code: "42P01", message: "missing" }).read("elevenlabs"));
});

test("B2-8: run-job.ts acquires the hold after the attempt claim and before any pipeline dispatch; a refusal never reaches the pipelines", () => {
  const src = readFileSync(path.join(__dirname, "../video/run-job.ts"), "utf8");
  const claim = src.indexOf("await claim(row.progress_stage)");
  const acquire = src.indexOf("acquireCapacityHolds(");
  const dispatch = Math.min(src.indexOf("await generateAvatarVideo("), src.indexOf("await generateLongFormVideoFromScript("), src.indexOf("await generateVideoFromScript("));
  assert.ok(claim > 0 && acquire > claim && acquire < dispatch, "claim → hold → dispatch");
  assert.match(src, /if \(!admission\.acquired\) throw new CapacityUnavailableError/);
  assert.match(src, /snapshotBalancePort\(service\)/, "balance comes through the injectable port, never a provider call");
});
