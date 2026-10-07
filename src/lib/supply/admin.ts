import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupplyState } from "./policy";

/** Caller must verify OWNER/ADMIN first. No provider request or payment is made. */
export async function readSupplyOverview(service: SupabaseClient): Promise<{ states: SupplyState[]; pendingAlerts: number | null; queued: number | null; limits: { provider: string; dailyUsd: number; monthlyUsd: number; enabled: boolean }[] }> {
  const [policies, alerts, queue] = await Promise.all([
    service.from("pi_supply_policies").select("provider,enabled,daily_cap_usd,monthly_cap_usd").neq("provider", "__global__"),
    service.from("pi_supply_alerts").select("id", { head: true, count: "exact" }),
    service.from("video_requests").select("id", { head: true, count: "exact" }).eq("status", "processing").not("supply_wait_started_at", "is", null),
  ]);
  if (policies.error) throw new Error("SUPPLY_OVERVIEW_UNAVAILABLE");
  const states = await Promise.all((policies.data ?? []).map(async p => {
    const { data, error } = await service.rpc("pi_supply_state", { p_provider: p.provider });
    return error || !data ? { provider: p.provider, level: "UNKNOWN", free: null, remainingRatio: null, coverageHours: null, reason: "control unavailable" } as SupplyState : data as SupplyState;
  }));
  return { states, limits: (policies.data ?? []).map(p => ({ provider: p.provider, enabled: p.enabled, dailyUsd: Number(p.daily_cap_usd), monthlyUsd: Number(p.monthly_cap_usd) })), pendingAlerts: alerts.error ? null : alerts.count, queued: queue.error ? null : queue.count };
}
