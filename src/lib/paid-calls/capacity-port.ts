/**
 * Provider balance port (PI V2 Fase B2, RB-02). The admission hold never calls a provider: it
 * reads a balance through this port. UNKNOWN or a thrown read means NO job starts (fail closed).
 *
 * The real implementation reads the newest `pi_capacity_snapshots` row (migration 0023) for the
 * provider. A snapshot counts only when its status is GREEN or YELLOW, it carries a balance from
 * the provider API or a manual entry (the 0023 CHECK already forbids GREEN without one) and it is
 * fresh. Writing snapshots is outside this phase (no monitor, no provider call).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProviderBalance =
  | { known: true; provider: string; available: number; unit: string; checkedAt: string }
  | { known: false; provider: string; reason: string };

export interface ProviderBalancePort {
  read(provider: string): Promise<ProviderBalance>;
}

export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

type SnapshotRow = { provider: string; unit: string; available: number | string | null; status: string; reliability: string; checked_at: string };

export function snapshotBalancePort(supabase: SupabaseClient, opts: { maxAgeMs?: number; now?: () => number } = {}): ProviderBalancePort {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  return {
    async read(provider) {
      const { data, error } = await supabase
        .from("pi_capacity_snapshots")
        .select("provider,unit,available,status,reliability,checked_at")
        .eq("provider", provider)
        .order("checked_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`pi_capacity_snapshots read failed (${error.code ?? "?"}): ${error.message}`);
      const row = data as SnapshotRow | null;
      if (!row) return { known: false, provider, reason: "no capacity snapshot for this provider" };
      if (row.status !== "GREEN" && row.status !== "YELLOW") return { known: false, provider, reason: `snapshot status ${row.status}` };
      if (row.available === null || row.available === undefined) return { known: false, provider, reason: "snapshot has no balance" };
      if (row.reliability !== "provider_api" && row.reliability !== "manual_entry") return { known: false, provider, reason: `snapshot reliability ${row.reliability}` };
      const age = now() - Date.parse(row.checked_at);
      if (!(age >= 0 && age <= maxAgeMs)) return { known: false, provider, reason: `snapshot is ${Math.round(age / 60000)} min old (max ${Math.round(maxAgeMs / 60000)})` };
      const available = Number(row.available);
      if (!Number.isFinite(available) || available < 0) return { known: false, provider, reason: "snapshot balance is invalid" };
      return { known: true, provider, available, unit: row.unit, checkedAt: row.checked_at };
    },
  };
}

/** Test double: fixed balances per provider; a provider absent from the map is UNKNOWN. */
export function fakeBalancePort(balances: Record<string, { available: number; unit?: string; checkedAt?: string }>): ProviderBalancePort {
  return {
    async read(provider) {
      const b = balances[provider];
      if (!b) return { known: false, provider, reason: "no balance configured" };
      return { known: true, provider, available: b.available, unit: b.unit ?? "character", checkedAt: b.checkedAt ?? "1970-01-01T00:00:00.000Z" };
    },
  };
}
