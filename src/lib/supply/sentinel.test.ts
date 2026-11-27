import test from "node:test";
import assert from "node:assert/strict";
import { buildSentinelOverview, type SentinelInput, type SentinelOperation, type SentinelReservation } from "./sentinel";

const now = Date.parse("2026-11-26T12:00:00Z"), day = 86_400_000;
const at = (days: number) => new Date(now - days * day).toISOString();
const op = (id: string, days = 2, patch: Partial<SentinelOperation> = {}): SentinelOperation => ({ idempotency_key: id, provider: "anthropic", status: "COMMITTED", reserved_usd: 10, committed_usd: 10, capacity_units: null, created_at: patch.updated_at && Date.parse(patch.updated_at) < Date.parse(at(days)) ? patch.updated_at : at(days), updated_at: at(days), ...patch });
const job = (patch: Partial<SentinelReservation> = {}): SentinelReservation => ({ id: "envelope", project_id: "private-project", provider: "anthropic", status: "OPEN", reserved_units: 100, consumed_units: 0, reserved_usd: 100, consumed_usd: 0, ...patch });
const input = (patch: Partial<SentinelInput> = {}): SentinelInput => ({ now, policies: [{ provider: "anthropic", unit: "usd", unit_cost_usd: 1, enabled: true }], snapshots: [{ provider: "anthropic", unit: "usd", available: 100, checked_at: new Date(now - 60_000).toISOString(), reliability: "provider_api", health: "OK" }], operations: [op("a", 2), op("b", 5), op("c", 10), op("old", 20)], reservations: [], ledgerComplete: true, historySince: "2026-11-01T00:00:00Z", ...patch });
const account = (patch: Partial<SentinelInput> = {}) => buildSentinelOverview(input(patch)).accounts[0];

test("confirmed costs produce bounded 7/14-day estimates with actual evidence coverage", () => {
  const r = account();
  assert.equal(r.level, "GREEN"); assert.equal(r.available, 100); assert.equal(r.free, 100);
  assert.equal(r.forecast.samples, 3); assert.equal(r.forecast.activeDays, 3); assert.equal(r.forecast.coveredDays, 14);
  assert.equal(r.forecast.confidence, "HIGH"); assert.equal(r.forecast.dailyActualUsd, 30 / 14);
  assert.equal(r.forecast.target7Units, 17.25); assert.equal(r.forecast.target14Units, 34.5);
  assert.equal(r.consumption.daily.actualUsd, 0); assert.equal(r.consumption.rolling7d.actualUsd, 20); assert.equal(r.consumption.monthly.actualUsd, 40);
});

test("latest wallet checkedAt debits only subsequent settled consumption and provides an audit status", () => {
  const r = account({ operations: [op("old", 2), op("new", 0, { updated_at: new Date(now - 1_000).toISOString(), committed_usd: 4, reserved_usd: 4 })] });
  assert.equal(r.available, 100); assert.equal(r.consumedSinceSnapshot, 4); assert.equal(r.free, 96);
  assert.equal(r.auditStatus, "VERIFIED_LEDGER_ADJUSTMENT");
});

test("manual, stale, future and invalid observations never become real available or GREEN", () => {
  const base = input().snapshots[0];
  for (const patch of [{ reliability: "manual_entry" as const }, { checked_at: new Date(now - 300_001).toISOString() }, { checked_at: new Date(now + 1).toISOString() }, { checked_at: "invalid" }, { available: NaN }, { available: "Infinity" }, { available: -1 }]) {
    const r = account({ snapshots: [{ ...base, ...patch }] }); assert.equal(r.available, null); assert.equal(r.free, null); assert.equal(r.level, "GRAY");
  }
  assert.equal(account({ snapshots: [{ ...base, reliability: "manual_entry" }] }).estimatedAvailable, 100);
  assert.equal(account({ snapshots: [{ ...base, checked_at: new Date(now - 300_000).toISOString() }] }).available, 100);
});

