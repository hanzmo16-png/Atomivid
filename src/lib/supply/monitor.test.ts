import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorSupply } from "./monitor";
import { resumeSupplyQueue } from "./queue";
import { jobSupplyDemands, reserveJobSupply } from "./job";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { SupplyUnavailableError } from "./policy";

// Behavioral outbox double: unique IDs, conditional delivery updates and pending reads.
function database() {
  const rows: Record<string, Record<string, unknown>[]> = {
    pi_supply_policies: [{ provider: "elevenlabs", enabled: true }], pi_supply_alerts: [], video_requests: [], pi_paid_operations: [],
  };
  let level = "YELLOW";
  const client = { rows, setLevel: (v: string) => { level = v; }, rpc: async () => ({ data: { provider: "elevenlabs", level, free: 20, remainingRatio: .2, coverageHours: 48 }, error: null }),
    from(table: string) {
      let update: Record<string, unknown> | null = null, insert: Record<string, unknown> | null = null;
      let max = Infinity, single = false;
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const chain = {
        select: () => chain, order: () => chain, limit: (n: number) => { max = n; return chain; },
        eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return chain; },
        neq: (k: string, v: unknown) => { filters.push(r => r[k] !== v); return chain; },
        is: (k: string, v: unknown) => { filters.push(r => (r[k] ?? null) === v); return chain; },
        not: (k: string) => { filters.push(r => r[k] !== null && r[k] !== undefined); return chain; },
        lte: (k: string, v: string) => { filters.push(r => String(r[k]) <= v); return chain; },
        upsert: (v: Record<string, unknown>) => { insert = v; return chain; },
        insert: (v: Record<string, unknown>) => { insert = v; return chain; },
        update: (v: Record<string, unknown>) => { update = v; return chain; },
        maybeSingle: () => { single = true; return chain; },
        then(resolve: (result: unknown) => void) {
          const all = rows[table] ?? (rows[table] = []);
          if (insert && !all.some(r => r.id === insert!.id)) all.push({ delivered_at: null, ...insert });
          const selected = all.filter(r => filters.every(f => f(r))).slice(0, max);
          if (update) for (const r of selected) Object.assign(r, update);
          return Promise.resolve({ data: single ? selected[0] ?? null : selected, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
  return client;
}
const fixed = Date.parse("2026-10-05T15:00:00Z");
test("panel-only alarms deduplicate and escalate without any outgoing message, even with legacy webhook variables", async () => {
  const db = database(); let http = 0;
  const forbidden = (async () => { http++; throw new Error("no outbound messages"); }) as typeof fetch;
  const env = { SUPPLY_ALERT_WEBHOOK_URL: "https://operations.example.test/alerts" };
  await monitorSupply(db as never, { env, now: () => fixed, fetchImpl: forbidden });
  await monitorSupply(db as never, { env, now: () => fixed + 1000, fetchImpl: forbidden });
  assert.equal(http, 0); assert.equal(db.rows.pi_supply_alerts.length, 1);
  assert.equal(db.rows.pi_supply_alerts[0].delivered_at, null);
  db.setLevel("RED");
  const result = await monitorSupply(db as never, { env, now: () => fixed + 3000, fetchImpl: forbidden });
  assert.equal(http, 0); assert.equal(db.rows.pi_supply_alerts.length, 2);
  assert.equal(result.pendingAlerts, 2);
  assert.equal(db.rows.pi_supply_alerts[1].level, "RED");
});
test("supply queue excludes expired/private trials and uncertain supplier submissions", async () => {
  const db = database(); const started = "2026-10-05T14:00:00Z";
  const row = (id: string) => ({ id, mode: "visual", render_attempts: 1, status: "processing", progress_stage: "queued", supply_wait_started_at: started, supply_not_before: started });
  db.rows.video_requests.push(row("private"), row("uncertain"), row("normal"));
  db.rows.pi_paid_operations.push({ project_id: "private", idempotency_key: "owner_form_trial:private", status: "COMMITTED" }, { project_id: "uncertain", idempotency_key: "paid", status: "SUBMITTED" });
  const dispatched: string[] = [];
  assert.equal(await resumeSupplyQueue(db as never, async r => { dispatched.push(r.requestId); }, fixed), 1);
  assert.deepEqual(dispatched, ["normal"]);
  assert.equal(await resumeSupplyQueue(db as never, async r => { dispatched.push(r.requestId); }, fixed), 0);
  assert.equal(db.rows.video_requests[2].render_attempts, 1);
});
test("whole reel reserves a pacing correction and images; recorded avatar needs no paid voice", () => {
  const flags = { ...getFeatureFlags(), imageGenerationEnabled: true, imageProvider: "openai" };
  const row = { mode: "visual", script_json: { segments: [{ text: "hola mundo" }] }, recorded_audio_path: null, long_form_production_plan: null };
  const demands = jobSupplyDemands(row, "elevenlabs", flags);
  assert.equal(demands.find(d => d.provider === "elevenlabs")?.units, 20);
  assert.equal(demands.find(d => d.provider === "openai")?.usd, flags.maxVisualCostUsd);
  const avatar = jobSupplyDemands({ ...row, mode: "avatar", recorded_audio_path: "existing-audio" }, "elevenlabs", flags);
  assert.equal(avatar.some(d => d.provider === "elevenlabs"), false);
  assert.equal(avatar[0].provider, flags.avatarProvider);
});
test("job reservation fails closed before any content call when the control is unavailable", async () => {
  const before = process.env.SUPPLY_GUARD_ENFORCED; process.env.SUPPLY_GUARD_ENFORCED = "true";
  try { await assert.rejects(reserveJobSupply({ rpc: async () => ({ error: "unavailable", data: null }) } as never, "request", 1, []), SupplyUnavailableError); }
  finally { if (before === undefined) delete process.env.SUPPLY_GUARD_ENFORCED; else process.env.SUPPLY_GUARD_ENFORCED = before; }
});

test("Runway reads API credits only, missing/invalid response remains UNKNOWN and sends no generation request", async () => {
  const { runwayApiSnapshot } = await import("./runway");
  let calls = 0;
  const request = (async (url, init) => { calls++; assert.equal(url, "https://api.dev.runwayml.com/v1/organization"); assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("X-Runway-Version"), "2024-11-06"); return Response.json({ creditBalance: 500 }); }) as typeof fetch;
  assert.equal((await runwayApiSnapshot(request, {}, new Date(fixed).toISOString())).available, null);
  const balance = await runwayApiSnapshot(request, { RUNWAY_API_KEY: "fixture" }, new Date(fixed).toISOString());
  assert.equal(calls, 1); assert.equal(balance.available, 500); assert.equal(balance.unit, "credit");
  assert.equal((await runwayApiSnapshot((async () => Response.json({ creditBalance: -1 })) as typeof fetch, { RUNWAY_API_KEY: "fixture" }, new Date(fixed).toISOString())).available, null);
});

test("HeyGen accepts only a prepaid API wallet, discards profile identity and never counts a subscription or spending cap as cash", async () => {
  const { heygenApiSnapshot } = await import("./heygen");
  const snapshot = await heygenApiSnapshot((async (url, init) => {
    assert.equal(url, "https://api.heygen.com/v3/users/me"); assert.equal(init?.method, "GET");
    return Response.json({ data: { email: "private@example.test", billing_type: "wallet", wallet: { currency: "usd", remaining_balance: 42.5 } } });
  }) as typeof fetch, { HEYGEN_API_KEY: "fixture" }, new Date(fixed).toISOString());
  assert.equal(snapshot.available, 42.5); assert.equal(snapshot.unit, "usd"); assert.ok(!JSON.stringify(snapshot).includes("private@"));
  for (const data of [{ billing_type: "subscription", subscription: { credits: { remaining: 999 } } },
    { billing_type: "usage_based", usage_based: { spending_cap_usd: 999 } }, { billing_type: "wallet", wallet: { currency: "usd", remaining_balance: null } }]) {
    assert.equal((await heygenApiSnapshot((async () => Response.json({ data })) as typeof fetch, { HEYGEN_API_KEY: "fixture" }, new Date(fixed).toISOString())).available, null);
  }
});
