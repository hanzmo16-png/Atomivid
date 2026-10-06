/**
 * Pure, deterministic aggregation over source rows. A Metric carries its state: KNOWN (a real
 * number, including a real 0), UNKNOWN (the source answered but cannot tell) or UNAVAILABLE
 * (the source itself is missing/unreachable). Zeros are never fabricated for UNAVAILABLE.
 */
import type { CapacityRow, CostRow, FcDecisionRow, PaidOpRow, RequestRow, SubscriptionRow, YtChannelRow, YtLinkRow, YtRowLite } from "./sources";

export type MetricState = "KNOWN" | "UNKNOWN" | "UNAVAILABLE";
export type Metric = { value: number | null; state: MetricState; note?: string };
export const known = (value: number, note?: string): Metric => ({ value, state: "KNOWN", ...(note ? { note } : {}) });
export const unknown = (note: string): Metric => ({ value: null, state: "UNKNOWN", note });
export const unavailable = (note: string): Metric => ({ value: null, state: "UNAVAILABLE", note });
const r2 = (x: number) => Math.round(x * 100) / 100;

export const PRODUCTION_TYPES = ["reel", "long_form", "avatar", "tts_podcast", "unknown"] as const;
export type ProductionType = (typeof PRODUCTION_TYPES)[number];
export const productionType = (mode: string | null): ProductionType => (mode === "long_form" ? "long_form" : mode === "avatar" || mode === "hybrid" ? "avatar" : mode === "visual" ? "reel" : "unknown");

/** Unified job state over the legacy request statuses (video_requests) — no request is invented. */
export type JobState = "queued" | "running" | "completed" | "failed" | "other";
export const jobState = (status: string): JobState => (status === "pending" || status === "script_ready" ? "queued" : status === "processing" ? "running" : status === "completed" ? "completed" : status === "failed" ? "failed" : "other");

// ---------- customers ----------
export function aggregateCustomers(users: { total: number | null; newInRange: number | null; activeInRange: number | null }, subs: SubscriptionRow[] | null) {
  const m = (v: number | null, what: string) => (v === null ? unavailable(`${what}: auth user listing unavailable`) : known(v));
  const byStatus = subs ? Object.fromEntries([...new Set(subs.map((s) => s.status))].sort().map((st) => [st, subs.filter((s) => s.status === st).length])) : null;
  return {
    totalUsers: m(users.total, "total users"), newUsers: m(users.newInRange, "new users"), activeUsers: m(users.activeInRange, "active users"),
    subscriptions: subs ? known(subs.length) : unavailable("subscriptions table unavailable"),
    activeSubscriptions: subs ? known(subs.filter((s) => s.status === "active" || s.status === "trialing").length) : unavailable("subscriptions table unavailable"),
    subscriptionsByStatus: byStatus,
    // Revenue/MRR is NOT derived here: it needs Stripe truth (out of scope). The contract exists; the value is UNAVAILABLE.
    mrrUsd: unavailable("revenue requires Stripe reconciliation; not derived from price ids"),
  };
}

// ---------- production ----------
export function aggregateProduction(reqs: RequestRow[] | null, costs: CostRow[] | null, fc: FcDecisionRow[] | null, now: string) {
  if (!reqs) return { total: unavailable("video_requests unavailable"), byType: null, byState: null, averageProductionSec: unavailable("no requests"), retries: unavailable("no requests"), recoveries: unavailable("no requests"), finalCut: aggregateFinalCut(fc) };
  const byType = Object.fromEntries(PRODUCTION_TYPES.map((t) => [t, reqs.filter((r) => productionType(r.mode) === t).length]));
  const byState: Record<JobState, number> = { queued: 0, running: 0, completed: 0, failed: 0, other: 0 };
  for (const r of reqs) byState[jobState(r.status)]++;
  const costById = new Map((costs ?? []).map((c) => [c.requestId, c]));
  const renders = reqs.map((r) => costById.get(r.id)?.renderMs).filter((x): x is number => typeof x === "number" && x > 0);
  const retries = reqs.reduce((t, r) => t + Math.max(0, (r.renderAttempts ?? 1) - 1), 0);
  const recoveries = reqs.filter((r) => (r.renderAttempts ?? 0) > 1 && r.status === "completed").length;
  const stale = reqs.filter((r) => r.status === "processing" && r.renderStartedAt && Date.parse(now) - Date.parse(r.renderStartedAt) > 2 * 3600_000).length;
  return {
    total: known(reqs.length), byType, byState,
    averageProductionSec: renders.length ? known(r2(renders.reduce((a, b) => a + b, 0) / renders.length / 1000), `${renders.length} of ${reqs.length} requests have a render time`) : costs ? unknown("no request in range recorded a render time") : unavailable("generation_costs unavailable"),
    retries: known(retries), recoveries: known(recoveries), staleRunning: known(stale, "processing for more than 2 h"),
    finalCut: aggregateFinalCut(fc),
  };
}

