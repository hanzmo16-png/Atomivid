import type { SupabaseClient } from "@supabase/supabase-js";
import { elevenLabsSnapshot } from "@/lib/production-intelligence/capacity/adapters";
import { assessCapacity } from "@/lib/production-intelligence/capacity/capacity";
import { heygenApiSnapshot } from "./heygen";
import { runwayApiSnapshot } from "./runway";
import { falApiSnapshot, falBillingKey } from "./fal";
import type { SupplyState } from "./policy";
import { billingAccountKey, billingAccountProviders, SUPPLY_REFRESH_INTERVAL_MS } from "./billing-account";

/** Alerts remain in the private owner/admin panel. No outbound messages or payment API. */
export async function monitorSupply(service: SupabaseClient, opts: {
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number;
} = {}): Promise<{ states: SupplyState[]; pendingAlerts: number }> {
  const env = opts.env ?? process.env, fetchImpl = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  const { data: policies, error } = await service.from("pi_supply_policies").select("provider,enabled").neq("provider", "__global__");
  if (error || !policies) throw new Error("SUPPLY_MONITOR_POLICIES_UNAVAILABLE");
  for (const provider of REFRESHABLE_PROVIDERS) {
    if (!policies.some(p => p.provider === provider && p.enabled)) continue;
    await refreshProviderSnapshot(service, provider, { env, fetchImpl, now });
  }
  // Unacknowledged alerts remain one incident, even across polling windows.
  const { data: existing, error: existingError } = await service.from("pi_supply_alerts").select("id,provider,level,payload").is("delivered_at", null).order("created_at").limit(1000);
  if (existingError || !existing || existing.length >= 1000) throw new Error("SUPPLY_MONITOR_OUTBOX_UNAVAILABLE");
  const incidents = new Set(existing.map(a => `${billingAccountKey(a.provider)}:${a.level}`));
  const states: SupplyState[] = [];
  for (const policy of policies as { provider: string; enabled: boolean }[]) {
    const { data, error: stateError } = await service.rpc("pi_supply_state", { p_provider: policy.provider });
    const state: SupplyState = stateError || !data ? { provider: policy.provider, level: "UNKNOWN", reason: "control unavailable", free: null, coverageHours: null, remainingRatio: null } : data as SupplyState;
    states.push(state);
    // Disabled suppliers are visible as UNKNOWN, but do not spam the owner about unused features.
    if (state.level === "GREEN" || !policy.enabled) continue;
    const bucketMs = state.level === "YELLOW" ? 3_600_000 : 900_000;
    const account = billingAccountKey(policy.provider);
    const incident = `${account}:${state.level}`;
    if (incidents.has(incident)) continue;
    const id = `${account}:${state.level}:${Math.floor(now() / bucketMs)}`;
    const { error: alertError } = await service.from("pi_supply_alerts").upsert({ id, provider: policy.provider, level: state.level, payload: state }, { onConflict: "id", ignoreDuplicates: true });
    if (alertError) throw new Error("SUPPLY_MONITOR_ALERT_UNAVAILABLE");
    incidents.add(incident);
  }
  const { data: pending, error: pendingError } = await service.from("pi_supply_alerts").select("id,provider,level,payload").is("delivered_at", null).order("created_at").limit(5);
  if (pendingError) throw new Error("SUPPLY_MONITOR_OUTBOX_UNAVAILABLE");
  return { states, pendingAlerts: pending?.length ?? 0 };
}

export const REFRESHABLE_PROVIDERS = ["elevenlabs", "runway", "heygen", "recraft", "flux"] as const;
export type RefreshableProvider = (typeof REFRESHABLE_PROVIDERS)[number];

/** Same-client coalescing is NOT a distributed reservation or a paid-admission lock. */
const refreshing = new WeakMap<SupabaseClient, Map<string, Promise<boolean>>>();
type RefreshOptions = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number };
type StoredObservation = {
  provider: string; unit: string; available: number | null; reserved: number; pending: number;
  renewal_date: string | null; health: string; reliability: string; status: string;
  checked_at: string; derived_estimate?: number | null;
};

/** Five-minute minimum polling interval, including a failed API observation. Fresh alias
 * observations retain their ORIGINAL timestamp; copying never makes evidence younger. */
export async function refreshProviderSnapshot(service: SupabaseClient, provider: RefreshableProvider, opts: RefreshOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const configured = provider === "elevenlabs" ? !!env.ELEVENLABS_API_KEY : provider === "runway" ? !!(env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET)
    : provider === "heygen" ? !!env.HEYGEN_API_KEY : !!falBillingKey(env);
  if (!configured) return false;
  let locks = refreshing.get(service);
  if (!locks) { locks = new Map(); refreshing.set(service, locks); }
  const key = billingAccountKey(provider), active = locks.get(key);
  if (active) { await active; return refreshProviderSnapshot(service, provider, opts); }
  const pending = refreshObservation(service, provider, opts);
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}