test("fal aliases share one wallet and aggregate holds; other USD providers remain separate", () => {
  const s = input().snapshots[0], p = input().policies[0];
  const r = buildSentinelOverview(input({ policies: [{ ...p, provider: "recraft" }, { ...p, provider: "flux", enabled: false }, p], snapshots: [{ ...s, provider: "recraft", available: 50 }, { ...s, provider: "flux", available: 50 }, s], operations: [op("image", 0, { provider: "flux", committed_usd: 5, reserved_usd: 5, updated_at: new Date(now - 1_000).toISOString() })] }));
  assert.equal(r.accounts.length, 2); const fal = r.accounts.find(x => x.account === "fal")!;
  assert.equal(fal.available, 50); assert.equal(fal.free, 45); assert.deepEqual(fal.enabledProviders, ["recraft"]);
  assert.equal(r.totalsByUnit[0].verifiedAvailable, 150); assert.equal(r.accountingScope, "READ_ONLY_NOT_ATOMIC_ADMISSION");
});

test("shared newest snapshot wins but simultaneous contradictory observations are unknown", () => {
  const p = input().policies[0], s = input().snapshots[0];
  const base = { policies: [{ ...p, provider: "recraft" }, { ...p, provider: "flux" }], snapshots: [{ ...s, provider: "recraft", available: 100 }, { ...s, provider: "flux", available: 70, checked_at: new Date(now - 30_000).toISOString() }] };
  assert.equal(account(base).available, 70);
  const r = account({ ...base, snapshots: base.snapshots.map(x => ({ ...x, checked_at: s.checked_at })) });
  assert.equal(r.available, null); assert.equal(r.auditStatus, "SIMULTANEOUS_SNAPSHOT_CONFLICT"); assert.equal(r.level, "GRAY");
});

test("same snapshot/operation/reservation duplicates do not multiply balances or charges", () => {
  const b = input(), operations = [...b.operations, ...b.operations.map(x => ({ ...x }))];
  const r = account({ snapshots: [b.snapshots[0], { ...b.snapshots[0] }], operations, reservations: [job(), job()] });
  assert.equal(r.available, 100); assert.equal(r.held, 100); assert.equal(r.consumption.monthly.actualUsd, 40);
  const conflict = account({ operations: [op("same"), op("same", 2, { committed_usd: 11 })] });
  assert.equal(conflict.free, null); assert.equal(conflict.level, "GRAY");
  assert.equal(account({ operations: [op("same", 2, { capacity_units: NaN }), op("same", 2, { capacity_units: null })] }).free, null);
});

test("envelope pending children are covered once; submitted/committed debits use remaining envelopes", () => {
  const base = { snapshots: [{ ...input().snapshots[0], available: 200 }] };
  const child = op("child", .001, { supply_job_key: "envelope", project_id: "private-project", reserved_usd: 20, committed_usd: null, status: "RESERVED" });
  assert.equal(account({ ...base, reservations: [job()], operations: [child] }).held, 100);
  const submitted = account({ ...base, reservations: [job({ consumed_units: 20, consumed_usd: 20 })], operations: [{ ...child, status: "SUBMITTED" }] });
  assert.equal(submitted.held, 100); assert.equal(submitted.free, 100); assert.equal(submitted.level, "GRAY");
  const committed = account({ ...base, reservations: [job({ consumed_units: 20, consumed_usd: 20 })], operations: [{ ...child, status: "COMMITTED", committed_usd: 20, updated_at: new Date(now - 1_000).toISOString() }] });
  assert.equal(committed.held, 80); assert.equal(committed.consumedSinceSnapshot, 20); assert.equal(committed.free, 100);
  assert.equal(account({ ...base, reservations: [job()], operations: [{ ...child, supply_job_key: null }] }).held, 100);
});