export function aggregateFinalCut(fc: FcDecisionRow[] | null) {
  if (!fc) return { state: "UNAVAILABLE" as MetricState, pending: null, inspecting: null, repairRequired: null, humanReview: null, pass: null, fail: null, note: "fc_qa_decisions unavailable (migration 0027 not applied?)" };
  // Latest state per master decides its bucket.
  const latest = new Map<string, FcDecisionRow>();
  for (const d of [...fc].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))) latest.set(d.masterId, d);
  const count = (...states: string[]) => [...latest.values()].filter((d) => states.includes(d.toState)).length;
  return { state: "KNOWN" as MetricState, pending: count("EDITORIAL_PENDING"), inspecting: count("EDITORIAL_INSPECTING", "EDITORIAL_REINSPECTION"), repairRequired: count("EDITORIAL_REPAIR_REQUIRED", "EDITORIAL_REPAIRING"), humanReview: count("HUMAN_REVIEW_REQUIRED"), pass: count("EDITORIAL_QA_PASS"), fail: count("EDITORIAL_QA_FAIL"), note: `${latest.size} master(s) with editorial decisions in range` };
}

// ---------- costs ----------
export function aggregateCosts(reqs: RequestRow[] | null, costs: CostRow[] | null, ops: PaidOpRow[] | null) {
  const legacy = costs ?? [];
  const estimated = legacy.reduce((t, c) => t + (c.estimatedCostUsd ?? 0), 0);
  // Legacy COGS = provider consumption recorded per request (image + premium video + avatar). Top-ups are never here.
  const legacyActual = legacy.reduce((t, c) => t + (c.imageCostUsd ?? 0) + (c.premiumVideoCostUsd ?? 0) + (c.avatarCostUsd ?? 0), 0);
  const piCommitted = (ops ?? []).filter((o) => o.status === "COMMITTED").reduce((t, o) => t + (o.committedUsd ?? o.reservedUsd), 0);
  const piReserved = (ops ?? []).filter((o) => o.status === "RESERVED" || o.status === "SUBMITTED" || o.status === "PROVIDER_JOB_RECORDED" || o.status === "RECONCILIATION_REQUIRED").reduce((t, o) => t + o.reservedUsd, 0);
  const byProvider: Record<string, number> = {};
  const add = (p: string | null, usd: number | null) => { if (p && usd) byProvider[p] = r2((byProvider[p] ?? 0) + usd); };
  for (const c of legacy) { add(c.imageProvider, c.imageCostUsd); add(c.premiumVideoProvider, c.premiumVideoCostUsd); if (c.avatarCostUsd) add("avatar", c.avatarCostUsd); }
  for (const o of ops ?? []) if (o.status === "COMMITTED") add(o.provider, o.committedUsd ?? o.reservedUsd);
  const byMediaType = { image: r2(legacy.reduce((t, c) => t + (c.imageCostUsd ?? 0), 0)), video: r2(legacy.reduce((t, c) => t + (c.premiumVideoCostUsd ?? 0), 0) + (ops ?? []).filter((o) => o.status === "COMMITTED" && o.method.startsWith("I2V")).reduce((t, o) => t + (o.committedUsd ?? 0), 0)), avatar: r2(legacy.reduce((t, c) => t + (c.avatarCostUsd ?? 0), 0)), narration: unknown("narration consumption is metered in characters; USD not recorded per request") };
  const typeOf = new Map((reqs ?? []).map((r) => [r.id, productionType(r.mode)]));
  const perType: Record<string, { productions: number; cogsUsd: number }> = {};
  for (const c of legacy) { const t = typeOf.get(c.requestId) ?? "unknown"; const cur = perType[t] ?? { productions: 0, cogsUsd: 0 }; perType[t] = { productions: cur.productions + 1, cogsUsd: r2(cur.cogsUsd + (c.imageCostUsd ?? 0) + (c.premiumVideoCostUsd ?? 0) + (c.avatarCostUsd ?? 0)) }; }
  const avgByType = Object.fromEntries(Object.entries(perType).map(([t, v]) => [t, v.productions ? r2(v.cogsUsd / v.productions) : null]));
  return {
    estimatedUsd: costs ? known(r2(estimated)) : unavailable("generation_costs unavailable"),
    reservedUsd: ops ? known(r2(piReserved), "open PI reservations, including unresolved provider charges") : unavailable("pi_paid_operations unavailable (0023 not applied?)"),
    actualCogsUsd: costs || ops ? known(r2(legacyActual + piCommitted), "committed provider consumption only; top-ups excluded by construction") : unavailable("no cost source"),
    byProvider, byMediaType, averageCogsByProductionType: avgByType,
    costByProduction: legacy.map((c) => ({ requestId: c.requestId, type: typeOf.get(c.requestId) ?? "unknown", estimatedUsd: c.estimatedCostUsd, cogsUsd: r2((c.imageCostUsd ?? 0) + (c.premiumVideoCostUsd ?? 0) + (c.avatarCostUsd ?? 0)) })),
    note: "provider top-ups / account recharges are balance events, never COGS",
  };
}

