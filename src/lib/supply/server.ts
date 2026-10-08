import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaidOperation } from "@/lib/production-intelligence/ledger";
import { isProductionRuntime } from "@/lib/providers/production";
import { SupplyUnavailableError } from "./policy";
import { isRecoveryBudgetRefusal, RecoveryBudgetExceededError } from "./recovery-budget";

/** Explicit opt-in locally; mandatory in production. There is no production bypass flag. */
export function supplyGuardRequired(): boolean {
  return isProductionRuntime() || process.env.SUPPLY_GUARD_ENFORCED === "true";
}
export async function submitWithSupply(service: SupabaseClient, op: PaidOperation): Promise<boolean> {
  // An omitted/zero cost is not proof that a paid image, video or music call is free.
  // Exact prepaid character demand can still be checked independently of a cash estimate.
  if (!(Number.isFinite(op.reservedUsd) && op.reservedUsd > 0)
    && !(Number.isFinite(op.capacityUnits) && (op.capacityUnits ?? 0) > 0))
    throw new SupplyUnavailableError(op.provider, "paid cost and units unverified");
  const { data, error } = await service.rpc("pi_submit_with_supply", { p_key: op.idempotencyKey, p_units: op.capacityUnits ?? null });
  if (error || !data || typeof data !== "object") throw new SupplyUnavailableError(op.provider, "control unavailable");
  const result = data as { submitted?: boolean; reason?: string; capUsd?: unknown; committedUsd?: unknown; pendingUsd?: unknown; requestedUsd?: unknown };
  if (result.reason === "already_claimed") return false;
  // A job's recovery budget refused this call (atomically, before the provider): terminal, never "wait for supply".
  if (!result.submitted && isRecoveryBudgetRefusal(result.reason)) throw new RecoveryBudgetExceededError(result as { reason: string });
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