test("uncertain and null-actual commits never become confirmed consumption or forecast samples", () => {
  for (const status of ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "REFUNDED", "COMMITTED"] as const) {
    const r = account({ operations: [op("unknown", 0, { status, reserved_usd: 7, committed_usd: null })] });
    assert.equal(r.held, 7); assert.equal(r.consumption.daily.actualUsd, 0); assert.equal(r.consumption.daily.estimatedUsd, 7); assert.equal(r.forecast.samples, 0); assert.equal(r.level, "GRAY");
  }
  assert.equal(account({ operations: [op("proven-free", 0, { status: "REFUNDED", supply_reconciled: true })] }).held, 0);
});

test("different units never total together or masquerade as actual credit consumption", () => {
  const b = input(), r = buildSentinelOverview(input({ policies: [...b.policies, { provider: "runway", unit: "credit", unit_cost_usd: .01, enabled: true }], snapshots: [...b.snapshots, { ...b.snapshots[0], provider: "runway", unit: "credit", available: 500 }], operations: [op("credits", 0, { provider: "runway", capacity_units: 100, committed_usd: 1, reserved_usd: 1, updated_at: new Date(now - 1_000).toISOString() })] }));
  assert.equal(r.totalsByUnit.length, 2); assert.equal(r.totalsByUnit.find(x => x.unit === "usd")!.verifiedAvailable, 100);
  const credit = r.accounts.find(x => x.account === "runway")!;
  assert.equal(credit.free, 400); assert.equal(credit.consumption.daily.actualUnits, null); assert.equal(credit.consumption.daily.estimatedUnits, 100); assert.equal(credit.auditStatus, "UNIT_CONSUMPTION_ESTIMATED");
});

test("zero/new demand is not infinite runway and query cutoff alone is not observation history", () => {
  for (const operations of [[], [op("new", 0)], [op("one", .5), op("two", .4), op("three", .3)]]) {
    const r = account({ operations }); assert.equal(r.forecast.coverageDays, null); assert.equal(r.forecast.target14Units, null); assert.notEqual(r.forecast.confidence, "HIGH"); assert.ok(r.forecast.coveredDays <= 1);
  }
  const zeros = input().operations.map(x => ({ ...x, committed_usd: 0, reserved_usd: 0 }));
  const r = account({ operations: zeros }); assert.equal(r.forecast.coverageDays, null); assert.equal(r.forecast.target7Units, null);
});

test("account calendar timezone and rolling windows are distinct; partial windows stay unknown", () => {
  const policies = [{ ...input().policies[0], timezone: "America/Cancun" }];
  const operations = [op("today", 0, { created_at: "2026-11-26T02:00:00Z", updated_at: "2026-11-26T02:00:00Z" })];
  assert.equal(account({ policies, operations }).consumption.daily.actualUsd, 0);
  assert.equal(account({ operations }).consumption.daily.actualUsd, 10);
  assert.equal(account({ historySince: at(10) }).consumption.monthly.actualUsd, null);
  assert.equal(account({ historySince: null }).consumption.daily.actualUsd, null);
  assert.equal(account({ policies: [{ ...policies[0], timezone: "invalid-zone" }] }).free, null);
});

test("cross-product coverage gaps preserve genuine API balance while all adjusted forecasts are unknown", () => {
  const r = account({ uncoveredProviders: ["anthropic"] });
  assert.equal(r.available, 100); assert.equal(r.free, null); assert.equal(r.held, null); assert.equal(r.consumedSinceSnapshot, null); assert.equal(r.forecast.dailyActualUsd, null); assert.equal(r.forecast.target7Units, null); assert.equal(r.level, "GRAY"); assert.equal(r.auditStatus, "CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED");
  assert.equal(account({ ledgerComplete: false }).free, null);
  assert.equal(account({ policies: [{ ...input().policies[0], enabled: false }] }).level, "GRAY");
});

