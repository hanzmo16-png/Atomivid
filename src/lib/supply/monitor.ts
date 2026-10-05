import type { SupabaseClient } from "@supabase/supabase-js";
import { elevenLabsSnapshot } from "@/lib/production-intelligence/capacity/adapters";
import { assessCapacity } from "@/lib/production-intelligence/capacity/capacity";
import { heygenApiSnapshot } from "./heygen";
import { runwayApiSnapshot } from "./runway";
import type { SupplyState } from "./policy";

/** Alerts remain in the private owner/admin panel. No outbound messages or payment API. */
export async function monitorSupply(service: SupabaseClient, opts: {
  env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number;
} = {}): Promise<{ states: SupplyState[]; pendingAlerts: number }> {
  const env = opts.env ?? process.env, fetchImpl = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  const { data: policies, error } = await service.from("pi_supply_policies").select("provider,enabled").neq("provider", "__global__");
  if (error || !policies) throw new Error("SUPPLY_MONITOR_POLICIES_UNAVAILABLE");
  if (env.ELEVENLABS_API_KEY) {
    // Timestamp is BEFORE the GET: a concurrent commit cannot be erased by its response.
    const checkedAt = new Date(now()).toISOString();
    const snapshot = await elevenLabsSnapshot(fetchImpl, env, 0, 0, checkedAt);
    const { error: savedError } = await service.from("pi_capacity_snapshots").insert({
      provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available,
      reserved: 0, pending: 0, renewal_date: snapshot.renewalDate, health: snapshot.health,
      reliability: snapshot.reliability, derived_estimate: snapshot.derivedEstimate ?? null,
      status: assessCapacity(snapshot).status, checked_at: checkedAt,
    });
    if (savedError) throw new Error("SUPPLY_MONITOR_SNAPSHOT_UNAVAILABLE");
  }
  if ((env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET) && policies.some(p => p.provider === "runway" && p.enabled)) {
    const checkedAt = new Date(now()).toISOString();
    const snapshot = await runwayApiSnapshot(fetchImpl, env, checkedAt);
    const { error: savedError } = await service.from("pi_capacity_snapshots").insert({
      provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0,
      renewal_date: null, health: snapshot.health, reliability: snapshot.reliability,
      status: assessCapacity(snapshot).status, checked_at: checkedAt,
    });
    if (savedError) throw new Error("SUPPLY_MONITOR_RUNWAY_SNAPSHOT_UNAVAILABLE");
  }
  if (env.HEYGEN_API_KEY && policies.some(p => p.provider === "heygen" && p.enabled)) {
    const checkedAt = new Date(now()).toISOString();
    const snapshot = await heygenApiSnapshot(fetchImpl, env, checkedAt);
    const { error: savedError } = await service.from("pi_capacity_snapshots").insert({
      provider: snapshot.provider, unit: snapshot.unit, available: snapshot.available, reserved: 0, pending: 0,
      renewal_date: null, health: snapshot.health, reliability: snapshot.reliability,
      status: assessCapacity(snapshot).status, checked_at: checkedAt,
    });
    if (savedError) throw new Error("SUPPLY_MONITOR_HEYGEN_SNAPSHOT_UNAVAILABLE");
  }
  const states: SupplyState[] = [];
  for (const policy of policies as { provider: string; enabled: boolean }[]) {
    const { data, error: stateError } = await service.rpc("pi_supply_state", { p_provider: policy.provider });
    const state: SupplyState = stateError || !data ? { provider: policy.provider, level: "UNKNOWN", reason: "control unavailable", free: null, coverageHours: null, remainingRatio: null } : data as SupplyState;
    states.push(state);
    // Disabled suppliers are visible as UNKNOWN, but do not spam the owner about unused features.
    if (state.level === "GREEN" || !policy.enabled) continue;
    const bucketMs = state.level === "YELLOW" ? 3_600_000 : 900_000;
    const id = `${policy.provider}:${state.level}:${Math.floor(now() / bucketMs)}`;
    const { error: alertError } = await service.from("pi_supply_alerts").upsert({ id, provider: policy.provider, level: state.level, payload: state }, { onConflict: "id", ignoreDuplicates: true });
    if (alertError) throw new Error("SUPPLY_MONITOR_ALERT_UNAVAILABLE");
  }
  const { data: pending, error: pendingError } = await service.from("pi_supply_alerts").select("id,provider,level,payload").is("delivered_at", null).order("created_at").limit(5);
  if (pendingError) throw new Error("SUPPLY_MONITOR_OUTBOX_UNAVAILABLE");
  return { states, pendingAlerts: pending?.length ?? 0 };
}
