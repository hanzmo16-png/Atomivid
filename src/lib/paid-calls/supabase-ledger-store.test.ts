/** The pi_paid_operations adapter: CAS semantics on a fake PostgREST (no network). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { supabaseLedgerStore } from "./supabase-ledger-store";
import { PaidLedgerUnavailableError } from "./errors";
import { reconcileWithProviderEvidence } from "@/lib/production-intelligence/ledger";

type Row = Record<string, unknown>;
function fakeSupabase(opts: { failInsert?: { code: string; message: string } } = {}) {
  const rows = new Map<string, Row>();
  const from = (table: string) => {
    assert.equal(table, "pi_paid_operations");
    const filters: Array<[string, unknown]> = [];
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
    const chain: Record<string, unknown> = {
      select() { return chain; },
      eq(k: string, v: unknown) { filters.push([k, v]); return chain; },
      async maybeSingle() { const r = [...rows.values()].find(matches); return { data: r ?? null, error: null }; },
      async insert(row: Row) {
        if (opts.failInsert) return { error: opts.failInsert };
        if (rows.has(row.idempotency_key as string)) return { error: { code: "23505", message: "duplicate key" } };
        rows.set(row.idempotency_key as string, { ...row });
        return { error: null };
      },
      update(patch: Row) {
        const upd = {
          eq(k: string, v: unknown) { filters.push([k, v]); return upd; },
          select: async () => {
            const hit = [...rows.values()].filter(matches);
            for (const r of hit) Object.assign(r, patch);
            return { data: hit.map((r) => ({ idempotency_key: r.idempotency_key })), error: null };
          },
        };
        return upd;
      },
    };
    return chain;
  };
  return { client: { from } as never, rows };
}

const op = { idempotencyKey: "op_1", projectId: "p", shotId: "s", provider: "x", model: "m", method: "me", attemptKind: "initial", reservedUsd: 0.5, committedUsd: null, status: "RESERVED" as const, providerJobId: null, resultRef: null, updatedAt: "2026-10-02T00:00:00Z" };

test("insert is first-writer-wins; update is a compare-and-set on status", async () => {
  const { client, rows } = fakeSupabase();
  const store = supabaseLedgerStore(client);
  assert.equal(await store.insert(op), true);
  assert.equal(await store.insert(op), false);
  assert.equal(await store.update("op_1", "RESERVED", { status: "SUBMITTED" }), true);
  assert.equal(await store.update("op_1", "RESERVED", { status: "SUBMITTED" }), false, "stale expectation changes nothing");
  assert.equal((await store.get("op_1"))!.status, "SUBMITTED");
  assert.equal(rows.get("op_1")!.status, "SUBMITTED");
  assert.equal(await store.get("nope"), null);
});

test("a missing table (0023 not applied) fails closed instead of returning 'absent'", async () => {
  const { client } = fakeSupabase({ failInsert: { code: "42P01", message: 'relation "pi_paid_operations" does not exist' } });
  const store = supabaseLedgerStore(client);
  await assert.rejects(store.insert(op), PaidLedgerUnavailableError);
});

test("not_charged reconciliation writes supply_reconciled=true to pi_paid_operations (T-20261025-0112-chatgpt-02)", async () => {
  const { client, rows } = fakeSupabase();
  const store = supabaseLedgerStore(client);
  await store.insert({ ...op, status: "RECONCILIATION_REQUIRED" });
  assert.equal(rows.get("op_1")!.supply_reconciled, undefined, "insert leaves the column to its DB default");
  const r = await reconcileWithProviderEvidence(store, "op_1", { kind: "not_charged", proof: "provider:no-job" }, () => "2026-10-25T00:00:00Z");
  assert.deepEqual({ s: rows.get("op_1")!.status, c: rows.get("op_1")!.committed_usd, sr: rows.get("op_1")!.supply_reconciled }, { s: "REFUNDED", c: 0, sr: true });
  assert.equal(r.supplyReconciled, true);
  await store.insert({ ...op, idempotencyKey: "op_2", status: "RECONCILIATION_REQUIRED" });
  await reconcileWithProviderEvidence(store, "op_2", { kind: "committed", providerJobId: "j", resultRef: "r", actualUsd: 0.4 }, () => "2026-10-25T00:00:00Z");
  assert.equal(rows.get("op_2")!.supply_reconciled, undefined, "a real charge never marks the row reconciled");
});