// ---------- providers ----------
export type ProviderState = "HEALTHY" | "LIMITED" | "INSUFFICIENT" | "UNKNOWN";
export type ProviderCapacity = {
  provider: string; state: ProviderState; availability: string; balance: number | null;
  unit: string; reserved: number | null; queued: number | null;
  renewalDate: string | null; checkedAt: string | null; note: string;
};
/** Live API evidence only. Manual ledger estimates are shown in SupplyPanel. */
export const CAPACITY_MAX_AGE_MS = 300_000;
export function aggregateProviders(rows: CapacityRow[] | null, now: string, expectedProviders: string[] | null) {
  if (!rows || !expectedProviders) return { state: "UNAVAILABLE" as MetricState, providers: [] as ProviderCapacity[] };
  const latest = new Map<string, CapacityRow>();
  for (const r of rows) {
    const prior = latest.get(r.provider);
    // A malformed timestamp cannot silently resurrect an older healthy observation.
    if (!prior || !Number.isFinite(Date.parse(r.checkedAt)) || Date.parse(r.checkedAt) > Date.parse(prior.checkedAt)) latest.set(r.provider, r);
  }
  const providers = [...new Set([...expectedProviders, ...latest.keys()])].sort().map((provider): ProviderCapacity => {
    const r = latest.get(provider);
    if (!r) return { provider, state: "UNKNOWN", availability: "UNVERIFIED", balance: null, unit: "", reserved: null, queued: null, renewalDate: null, checkedAt: null, note: "No capacity snapshot recorded yet" };
    const age = Date.parse(now) - Date.parse(r.checkedAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= CAPACITY_MAX_AGE_MS;
    const valid = r.available !== null && Number.isFinite(r.available) && r.available >= 0
      && Number.isFinite(r.reserved) && r.reserved >= 0 && Number.isFinite(r.pending) && r.pending >= 0;
    const verified = fresh && valid && r.reliability === "provider_api";
    const state: ProviderState = !verified ? "UNKNOWN" : r.status === "RED" || r.available! <= r.reserved ? "INSUFFICIENT" : r.status === "GREEN" ? "HEALTHY" : r.status === "YELLOW" ? "LIMITED" : "UNKNOWN";
    const note = r.reliability === "manual_entry"
      ? "Saldo manual sin caducidad. Consulta el saldo estimado tras consumo y reservas en Suministro de producción; no es una lectura en vivo del proveedor."
      : !fresh ? `Balance needs refresh; last check: ${r.checkedAt}` : !valid ? "Provider balance unavailable: invalid quantities" : r.reliability !== "provider_api" ? `Provider balance unavailable: ${r.reliability} is not live API evidence` : state === "UNKNOWN" ? "Provider balance unavailable: status unverified" : "provider-reported balance";
    return { provider, state, availability: state === "UNKNOWN" ? "UNVERIFIED" : state === "INSUFFICIENT" ? "DOWN/INSUFFICIENT" : "UP",
      balance: verified ? r.available : null, unit: r.unit, reserved: verified ? r.reserved : null, queued: verified ? r.pending : null,
      renewalDate: r.renewalDate, checkedAt: r.checkedAt, note };
  });
  return { state: (providers.length ? "KNOWN" : "UNKNOWN") as MetricState, providers };
}

// ---------- youtube ----------
export function aggregateYouTube(channels: YtChannelRow[] | null, links: YtLinkRow[] | null, rows: YtRowLite[] | null, now: string) {
  if (!channels && !links && !rows) return { state: "UNAVAILABLE" as MetricState, channelsConnected: unavailable("yt tables unavailable"), videosLinked: unavailable("yt tables unavailable"), lastSuccessfulSync: null, freshnessHours: unavailable("no sync"), totals: null, trafficSources: null, retentionAvailable: false, videos: [] };
  const latestBy = (metric: string) => { const m = new Map<string, YtRowLite>(); for (const r of rows ?? []) if (r.metric === metric && r.dimensionValue === null && !r.dimensionLabel && (!m.has(r.videoId) || m.get(r.videoId)!.collectedAt < r.collectedAt || (m.get(r.videoId)!.collectedAt === r.collectedAt && m.get(r.videoId)!.windowEnd < r.windowEnd))) m.set(r.videoId, r); return m; };
  const sum = (metric: string) => { const m = latestBy(metric); return m.size ? known(r2([...m.values()].reduce((t, r) => t + r.value, 0)), `${m.size} video(s)`) : rows ? unknown("no observation yet") : unavailable("yt_metric_rows unavailable"); };
  const avg = (metric: string) => { const m = latestBy(metric); return m.size ? known(r2([...m.values()].reduce((t, r) => t + r.value, 0) / m.size), `mean over ${m.size} video(s)`) : rows ? unknown("no observation yet") : unavailable("yt_metric_rows unavailable"); };
  const last = (rows ?? []).reduce<string | null>((b, r) => (!b || r.collectedAt > b ? r.collectedAt : b), null);
  const traffic: Record<string, number> = {};
  for (const r of rows ?? []) if (r.metric === "views" && r.dimensionLabel) traffic[r.dimensionLabel] = r2((traffic[r.dimensionLabel] ?? 0) + r.value);
  const videos = (links ?? []).map((l) => ({ productionId: l.projectId, channelId: l.channelId, videoId: l.videoId, publishedAt: l.publishedAt, views: latestBy("views").get(l.videoId)?.value ?? null, averagePercentageViewed: latestBy("averagePercentageViewed").get(l.videoId)?.value ?? null }));
  return {
    state: "KNOWN" as MetricState,
    channelsConnected: channels ? known(channels.filter((c) => c.status === "connected").length) : unavailable("yt_channels unavailable"),
    videosLinked: links ? known(links.length) : unavailable("yt_video_links unavailable"),
    lastSuccessfulSync: last,
    freshnessHours: last ? known(r2((Date.parse(now) - Date.parse(last)) / 3600_000)) : unknown("never synced"),
    totals: { views: sum("views"), watchTimeMinutes: sum("watchTimeMinutes"), averageViewDurationSeconds: avg("averageViewDurationSeconds"), averagePercentageViewed: avg("averagePercentageViewed"), subscribersGained: sum("subscribersGained"), subscribersLost: sum("subscribersLost") },
    trafficSources: Object.keys(traffic).length ? traffic : null,
    retentionAvailable: (rows ?? []).some((r) => r.metric === "audienceWatchRatio"),
    videos,
  };
}

// ---------- system health ----------
export function aggregateSystemHealth(parts: { production: ReturnType<typeof aggregateProduction>; providers: ReturnType<typeof aggregateProviders>; youtube: ReturnType<typeof aggregateYouTube>; flags: { autoPublish: false; finalCutEnabled: boolean } }) {
  const sources = { requests: parts.production.total.state, providers: parts.providers.state, youtube: parts.youtube.state };
  const unavailableSources = Object.entries(sources).filter(([, s]) => s === "UNAVAILABLE").map(([k]) => k);
  return { sources, unavailableSources, staleRunningJobs: parts.production.staleRunning ?? unknown("no requests"), providersUnknown: parts.providers.providers.filter((p) => p.state === "UNKNOWN").map((p) => p.provider), providersInsufficient: parts.providers.providers.filter((p) => p.state === "INSUFFICIENT").map((p) => p.provider), autoPublish: parts.flags.autoPublish, finalCutGate: parts.flags.finalCutEnabled ? "ACTIVE" : "DISABLED" };
}
