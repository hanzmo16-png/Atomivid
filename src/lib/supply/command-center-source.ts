import type { SupabaseClient } from "@supabase/supabase-js";
import { requireCommandCenterAdmin, type AuthUser } from "@/lib/command-center/access";
import { readResourceSentinel } from "./sentinel-server";

type EngineObservation = Pick<Awaited<ReturnType<typeof readResourceSentinel>>, "sentinel" | "observedAt" | "timezones">;
/** Structural implementation of Claude PR337's resource-sentinel/1 contract.
 * Mapping only: no alternate financial calculation, balance TTL or UI fallback. */
export function commandCenterSentinelSnapshot(data: EngineObservation) {
  const oneTimezone = data.timezones.length === 1;
  const errors = [...new Set(data.sentinel.accounts.filter(a => a.auditStatus !== "VERIFIED_LEDGER_ADJUSTMENT" && a.auditStatus !== "UNIT_CONSUMPTION_ESTIMATED").map(a => a.auditStatus))];
  if (!oneTimezone) errors.push("MIXED_OR_UNVERIFIED_POLICY_TIMEZONES");
  return {
    version: "resource-sentinel/1" as const, generatedAt: data.observedAt, timezone: oneTimezone ? data.timezones[0] : "UTC",
    source: "sentinel-engine" as const,
    providers: data.sentinel.accounts.map(a => ({
      provider: a.account, aliases: a.providers, unit: a.unit,
      balance: { status: a.balanceStatus, value: a.available, estimated: a.estimatedAvailable, staleValue: a.staleAvailable, checkedAt: a.checkedAt, source: a.balanceStatus === "REAL" || a.balanceStatus === "STALE" ? "provider_api" as const : null,
        health: null },
      committedUsd: a.unit === "usd" ? a.held : null, openOperations: null,
      free: a.free,
      consumptionUsd: { day: oneTimezone ? a.consumption.daily.actualUsd : null, week: oneTimezone ? a.consumption.rolling7d.actualUsd : null, month: oneTimezone ? a.consumption.monthly.actualUsd : null },
      autonomy: { days: a.forecast.coverageDays, basis: a.forecast.coverageDays === null ? null : "engine" as const },
      level: a.operationalLevel === "AMBER" ? "YELLOW" as const : a.operationalLevel === "GRAY" ? "UNKNOWN" as const : a.operationalLevel === "GREEN" ? "GREEN" as const : a.operationalLevel === "RED" ? "RED" as const : "UNKNOWN" as const,
      reason: a.auditStatus, limits: null, recentAlerts: null,
      // Optional engine evidence: older UI safely ignores it instead of promoting estimates to cash.
      evidence: { kind: a.balanceStatus, estimatedValue: a.estimatedAvailable, staleValue: a.staleAvailable, aliases: a.providers, forecast: a.forecast },
    })), errors,
  };
}

/** Caller can plug this into SentinelSource.read() without changing Claude's components. */
export function commandCenterSentinelSource(deps: { user: AuthUser; service: () => SupabaseClient; env?: Record<string, string | undefined>; now?: () => number }) {
  return { async read() {
    requireCommandCenterAdmin(deps.user, deps.env);
    return commandCenterSentinelSnapshot(await readResourceSentinel(deps.service(), deps.now?.()));
  } };
}