async function refreshObservation(service: SupabaseClient, provider: RefreshableProvider, opts: RefreshOptions): Promise<boolean> {
  const env = opts.env ?? process.env, request = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  const at = now(), aliases = [...billingAccountProviders(provider)];
  if (!Number.isFinite(at)) return false;
  const { data: observations, error: readError } = await service.from("pi_capacity_snapshots")
    .select("provider,unit,available,reserved,pending,renewal_date,health,reliability,status,checked_at,derived_estimate")
    .in("provider", aliases).in("reliability", ["provider_api", "none"]).order("checked_at", { ascending: false }).limit(1);
  if (readError || !observations) return false;
  const recent = observations[0] as StoredObservation | undefined;
  const age = recent ? at - Date.parse(recent.checked_at) : NaN;
  if (recent && Number.isFinite(age) && age >= 0 && age < SUPPLY_REFRESH_INTERVAL_MS) {
    if (recent.provider !== provider) {
      const { error } = await service.from("pi_capacity_snapshots").insert({ ...recent, provider });
      if (error) throw new Error("SUPPLY_MONITOR_SHARED_OBSERVATION_UNAVAILABLE");
    }
    return recent.reliability === "provider_api" && recent.available !== null;
  }
  const { data: backoffs, error: backoffError } = await service.from("pi_supply_alerts")
    .select("payload").in("provider", aliases).eq("level", "UNKNOWN").order("created_at", { ascending: false }).limit(100);
  if (backoffError || !backoffs || backoffs.length >= 100) return false;
  if (backoffs.some(a => a.payload?.reason === "billing_rate_limited" && Date.parse(a.payload?.rateLimitUntil) > at)) return false;
  let retryAt: string | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await request(url, init);
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      const target = Number.isFinite(seconds) ? at + seconds * 1000 : raw ? Date.parse(raw) : NaN;
      const retry = Number.isFinite(target) && target <= 8.64e15 ? Math.max(at + SUPPLY_REFRESH_INTERVAL_MS, target) : at + 86_400_000;
      retryAt = new Date(retry).toISOString();
    }
    return response;
  };
  // BEFORE the GET: a concurrent commit cannot be erased by its response.
  const checkedAt = new Date(at).toISOString();
  let row: Record<string, unknown>;
  if (provider === "elevenlabs") {
    if (!env.ELEVENLABS_API_KEY) return false;
    const snapshot = await elevenLabsSnapshot(fetchImpl, env, 0, 0, checkedAt);
    row = { provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0, renewal_date: snapshot.renewalDate,
      health: snapshot.health, reliability: snapshot.reliability, derived_estimate: snapshot.derivedEstimate ?? null, status: assessCapacity(snapshot).status, checked_at: checkedAt };
  } else if (provider === "runway") {
    if (!(env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET)) return false;
    const snapshot = await runwayApiSnapshot(fetchImpl, env, checkedAt);
    row = { provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0, renewal_date: null,
      health: snapshot.health, reliability: snapshot.reliability, status: assessCapacity(snapshot).status, checked_at: checkedAt };
  } else if (provider === "recraft" || provider === "flux") {
    // Same fal.ai account: the observation lookup above reuses one wallet reading for both aliases.
    if (!falBillingKey(env)) return false;
    const snapshot = await falApiSnapshot(fetchImpl, env, checkedAt, provider);
    row = { provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0, renewal_date: null,
      health: snapshot.health, reliability: snapshot.reliability, status: assessCapacity(snapshot).status, checked_at: checkedAt };
  } else {
    if (!env.HEYGEN_API_KEY) return false;
    const snapshot = await heygenApiSnapshot(fetchImpl, env, checkedAt);
    row = { provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0, renewal_date: null,
      health: snapshot.health, reliability: snapshot.reliability, status: assessCapacity(snapshot).status, checked_at: checkedAt };
  }
  if (retryAt) {
    const id = `sentinel-rate-limit:${billingAccountKey(provider)}:${retryAt}`;
    const { error } = await service.from("pi_supply_alerts").upsert({ id, provider, level: "UNKNOWN", payload: { provider, level: "UNKNOWN", reason: "billing_rate_limited", rateLimitUntil: retryAt } }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error("SUPPLY_MONITOR_BACKOFF_UNAVAILABLE");
  }
  const { error } = await service.from("pi_capacity_snapshots").insert(row);
  if (error) throw new Error(`SUPPLY_MONITOR_${provider.toUpperCase()}_SNAPSHOT_UNAVAILABLE`);
  return row.reliability === "provider_api" && row.available !== null;
}