test("bad finite values, future operations, overflowing totals and overlapping legacy holds fail closed", () => {
  for (const patch of [{ reserved_usd: NaN }, { committed_usd: "Infinity" }, { capacity_units: -1 }, { updated_at: new Date(now + 1).toISOString() }]) assert.equal(account({ operations: [op("bad", 0, patch)] }).free, null);
  assert.equal(account({ reservations: [job({ consumed_usd: 101 })] }).free, null);
  assert.equal(account({ reservations: [job()], operations: [op("legacy", 0, { method: "capacity_hold", result_ref: "units:100", supply_job_key: "envelope", status: "RESERVED" })] }).free, null);
  assert.equal(account({ operations: [op("huge-a", 0, { status: "RESERVED", reserved_usd: 1e308 }), op("huge-b", 0, { status: "RESERVED", reserved_usd: 1e308 })] }).free, null);
});

test("validated thresholds set colors and official links; unverified telemetry is UNKNOWN", () => {
  assert.equal(account({ snapshots: [{ ...input().snapshots[0], available: 0 }] }).level, "RED");
  assert.equal(account({ thresholds: { redDays: 1, amberDays: 100 } }).level, "AMBER");
  for (const thresholds of [{ redDays: NaN }, { redDays: 4, amberDays: 3 }, { bufferRatio: -1 }, { minimumSamples: .5 }]) assert.throws(() => account({ thresholds }), /INVALID_SENTINEL/);
  const b = buildSentinelOverview(input()); assert.ok(b.resources.every(x => x.state === "UNKNOWN")); assert.ok(b.accounts[0].topUpUrl?.startsWith("https://console.anthropic.com/"));
  const t = buildSentinelOverview(input({ telemetry: [{ resource: "workers", verified: true, checked_at: at(0), used: 1, limit: 3, unit: "slots" }] }));
  assert.equal(t.resources.find(x => x.resource === "workers")!.state, "VERIFIED"); assert.equal(t.resources.find(x => x.resource === "gpu")!.used, null);
});

test("no raw identifiers, keys, private payloads or arbitrary provider labels are returned", () => {
  const opWithPayload = { ...op("private-id-secret"), project_id: "private-user-secret", result_ref: "https://private.invalid/token-secret", payload: { key: "secret-value" } };
  const result = buildSentinelOverview(input({ operations: [opWithPayload], policies: [...input().policies, { provider: "private-customer-secret", unit: "usd", unit_cost_usd: 1 }] }));
  assert.ok(!JSON.stringify(result).includes("secret"));
});


test("fresh API zero funds or verified outage remains RED despite uncovered ledgers", () => {
  const s = input().snapshots[0], uncoveredProviders = ["anthropic"];
  for (const snapshot of [{ ...s, available: 0 }, { ...s, health: "DOWN" as const }, { ...s, available: null, health: "DOWN" as const }]) {
    const r = account({ uncoveredProviders, snapshots: [snapshot] });
    assert.equal(r.level, "RED"); assert.equal(r.free, null); assert.equal(r.held, null); assert.equal(r.consumption.daily.actualUsd, null); assert.equal(r.forecast.dailyActualUsd, null); assert.equal(r.auditStatus, "CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED");
  }
  assert.equal(account({ snapshots: [{ ...s, available: null, health: "UNCHECKED" }] }).level, "GRAY");
  assert.equal(account({ snapshots: [{ ...s, available: 0, reliability: "manual_entry", health: "DOWN" }] }).level, "GRAY");
  assert.equal(account({ snapshots: [{ ...s, available: 0, checked_at: new Date(now - 300_001).toISOString(), health: "DOWN" }] }).level, "GRAY");
});

