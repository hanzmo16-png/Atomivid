/** Command Center V0 tests: access, deterministic aggregation, empty/partial/unavailable sources, windows, no fake revenue. */
import test from "node:test";
import assert from "node:assert/strict";
import { isCommandCenterAdmin, requireCommandCenterAdmin, CommandCenterAccessError } from "./access";
import { timeRange, WINDOWS } from "./windows";
import { memorySource, type MemoryData } from "./sources";
import { CommandCenterService, SECTIONS } from "./service";
import { aggregateProviders } from "./aggregate";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-30T12:00:00.000Z";
const env = { AVATAR_PREPARATION_OWNER_EMAIL: "owner@atomivid.test", COMMAND_CENTER_ADMIN_EMAILS: "ops@atomivid.test" };
const owner = { id: "u-owner", email: "owner@atomivid.test", email_confirmed_at: NOW };
const normal = { id: "u-1", email: "user@example.com", email_confirmed_at: NOW };

const data: MemoryData = {
  users: { total: 42, rows: [{ id: "a", createdAt: "2026-10-29T00:00:00Z", lastSignInAt: "2026-10-30T09:00:00Z" }, { id: "b", createdAt: "2026-09-01T00:00:00Z", lastSignInAt: "2026-10-25T00:00:00Z" }] },
  subscriptions: [{ userId: "a", status: "active", priceId: "price_pro", createdAt: "2026-10-01T00:00:00Z" }, { userId: "b", status: "none", priceId: null, createdAt: "2026-09-01T00:00:00Z" }],
  requests: [
    { id: "r1", userId: "a", mode: "visual", status: "completed", createdAt: "2026-10-30T08:00:00Z", renderAttempts: 1, renderStartedAt: null, longFormStage: null },
    { id: "r2", userId: "b", mode: "long_form", status: "processing", createdAt: "2026-10-28T08:00:00Z", renderAttempts: 2, renderStartedAt: "2026-10-28T08:00:00Z", longFormStage: "rendering" },
    { id: "r3", userId: "b", mode: "avatar", status: "failed", createdAt: "2026-10-10T08:00:00Z", renderAttempts: 3, renderStartedAt: null, longFormStage: null },
    { id: "r4", userId: "a", mode: "long_form", status: "completed", createdAt: "2026-10-20T08:00:00Z", renderAttempts: 2, renderStartedAt: null, longFormStage: null },
  ],
  costs: [{ requestId: "r1", estimatedCostUsd: 1, imageProvider: "openai", imageCostUsd: 0.4, premiumVideoProvider: "runway", premiumVideoCostUsd: 0.5, avatarCostUsd: 0, voiceProvider: "elevenlabs", footageProvider: "pexels", renderMs: 60000, regenerations: 0 }, { requestId: "r4", estimatedCostUsd: 30, imageProvider: "openai", imageCostUsd: 3, premiumVideoProvider: "runway", premiumVideoCostUsd: 2, avatarCostUsd: 0, voiceProvider: "elevenlabs", footageProvider: null, renderMs: 180000, regenerations: 1 }],
  paidOps: [{ projectId: "r4", provider: "runway", method: "I2V_ECONOMY", reservedUsd: 0.25, committedUsd: 0.25, status: "COMMITTED", updatedAt: "2026-10-20T09:00:00Z" }, { projectId: "r2", provider: "runway", method: "I2V_ECONOMY", reservedUsd: 0.5, committedUsd: null, status: "RESERVED", updatedAt: "2026-10-28T09:00:00Z" }],
  capacity: [{ provider: "elevenlabs", unit: "character", available: 20000, reserved: 1000, pending: 0, status: "GREEN", reliability: "provider_api", renewalDate: "2026-11-15", checkedAt: "2026-10-30T11:59:00Z" }, { provider: "openai", unit: "usd", available: null, reserved: 2, pending: 0, status: "GREEN", reliability: "derived_from_ledger", renewalDate: null, checkedAt: "2026-10-30T11:59:00Z" }, { provider: "runway", unit: "usd", available: 1, reserved: 5, pending: 0, status: "RED", reliability: "provider_api", renewalDate: null, checkedAt: "2026-10-30T11:59:00Z" }],
  finalCut: [{ productionId: "r4", masterId: "m4", toState: "EDITORIAL_INSPECTING", decidedAt: "2026-10-21T00:00:00Z" }, { productionId: "r4", masterId: "m4", toState: "EDITORIAL_QA_PASS", decidedAt: "2026-10-21T00:01:00Z" }, { productionId: "r2", masterId: "m2", toState: "HUMAN_REVIEW_REQUIRED", decidedAt: "2026-10-29T00:00:00Z" }],
  ytChannels: [{ channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", status: "connected", title: "T" }],
  ytLinks: [{ projectId: "r4", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", publishedAt: "2026-10-22T00:00:00Z" }],
  ytRows: [{ channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", metric: "views", value: 120, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" }, { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", metric: "views", value: 80, dimensionLabel: "YT_SEARCH", dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" }, { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", metric: "averagePercentageViewed", value: 41, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" }],
};
const service = (d: MemoryData = data) => new CommandCenterService({ source: memorySource(d), env, now: () => NOW });

test("admin access allowed (owner gate + explicit allowlist); normal user denied global metrics; empty configuration denies all", async () => {
  assert.equal(isCommandCenterAdmin(owner, env), true);
  assert.equal(isCommandCenterAdmin({ email: "ops@atomivid.test", email_confirmed_at: NOW }, env), true);
  assert.equal(isCommandCenterAdmin(normal, env), false);
  assert.equal(isCommandCenterAdmin({ ...owner, email_confirmed_at: undefined }, env), false, "unconfirmed e-mail");
  assert.equal(isCommandCenterAdmin(owner, {}), false, "no configuration = nobody");
  assert.throws(() => requireCommandCenterAdmin(null, env), (e: CommandCenterAccessError) => e.status === 401);
  assert.throws(() => requireCommandCenterAdmin(normal, env), (e: CommandCenterAccessError) => e.status === 403);
  for (const s of SECTIONS) await assert.rejects(service().section(normal, s, "7D"), CommandCenterAccessError);
  const ov = await service().section(owner, "overview", "7D");
  assert.equal(ov.readOnly, true);
});

test("deterministic aggregation: same data -> identical output; production types, states, retries, recoveries, Final Cut buckets", async () => {
  const a = await service().section(owner, "production", "LIFETIME"), b = await service().section(owner, "production", "LIFETIME");
  assert.deepEqual(a, b);
  const d = a.data as { total: { value: number }; byType: Record<string, number>; byState: Record<string, number>; retries: { value: number }; recoveries: { value: number }; averageProductionSec: { value: number }; staleRunning: { value: number }; finalCut: Record<string, unknown> };
  assert.equal(d.total.value, 4); assert.deepEqual(d.byType, { reel: 1, long_form: 2, avatar: 1, tts_podcast: 0, unknown: 0 });
  assert.deepEqual(d.byState, { queued: 0, running: 1, completed: 2, failed: 1, other: 0 });
  assert.equal(d.retries.value, 1 + 2 + 1); assert.equal(d.recoveries.value, 1); assert.equal(d.averageProductionSec.value, 120); assert.equal(d.staleRunning.value, 1);
  assert.deepEqual({ pass: d.finalCut.pass, humanReview: d.finalCut.humanReview, inspecting: d.finalCut.inspecting }, { pass: 1, humanReview: 1, inspecting: 0 });
});

test("time-window filtering: TODAY / 7D / 28D / MTD / LIFETIME", async () => {
  const counts: Record<string, number> = {};
  for (const w of WINDOWS) counts[w] = ((await service().section(owner, "production", w)).data as { total: { value: number } }).total.value;
  assert.deepEqual(counts, { TODAY: 1, "7D": 2, "28D": 4, MTD: 4, LIFETIME: 4 });
  assert.equal(timeRange("LIFETIME", NOW).fromIso, null); assert.equal(timeRange("MTD", NOW).fromIso, "2026-10-01T00:00:00.000Z"); assert.equal(timeRange("TODAY", NOW).fromIso, "2026-10-30T00:00:00.000Z");
});

test("costs: COGS = committed consumption only; provider top-ups never appear; by provider / media type / production type", async () => {
  const c = (await service().section(owner, "costs", "LIFETIME")).data as { estimatedUsd: { value: number }; reservedUsd: { value: number }; actualCogsUsd: { value: number; note: string }; byProvider: Record<string, number>; byMediaType: Record<string, unknown>; averageCogsByProductionType: Record<string, number> };
  assert.equal(c.estimatedUsd.value, 31); assert.equal(c.reservedUsd.value, 0.5); assert.equal(c.actualCogsUsd.value, 0.9 + 5 + 0.25);
  assert.match(c.actualCogsUsd.note, /top-ups excluded/);
  assert.deepEqual(c.byProvider, { openai: 3.4, runway: 2.75 });
  assert.deepEqual(c.averageCogsByProductionType, { reel: 0.9, long_form: 5 });
  assert.equal((c.byMediaType.narration as { state: string }).state, "UNKNOWN", "narration USD is not recorded: UNKNOWN, not 0");
});

test("empty database: KNOWN zeros where the source answered, UNAVAILABLE where it did not; no fake revenue", async () => {
  const empty = await service({ users: { total: 0, rows: [] }, subscriptions: [], requests: [], costs: [], paidOps: [], capacity: [], finalCut: [], ytChannels: [], ytLinks: [], ytRows: [] }).section(owner, "overview", "7D");
  const d = empty.data as unknown as { customers: Record<string, { value: number | null; state: string }>; production: { total: { value: number; state: string } }; costs: { actualCogsUsd: { value: number } }; youtube: { channelsConnected: { value: number }; totals: Record<string, { state: string }> }; providers: { providers: unknown[] } };
  assert.deepEqual([d.customers.totalUsers.value, d.customers.totalUsers.state], [0, "KNOWN"]);
  assert.equal(d.customers.mrrUsd.state, "UNAVAILABLE", "revenue is never derived");
  assert.equal(d.production.total.value, 0); assert.equal(d.costs.actualCogsUsd.value, 0); assert.equal(d.youtube.channelsConnected.value, 0); assert.equal(d.youtube.totals.views.state, "UNKNOWN"); assert.deepEqual(d.providers.providers, []);
  const missing = await service({ unavailable: ["requests", "costs", "paidOps", "capacity", "youtubeChannels", "youtubeLinks", "youtubeRows", "finalCutDecisions", "subscriptions"] }).section(owner, "overview", "7D");
  const m = missing.data as { production: { total: { state: string } }; costs: { actualCogsUsd: { state: string } }; providers: { state: string }; youtube: { state: string }; customers: { totalUsers: { state: string }; subscriptions: { state: string } }; systemHealth: { unavailableSources: string[] } };
  assert.equal(m.production.total.state, "UNAVAILABLE"); assert.equal(m.costs.actualCogsUsd.state, "UNAVAILABLE"); assert.equal(m.providers.state, "UNAVAILABLE"); assert.equal(m.youtube.state, "UNAVAILABLE"); assert.equal(m.customers.totalUsers.state, "UNAVAILABLE"); assert.equal(m.customers.subscriptions.state, "UNAVAILABLE");
  assert.deepEqual(m.systemHealth.unavailableSources, ["requests", "providers", "youtube"]);
});

test("providers: partial data and UNKNOWN capacity never become HEALTHY; INSUFFICIENT is surfaced", async () => {
  const p = (await service().section(owner, "providers", "7D")).data as { providers: { provider: string; state: string; balance: number | null }[] };
  assert.deepEqual(p.providers.map((x) => [x.provider, x.state, x.balance]), [["elevenlabs", "HEALTHY", 20000], ["openai", "UNKNOWN", null], ["runway", "INSUFFICIENT", 1]]);
  const stale = aggregateProviders([{ provider: "openai", unit: "usd", available: null, reserved: 0, pending: 0, status: "GREEN", reliability: "none", renewalDate: null, checkedAt: NOW }], NOW, ["openai"]);
  assert.equal(stale.providers[0].state, "UNKNOWN", "a stored GREEN with no verifiable balance is still UNKNOWN");
  const health = (await service().section(owner, "system-health", "7D")).data as { providersUnknown: string[]; providersInsufficient: string[]; autoPublish: boolean; finalCutGate: string };
  assert.deepEqual(health.providersUnknown, ["openai"]); assert.deepEqual(health.providersInsufficient, ["runway"]); assert.equal(health.autoPublish, false); assert.equal(health.finalCutGate, "ACTIVE");
});

test("youtube section: channel -> video -> production navigation without duplicating data; unavailable YouTube stays UNAVAILABLE", async () => {
  const y = (await service().section(owner, "youtube", "28D")).data as { channelsConnected: { value: number }; videosLinked: { value: number }; freshnessHours: { value: number }; totals: { views: { value: number }; averagePercentageViewed: { value: number } }; trafficSources: Record<string, number>; videos: { productionId: string; videoId: string; views: number }[] };
  assert.equal(y.channelsConnected.value, 1); assert.equal(y.videosLinked.value, 1); assert.equal(y.freshnessHours.value, 24); assert.equal(y.totals.views.value, 120); assert.equal(y.totals.averagePercentageViewed.value, 41);
  assert.deepEqual(y.trafficSources, { YT_SEARCH: 80 }); assert.deepEqual(y.videos, [{ productionId: "r4", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", videoId: "dQw4w9WgXcQ", publishedAt: "2026-10-22T00:00:00Z", views: 120, averagePercentageViewed: 41 }]);
  const off = (await service({ ...data, unavailable: ["youtubeChannels", "youtubeLinks", "youtubeRows"] }).section(owner, "youtube", "28D")).data as { state: string };
  assert.equal(off.state, "UNAVAILABLE");
});

test("no network call in this file", () => { assert.equal(networkCalls, 0); });

test("capacity freshness: five-minute boundary, future/invalid dates and invalid quantities fail closed", () => {
  const row = { ...data.capacity![0], checkedAt: NOW };
  assert.equal(aggregateProviders([row], NOW, [row.provider]).providers[0].state, "HEALTHY");
  assert.equal(aggregateProviders([{ ...row, checkedAt: new Date(Date.parse(NOW) - 300_000).toISOString() }], NOW, [row.provider]).providers[0].state, "HEALTHY");
  for (const patch of [
    { checkedAt: new Date(Date.parse(NOW) - 300_001).toISOString() },
    { checkedAt: new Date(Date.parse(NOW) + 1).toISOString() }, { checkedAt: "invalid" },
    { available: NaN }, { available: Infinity }, { available: -1 }, { reserved: -1 },
    { reliability: "manual_entry" }, { reliability: "unexpected" },
  ]) {
    const result = aggregateProviders([{ ...row, ...patch }], NOW, [row.provider]).providers[0];
    assert.equal(result.state, "UNKNOWN", JSON.stringify(patch));
    assert.equal(result.balance, null); assert.equal(result.reserved, null);
    assert.equal(result.availability, "UNVERIFIED");
  }
  assert.equal(aggregateProviders([{ ...row, available: 0, reserved: 0 }], NOW, [row.provider]).providers[0].state, "INSUFFICIENT");
});

test("capacity registry makes missing suppliers visible without fabricating balances or holds", async () => {
  const svc = service({ ...data, capacity: [{ ...data.capacity![0], checkedAt: NOW }], capacityProviders: ["elevenlabs", "veo", "heygen"] });
  const p = (await svc.section(owner, "providers", "7D")).data as ReturnType<typeof aggregateProviders>;
  assert.deepEqual(p.providers.map(r => [r.provider, r.state]), [["elevenlabs", "HEALTHY"], ["heygen", "UNKNOWN"], ["veo", "UNKNOWN"]]);
  for (const row of p.providers.slice(1)) { assert.equal(row.balance, null); assert.equal(row.reserved, null); assert.equal(row.checkedAt, null); }
  const ov = (await svc.section(owner, "overview", "7D")).data as { providers: typeof p; systemHealth: { providersUnknown: string[] } };
  assert.deepEqual(ov.providers, p); assert.deepEqual(ov.systemHealth.providersUnknown, ["heygen", "veo"]);
  const missing = (await service({ ...data, unavailable: ["capacityProviders"] }).section(owner, "providers", "7D")).data as typeof p;
  assert.equal(missing.state, "UNAVAILABLE");
});

test("an older healthy snapshot never hides the newest failed read; ISO offsets compare by time", () => {
  const row = { ...data.capacity![0], checkedAt: NOW };
  const failed = { ...row, available: null, reliability: "none" };
  const old = { ...row, checkedAt: "2026-10-30T13:58:00+02:00" };
  for (const rows of [[failed, old], [old, failed]]) {
    const p = aggregateProviders(rows, NOW, [row.provider]).providers[0];
    assert.equal(p.state, "UNKNOWN"); assert.equal(p.balance, null);
  }
});

test("unreconciled operations remain reserved, never become confirmed cost or a refund", async () => {
  const op = { ...data.paidOps![0], status: "RECONCILIATION_REQUIRED", reservedUsd: 0.195, committedUsd: null };
  const c = (await service({ ...data, costs: [], paidOps: [op] }).section(owner, "costs", "LIFETIME")).data as { reservedUsd: { value: number }; actualCogsUsd: { value: number } };
  assert.equal(c.reservedUsd.value, 0.2); assert.equal(c.actualCogsUsd.value, 0);
});
