import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureJobSupplyReady, periodStart } from "./readiness";
import { jobSupplyDemands } from "./job";

const NOW = Date.parse("2026-10-07T14:40:00Z");
const BILLING = new Set(["https://api.elevenlabs.io/v1/user/subscription", "https://api.dev.runwayml.com/v1/organization"]);
type Snap = { provider: string; available: number | null; reliability: string; checked_at: string };

/** In-memory supply store. pi_supply_state applies the production freshness rule:
 * provider_api readings older than 5 minutes (or unverified) are UNKNOWN; manual_entry does not expire. */
function fakeSupply(snaps: Snap[], opts: { spentToday?: Record<string, number> } = {}) {
  const policies = [
    { provider: "__global__", enabled: true, unit: "usd", unit_cost_usd: 0, daily_cap_usd: 40, monthly_cap_usd: 300, timezone: "America/Cancun", evidence: "owner-funded" },
    { provider: "elevenlabs", enabled: true, unit: "character", unit_cost_usd: 0.0002, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "America/Cancun" },
    { provider: "openai", enabled: true, unit: "usd", unit_cost_usd: 1, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "America/Cancun" },
    { provider: "runway", enabled: true, unit: "credit", unit_cost_usd: 0.01, daily_cap_usd: 20, monthly_cap_usd: 150, timezone: "America/Cancun" },
  ];
  const writes: string[] = [];
  const service = {
    snaps, writes,
    from(table: string) {
      return {
        select() { return { in: async (_k: string, values: string[]) => ({ data: policies.filter(p => values.includes(p.provider)), error: null }) }; },
        async insert(row: Snap) { writes.push(`${table}:${row.provider}`); if (table === "pi_capacity_snapshots") snaps.push(row); return { error: null }; },
      };
    },
    async rpc(name: string, args: { p_provider: string | null }) {
      if (name === "pi_supply_spend") return { data: args.p_provider ? (opts.spentToday?.[args.p_provider] ?? 0) : Object.values(opts.spentToday ?? {}).reduce((a, b) => a + b, 0), error: null };
      if (name === "pi_supply_state") {
        const s = snaps.filter(x => x.provider === args.p_provider).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
        const fresh = s && s.available !== null && (s.reliability === "manual_entry" || (s.reliability === "provider_api" && Date.parse(s.checked_at) >= NOW - 300_000));
        if (!fresh) return { data: { level: "UNKNOWN", reason: "balance unverified or stale", free: null }, error: null };
        return { data: { level: s.available! > 0 ? "GREEN" : "RED", reason: "fresh", free: s.available }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return service;
}
function billingFetch(responses: Record<string, unknown>, calls: string[] = [], down = false) {
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    assert.ok(BILLING.has(url), `only billing endpoints may be read, got ${url}`);
    if (down) throw new Error("network down");
    return new Response(JSON.stringify(responses[url]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
const env = { ELEVENLABS_API_KEY: "k", RUNWAY_API_KEY: "k" };
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const GUCCI_ROW = { mode: "long_form", script_json: { beats: [{ narration: "x".repeat(5164) }] },
  long_form_production_plan: { providers: { voice: "elevenlabs", image: "openai", aiVideo: "runway" }, allocation: { maxAiImageGenerations: 40, maxAiVideoClips: 1, maxGenerativeUsd: 2.5 }, aiImageCount: 39, aiVideoClipCount: 1, estimatedProviderCostUsd: 3.5328, estimatedVoiceCostUsd: 1.0328 } };
const gucciDemands = () => jobSupplyDemands(GUCCI_ROW as never, "elevenlabs", { musicProvider: "curated-library" } as never);
const BALANCES = { "https://api.elevenlabs.io/v1/user/subscription": { character_limit: 63002, character_count: 45546 }, "https://api.dev.runwayml.com/v1/organization": { creditBalance: 5250 } };

test("A: fresh readings with enough capacity are ready without any refresh", async () => {
  const calls: string[] = [];
  const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(1) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(2) }]);
  const r = await ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), { env, fetchImpl: billingFetch(BALANCES, calls), now: () => NOW });
  assert.equal(r.ready, true);
  assert.deepEqual(calls, []);
});

test("B and G: stale readings (the real Gucci state) are refreshed just in time and the whole plan becomes ready, without reserving", async () => {
  const calls: string[] = [];
  const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(358) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(358) }]);
  const r = await ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), { env, fetchImpl: billingFetch(BALANCES, calls), now: () => NOW });
  assert.equal(r.ready, true, JSON.stringify(r));
  assert.deepEqual(r.providers.map(p => [p.provider, p.refreshed]), [["elevenlabs", true], ["openai", false], ["runway", true]]);
  assert.deepEqual(calls.sort(), ["GET https://api.dev.runwayml.com/v1/organization", "GET https://api.elevenlabs.io/v1/user/subscription"]);
  assert.deepEqual(s.writes.sort(), ["pi_capacity_snapshots:elevenlabs", "pi_capacity_snapshots:runway"], "only snapshots are written; no reservation, no request change");
});