test("pending non-USD reservations are commitments, never reported as consumed credits", () => {
 const base = input();
 const r = account({policies:[{...base.policies[0],unit:"character",unit_cost_usd:.01}],snapshots:[{...base.snapshots[0],unit:"character",available:1000}],operations:[op("paid",0,{committed_usd:.1,reserved_usd:.1,capacity_units:10}),op("pending",0,{status:"RESERVED",committed_usd:null,reserved_usd:5,capacity_units:500})]});
 assert.equal(r.consumption.daily.estimatedUnits,10);assert.equal(r.consumption.daily.actualUsd,.1);assert.equal(r.consumption.daily.estimatedUsd,0);
});


test("free-pool committed character usage still debits the physical API balance without inventing USD charges", () => {
  const b = input(), r = account({ policies: [{ ...b.policies[0], provider: "elevenlabs", unit: "character", unit_cost_usd: .001 }], snapshots: [{ ...b.snapshots[0], provider: "elevenlabs", unit: "character", available: 1000 }], operations: [op("free-characters", 2, { provider: "elevenlabs", supply_pool: "free", committed_usd: 0, reserved_usd: 0, capacity_units: 100, updated_at: new Date(now - 1_000).toISOString() })] });
  assert.equal(r.available, 1000); assert.equal(r.consumedSinceSnapshot, 100); assert.equal(r.free, 900);
  assert.equal(r.consumption.daily.actualUsd, 0); assert.equal(r.consumption.daily.actualUnits, null); assert.equal(r.consumption.daily.estimatedUnits, 100);
});

test("free-pool USD commitment at actual zero never invents a dollar debit from planned capacity", () => {
  const r = account({ operations: [op("free-dollars", 2, { supply_pool: "free", committed_usd: 0, reserved_usd: 3, capacity_units: 100, updated_at: new Date(now - 1_000).toISOString() })] });
  assert.equal(r.consumedSinceSnapshot, 0); assert.equal(r.free, 100); assert.equal(r.held, 0);
  assert.equal(r.consumption.daily.actualUsd, 0); assert.equal(r.consumption.daily.estimatedUsd, 0);
});

test("free-pool submitted requests retain conservative estimated holds just like existing SQL", () => {
  const r = account({ operations: [op("free-pending", 0, { supply_pool: "free", status: "SUBMITTED", committed_usd: null, reserved_usd: 3 })] });
  assert.equal(r.held, 3); assert.equal(r.free, 97); assert.equal(r.consumption.daily.actualUsd, 0); assert.equal(r.consumption.daily.estimatedUsd, 3);
  assert.equal(r.level, "GRAY"); assert.equal(r.auditStatus, "UNRESOLVED_CHARGES");
});

test("balance evidence explicitly separates live API, stale API, derived estimate and unknown", () => {
 const s=input().snapshots[0];
 assert.equal(account().balanceStatus,"REAL");
 const stale=account({snapshots:[{...s,checked_at:at(1)}]});assert.equal(stale.balanceStatus,"STALE");assert.equal(stale.staleAvailable,100);assert.equal(stale.available,null);assert.equal(stale.free,null);
 const derived=account({snapshots:[{...s,available:null,reliability:"derived_from_ledger",derived_estimate:75}]});assert.equal(derived.balanceStatus,"ESTIMATED");assert.equal(derived.estimatedAvailable,75);assert.equal(derived.available,null);assert.equal(derived.free,null);
 assert.equal(account({snapshots:[]}).balanceStatus,"UNKNOWN");
});


test("settled Audio tariff estimates never become invoice costs or high-confidence forecast samples", () => {
  const r = account({ operations: [op("audio", 0, { method: "audio_studio_tts_tariff_estimate", committed_usd: 7, reserved_usd: 7, updated_at: new Date(now - 1000).toISOString() })] });
  assert.equal(r.consumption.daily.actualUsd, 0);
  assert.equal(r.consumption.daily.estimatedUsd, 7);
  assert.equal(r.consumedSinceSnapshot, 7);
  assert.equal(r.forecast.samples, 0);
  assert.equal(r.forecast.target14Units, null);
  assert.equal(r.auditStatus, "UNRESOLVED_CHARGES");
});
