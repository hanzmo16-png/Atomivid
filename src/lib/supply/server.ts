import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaidOperation } from "@/lib/production-intelligence/ledger";
import { isProductionRuntime } from "@/lib/providers/production";
import { SupplyUnavailableError } from "./policy";
import { isRecoveryBudgetRefusal, RecoveryBudgetExceededError } from "./recovery-budget";
import { REFRESHABLE_PROVIDERS, refreshProviderSnapshot, type RefreshableProvider } from "./monitor";
import { JobEnvelopeMismatchError } from "./job";

/** Explicit opt-in locally; mandatory in production. There is no production bypass flag. */
export function supplyGuardRequired(): boolean {
  return isProductionRuntime() || process.env.SUPPLY_GUARD_ENFORCED === "true";
}
/** The balance reason pi_supply_state gives when the last provider reading is older than its 5-minute validity. */
const STALE_BALANCE = "balance unverified or stale";

export async function submitWithSupply(service: SupabaseClient, op: PaidOperation, deps: { refresh?: typeof refreshProviderSnapshot } = {}): Promise<boolean> {
  // An omitted/zero cost is not proof that a paid image, video or music call is free.
  // Exact prepaid character demand can still be checked independently of a cash estimate.
  if (!(Number.isFinite(op.reservedUsd) && op.reservedUsd > 0)
    && !(Number.isFinite(op.capacityUnits) && (op.capacityUnits ?? 0) > 0))
    throw new SupplyUnavailableError(op.provider, "paid cost and units unverified");
  const submit = async () => {
    const { data, error } = await service.rpc("pi_submit_with_supply", { p_key: op.idempotencyKey, p_units: op.capacityUnits ?? null });
    if (error || !data || typeof data !== "object") throw new SupplyUnavailableError(op.provider, "control unavailable");
    return data as { submitted?: boolean; reason?: string; capUsd?: unknown; committedUsd?: unknown; pendingUsd?: unknown; requestedUsd?: unknown };
  };
  let result = await submit();
  // Just-in-time balance (same rule as the start click): a worker reaching its paid call after the
  // 5-minute validity re-reads the provider's balance ONCE (billing GET only) and the atomic check runs
  // again. Nothing was sent to the provider yet; the row stays RESERVED. The validity is not extended
  // and an unverifiable balance still refuses.
  if (!result.submitted && result.reason === STALE_BALANCE && (REFRESHABLE_PROVIDERS as readonly string[]).includes(op.provider)) {
    const refreshed = await (deps.refresh ?? refreshProviderSnapshot)(service, op.provider as RefreshableProvider).catch(() => false);
    if (refreshed) result = await submit();
  }
  if (result.reason === "already_claimed") return false;
  // A job's recovery budget refused this call (atomically, before the provider): terminal, never "wait for supply".
  if (!result.submitted && isRecoveryBudgetRefusal(result.reason)) throw new RecoveryBudgetExceededError(result as { reason: string });
  // The attempt's envelope cannot cover this call (worker sized it above what the start reserved, or the
  // job already consumed it). Waiting never fixes it: fail clearly instead of queueing forever.
  if (!result.submitted && result.reason === "job envelope exhausted") throw new JobEnvelopeMismatchError(op.provider);
  if (!result.submitted) throw new SupplyUnavailableError(op.provider, result.reason ?? "unverified supply");
  return true;
}

/** Read-only check before the render CAS; an unavailable supplier must not spend a render attempt. */
export async function assertSupplyPreflight(service: SupabaseClient, providers: string[]): Promise<void> {
  if (!supplyGuardRequired()) return;
  for (const provider of [...new Set(providers)].filter(p => p !== "fixture" && p !== "curated-library")) {
    const { data, error } = await service.rpc("pi_supply_state", { p_provider: provider });
    const state = data as { level?: string; reason?: string } | null;
    if (error || !state || state.level === "UNKNOWN" || state.level === "RED")
      throw new SupplyUnavailableError(provider, state?.reason ?? "control unavailable");
  }
}
