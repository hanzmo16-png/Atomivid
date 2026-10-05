import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSupply, SupplyUnavailableError } from "./policy";
import { memoryLedgerStore, type PaidOperation } from "@/lib/production-intelligence/ledger";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { submitWithSupply } from "./server";
import { authorizedSupplyCron } from "./auth";
import { acquireCapacityHolds, memoryCapacityHoldStore, releaseOpenHoldsForRequest } from "@/lib/paid-calls/capacity-hold";
import { fakeBalancePort } from "@/lib/paid-calls/capacity-port";
import { isRenderStale } from "@/lib/video/render-guard";

const now = Date.parse("2026-10-05T15:00:00Z");
const base = { provider: "voice", available: 100_000, held: 0, baseline: 100_000,
  dailyForecast: 10_000, checkedAt: new Date(now).toISOString(), now, health: "OK", reliable: true };
test("alert at 30% remaining, at 72h coverage, and urgent at 15% / 24h", () => {
  assert.equal(assessSupply(base).level, "GREEN");
  assert.equal(assessSupply({ ...base, available: 30_000 }).level, "YELLOW");
  assert.equal(assessSupply({ ...base, available: 15_000 }).level, "RED");
  assert.equal(assessSupply({ ...base, dailyForecast: 40_000 }).level, "YELLOW");
  assert.equal(assessSupply({ ...base, recentDailyPeak: 100_000 }).level, "RED");
  assert.equal(assessSupply({ ...base, pending: 100_000 }).level, "RED");
  assert.equal(assessSupply({ ...base, held: 90_000 }).level, "RED");
});
test("unknown, stale, future, negative or estimated balances cannot authorize supply", () => {
  for (const patch of [{ available: null }, { available: -1 }, { available: NaN }, { reliable: false },
    { checkedAt: new Date(now - 300_001).toISOString() }, { checkedAt: new Date(now + 1).toISOString() },
    { baseline: 0 }, { checkedAt: null }]) assert.equal(assessSupply({ ...base, ...patch }).level, "UNKNOWN");
});
test("50 simultaneous jobs cannot double-book 17,000 characters", async () => {
  const store = memoryCapacityHoldStore();
  const results = await Promise.all(Array.from({ length: 50 }, (_, n) => acquireCapacityHolds({ store, balance: fakeBalancePort({ elevenlabs: { available: 17_000 } }) }, { requestId: `r${n}`, demands: [{ provider: "elevenlabs", units: 1000, usd: .1 }] })));
  assert.equal(results.filter(r => r.acquired).length, 17);
  assert.equal([...store.rows.values()].reduce((s, r) => s + r.units, 0), 17_000);
  assert.equal(await releaseOpenHoldsForRequest(store, "r0"), 0, "restart is not proof of nonconsumption");
});
test("50 simultaneous paid submissions respect three slots; denied calls stay RESERVED and make no HTTP", async () => {
  const baseStore = memoryLedgerStore();
  let active = 0, peak = 0, calls = 0;
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const store = { ...baseStore, async submit(op: PaidOperation, at: string) {
    if (active >= 3) throw new SupplyUnavailableError(op.provider, "concurrency");
    active++; peak = Math.max(peak, active);
    return baseStore.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at });
  }, async update(key: string, expected: PaidOperation["status"], patch: Partial<PaidOperation>) {
    const ok = await baseStore.update(key, expected, patch);
    if (ok && patch.status === "COMMITTED") active--;
    return ok;
  } };
  const jobs = Array.from({ length: 50 }, (_, n) => guardPaidCall(store, { projectId: `p${n}`, shotId: "voice", provider: "voice", model: "m", method: "tts", reservedUsd: .1, inputFingerprint: n }, {
    async call() { calls++; await blocker; return { result: "audio", costUsd: .1, resultRef: "audio" }; }, load: async () => "audio",
  }));
  const settled = Promise.allSettled(jobs);
  await new Promise(resolve => setImmediate(resolve)); release();
  const results = await settled;
  assert.equal(calls, 3); assert.equal(peak, 3);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
  assert.equal([...baseStore.ops.values()].filter(r => r.status === "RESERVED").length, 47);
  assert.equal([...baseStore.ops.values()].filter(r => r.status === "RECONCILIATION_REQUIRED").length, 0);
});
test("production submit invokes the atomic RPC and refuses an unavailable control", async () => {
  const op = { provider: "voice", idempotencyKey: "op", capacityUnits: 1000 } as PaidOperation;
  let args: unknown;
  const client = { rpc: async (name: string, payload: unknown) => { assert.equal(name, "pi_submit_with_supply"); args = payload; return { data: { submitted: true }, error: null }; } };
  assert.equal(await submitWithSupply(client as never, op), true);
  assert.deepEqual(args, { p_key: "op", p_units: 1000 });
  await assert.rejects(submitWithSupply({ rpc: async () => ({ error: "unavailable", data: null }) } as never, op), SupplyUnavailableError);
});
test("cron cannot accept a missing, short or incorrect secret", () => {
  const secret = "a".repeat(32);
  assert.equal(authorizedSupplyCron("Bearer undefined", undefined), false);
  assert.equal(authorizedSupplyCron("Bearer abc", "abc"), false);
  assert.equal(authorizedSupplyCron(`Bearer ${secret}`, secret), true);
  assert.equal(authorizedSupplyCron(`Bearer ${"b".repeat(32)}`, secret), false);
});
test("waiting for supply never becomes a stale-render retry with a new attempt", () => {
  assert.equal(isRenderStale({ status: "processing", render_attempts: 1, render_started_at: "2026-10-01T00:00:00Z", supply_wait_started_at: "2026-10-05T00:00:00Z" }, now), false);
});

test("worker slot admission is atomic and preserves the request/owner/attempt fence", async () => {
  const { attemptState } = await import("@/lib/video/attempt-state");
  const before = process.env.SUPPLY_GUARD_ENFORCED; process.env.SUPPLY_GUARD_ENFORCED = "true";
  try {
    let checked = false;
    const client = { rpc: async (name: string, params: unknown) => {
      assert.equal(name, "pi_claim_render_supply"); assert.deepEqual(params, { p_request_id: "r", p_owner_id: "owner", p_attempt: 1 });
      checked = true; return { data: { claimed: false, reason: "worker capacity" }, error: null };
    } };
    assert.equal(await attemptState(client as never, { requestId: "r", userId: "owner", attempt: 1 }).claim("queued"), false);
    assert.equal(checked, true);
  } finally { if (before === undefined) delete process.env.SUPPLY_GUARD_ENFORCED; else process.env.SUPPLY_GUARD_ENFORCED = before; }
});

test("a missing/zero paid estimate is never interpreted as free supplier capacity", async () => {
  let controlCalls = 0;
  await assert.rejects(submitWithSupply({ rpc: async () => { controlCalls++; return { data: { submitted: true }, error: null }; } } as never,
    { provider: "beatoven", reservedUsd: 0, idempotencyKey: "music" } as PaidOperation), SupplyUnavailableError);
  assert.equal(controlCalls, 0);
});