test("C: stale reading refreshed but without enough capacity → blocked before any spend", async () => {
  const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(358) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(358) }]);
  const low = { ...BALANCES, "https://api.elevenlabs.io/v1/user/subscription": { character_limit: 63002, character_count: 60000 } };
  const r = await ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), { env, fetchImpl: billingFetch(low), now: () => NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(r.failure, { provider: "elevenlabs", reason: "supplier balance unavailable" });
});

test("D: billing API down or no credential → fail closed, UNKNOWN never becomes ready", async () => {
  for (const variant of ["down", "no-credential"] as const) {
    const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(358) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
      { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(358) }]);
    const r = await ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), {
      env: variant === "no-credential" ? {} : env, fetchImpl: billingFetch(BALANCES, [], variant === "down"), now: () => NOW });
    assert.equal(r.ready, false, variant);
    assert.equal(r.failure?.reason, "supplier balance unavailable");
  }
});

test("E: two productions checking concurrently refresh independently and never reserve", async () => {
  const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(358) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(358) }]);
  const [a, b] = await Promise.all([1, 2].map(() => ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), { env, fetchImpl: billingFetch(BALANCES), now: () => NOW })));
  assert.equal(a.ready && b.ready, true);
  assert.ok(s.writes.every(w => w.startsWith("pi_capacity_snapshots:")), "readiness only records observations; reservations stay in the atomic SQL function");
});

test("caps: a provider or global ceiling that would be exceeded blocks before reserving", async () => {
  const fresh = () => [{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(1) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(1) }];
  const provider = await ensureJobSupplyReady(fakeSupply(fresh(), { spentToday: { openai: 18 } }) as unknown as SupabaseClient, gucciDemands(), { env, now: () => NOW });
  assert.deepEqual(provider.failure, { provider: "openai", reason: "provider funded spend ceiling" });
  const global = await ensureJobSupplyReady(fakeSupply(fresh(), { spentToday: { anthropic: 19, heygen: 19 } }) as unknown as SupabaseClient, gucciDemands(), { env, now: () => NOW });
  assert.deepEqual(global.failure, { provider: "production", reason: "global funded spend ceiling" });
});

test("F: refresh mode off (preflight before the click) reports stale providers without writing or calling anything", async () => {
  const calls: string[] = [];
  const s = fakeSupply([{ provider: "elevenlabs", available: 17456, reliability: "provider_api", checked_at: at(358) }, { provider: "openai", available: 12.97, reliability: "manual_entry", checked_at: at(2000) },
    { provider: "runway", available: 5250, reliability: "provider_api", checked_at: at(358) }]);
  const r = await ensureJobSupplyReady(s as unknown as SupabaseClient, gucciDemands(), { refresh: false, env, fetchImpl: billingFetch(BALANCES, calls), now: () => NOW });
  assert.equal(r.ready, false);
  assert.deepEqual(calls, []); assert.deepEqual(s.writes, []);
});

test("period starts follow the policy timezone", () => {
  assert.equal(periodStart("America/Cancun", "day", new Date("2026-10-07T03:00:00Z")).toISOString(), "2026-10-06T05:00:00.000Z");
  assert.equal(periodStart("America/Cancun", "month", new Date("2026-10-07T14:40:00Z")).toISOString(), "2026-10-01T05:00:00.000Z");
});
