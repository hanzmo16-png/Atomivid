// USD 0. A stale RESERVED script reservation (never SUBMITTED, so the provider was never called) is released as
// REFUNDED with supplyReconciled: true — the real case 2026-10-27: a USD 0.1706 hold left by a job that stopped on the
// daily request quota. Without the flag pi_supply_spend keeps counting the whole reservation as spend after release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseStaleReservations, RELEASED_STALE_REF, SCRIPT_IN_FLIGHT_STALE_MS } from "./script-intent";

function store(initial: Record<string, string>) {
  const rows = new Map(Object.entries(initial).map(([k, status]) => [k, { status, updatedAt: "2026-10-27T18:00:49Z" } as Record<string, unknown>]));
  const patches: Record<string, unknown>[] = [];
  return { rows, patches,
    async get(key: string) { const r = rows.get(key); return r ? { status: r.status, updatedAt: r.updatedAt } as never : null; },
    async update(key: string, expected: string, patch: Record<string, unknown>) { const r = rows.get(key); if (!r || r.status !== expected) return false; rows.set(key, { ...r, ...patch }); patches.push({ key, ...patch }); return true; } };
}

test("stale RESERVED never submitted → REFUNDED, committed 0, supplyReconciled true (no longer counted as spend)", async () => {
  const s = store({ k1: "RESERVED" });
  const now = Date.parse("2026-10-27T18:00:49Z") + SCRIPT_IN_FLIGHT_STALE_MS + 1;
  const out = await releaseStaleReservations(s as never, [{ status: "RESERVED", shot_id: "script:x", updated_at: "2026-10-27T18:00:49Z", idempotency_key: "k1" } as never], now);
  assert.equal(out[0].status, "REFUNDED");
  assert.deepEqual(s.patches, [{ key: "k1", status: "REFUNDED", committedUsd: 0, supplyReconciled: true, resultRef: RELEASED_STALE_REF, updatedAt: new Date(now).toISOString() }]);
});

test("a fresh RESERVED (still within the in-flight window) or a SUBMITTED row is never released or reconciled", async () => {
  const s = store({ fresh: "RESERVED", sub: "SUBMITTED" });
  const at = "2026-10-27T18:00:49Z", now = Date.parse(at) + 1000;
  const out = await releaseStaleReservations(s as never, [
    { status: "RESERVED", shot_id: "a", updated_at: at, idempotency_key: "fresh" } as never,
    { status: "SUBMITTED", shot_id: "b", updated_at: "2026-10-27T10:00:00Z", idempotency_key: "sub" } as never], now);
  assert.deepEqual(out.map((r) => r.status), ["RESERVED", "SUBMITTED"]);
  assert.equal(s.patches.length, 0);
});

test("lost compare-and-set (submitted meanwhile) → the real status is kept, nothing reconciled", async () => {
  const s = store({ k: "SUBMITTED" });
  const now = Date.parse("2026-10-27T18:00:49Z") + SCRIPT_IN_FLIGHT_STALE_MS + 1;
  const out = await releaseStaleReservations(s as never, [{ status: "RESERVED", shot_id: "x", updated_at: "2026-10-27T18:00:49Z", idempotency_key: "k" } as never], now);
  assert.equal(out[0].status, "SUBMITTED");
  assert.equal(s.patches.length, 0);
});
