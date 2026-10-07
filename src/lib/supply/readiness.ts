import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobSupplyDemand } from "./job";
import { REFRESHABLE_PROVIDERS, refreshProviderSnapshot, type RefreshableProvider } from "./monitor";

/** Readiness of one production's supply, shared by the real start click and the
 * preflight. It applies the admission rule of pi_reserve_job_supply to the same
 * inputs (pi_supply_state, units conversion, provider and global spend ceilings).
 * Stale or unverified balances of THIS production's providers are refreshed just
 * in time with the official billing observation (GET only, never generation);
 * the 5-minute freshness rule itself is unchanged and still enforced in SQL.
 * Anything not provable stays fail-closed. It never reserves anything. */
/** Accurate for the start click: refused before any state change, reservation or charge. */
export const START_SUPPLY_UNAVAILABLE = "No pudimos confirmar en este momento la capacidad de los proveedores. No se inició la producción ni se generó ningún cargo; tu solicitud sigue lista y puedes volver a intentarlo en unos minutos.";
export type ProviderReadiness = { provider: string; refreshed: boolean; level: string | null; reason: string | null; free: number | null; units: number | null; usd: number; ok: boolean; failure?: string };
export type SupplyReadiness = { ready: boolean; providers: ProviderReadiness[]; failure?: { provider: string; reason: string } };
type Policy = { provider: string; enabled: boolean; unit: string; unit_cost_usd: number; daily_cap_usd: number; monthly_cap_usd: number; timezone: string; evidence?: string };
type State = { level?: string; reason?: string; free?: number | null };

/** Local midnight / first-of-month in the policy timezone, as an absolute instant. */
export function periodStart(timeZone: string, period: "day" | "month", now: Date): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const offsetMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year, parts.month - 1, period === "day" ? parts.day : 1) - offsetMs);
}

function demandUnits(d: JobSupplyDemand, p: Policy): number | null {
  if (d.unit === "character" && p.unit === "character") return d.units;
  if (d.unit === "usd" && p.unit === "usd") return d.usd;
  if (d.unit === "usd" && p.unit === "credit" && p.unit_cost_usd > 0) return d.usd / p.unit_cost_usd;
  return null;
}

export async function ensureJobSupplyReady(service: SupabaseClient, demands: JobSupplyDemand[], opts: {
  refresh?: boolean; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number;
} = {}): Promise<SupplyReadiness> {
  const now = opts.now ?? Date.now, refresh = opts.refresh ?? true;
  const providers = [...new Set(demands.map(d => d.provider))].sort();
  const { data: policyRows, error } = await service.from("pi_supply_policies").select("provider,enabled,unit,unit_cost_usd,daily_cap_usd,monthly_cap_usd,timezone,evidence")
    .in("provider", ["__global__", ...providers]);
  if (error || !policyRows) return { ready: false, providers: [], failure: { provider: "production", reason: "supply policies unavailable" } };
  const policies = new Map((policyRows as Policy[]).map(p => [p.provider, p]));
  const state = async (provider: string): Promise<State> => {
    const { data, error: stateError } = await service.rpc("pi_supply_state", { p_provider: provider });
    return stateError || !data ? { level: "UNKNOWN", reason: "control unavailable", free: null } : data as State;
  };
  const spend = async (provider: string | null, start: Date) => {
    const { data, error: spendError } = await service.rpc("pi_supply_spend", { p_provider: provider, p_start: start.toISOString() });
    if (spendError || data === null || data === undefined) return null;
    return Number(data);
  };
  const out: ProviderReadiness[] = [];
  let totalUsd = 0;
  for (const provider of providers) {
    const d = demands.find(x => x.provider === provider)!;
    const p = policies.get(provider);
    const row: ProviderReadiness = { provider, refreshed: false, level: null, reason: null, free: null, units: null, usd: d.usd, ok: false };
    out.push(row);
    if (!p) { row.failure = "supplier unconfigured"; continue; }
    row.units = demandUnits(d, p);
    if (row.units === null || !(row.units > 0) || !(d.usd > 0)) { row.failure = "invalid demand"; continue; }
    let s = await state(provider);
    // Only an unverified/stale reading is refreshed; RED stays RED.
    if (s.level === "UNKNOWN" && refresh && p.enabled && (REFRESHABLE_PROVIDERS as readonly string[]).includes(provider)) {
      try { row.refreshed = await refreshProviderSnapshot(service, provider as RefreshableProvider, opts); }
      catch { row.refreshed = false; }
      s = await state(provider);
    }
    row.level = s.level ?? "UNKNOWN"; row.reason = s.reason ?? null; row.free = typeof s.free === "number" ? s.free : null;
    if (row.level === "RED" || row.level === "UNKNOWN" || row.free === null || row.units > row.free) { row.failure = "supplier balance unavailable"; continue; }
    const tz = p.timezone || "America/Cancun", at = new Date(now());
    const day = await spend(provider, periodStart(tz, "day", at)), month = await spend(provider, periodStart(tz, "month", at));
    if (day === null || month === null) { row.failure = "spend unavailable"; continue; }
    if (day + d.usd > p.daily_cap_usd || month + d.usd > p.monthly_cap_usd) { row.failure = "provider funded spend ceiling"; continue; }
    row.ok = true;
    totalUsd += d.usd;
  }
  const failed = out.find(r => !r.ok);
  if (failed) return { ready: false, providers: out, failure: { provider: failed.provider, reason: failed.failure ?? "unavailable" } };
  const g = policies.get("__global__");
  if (!g || !g.enabled || !(g.daily_cap_usd > 0) || !(g.monthly_cap_usd > 0) || !String(g.evidence ?? "").trim())
    return { ready: false, providers: out, failure: { provider: "production", reason: "funded global budget unconfigured" } };
  const at = new Date(now()), tz = g.timezone || "America/Cancun";
  const gDay = await spend(null, periodStart(tz, "day", at)), gMonth = await spend(null, periodStart(tz, "month", at));
  if (gDay === null || gMonth === null || gDay + totalUsd > g.daily_cap_usd || gMonth + totalUsd > g.monthly_cap_usd)
    return { ready: false, providers: out, failure: { provider: "production", reason: "global funded spend ceiling" } };
  return { ready: true, providers: out };
}
