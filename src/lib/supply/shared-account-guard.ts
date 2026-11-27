import type { SupabaseClient } from "@supabase/supabase-js";
import { SupplyUnavailableError } from "./policy";
import { billingAccountProviders } from "./billing-account";

/** Both adapters debit the same Fal wallet. Per-provider SQL admission does not pool these aliases. */
export const SHARED_FAL_ALIASES = Object.freeze([...billingAccountProviders("flux")]);

export async function readSharedAccountPolicies(service: SupabaseClient): Promise<unknown> {
  const { data, error, count } = await service.from("pi_supply_policies").select("provider,enabled", { count: "exact" }).in("provider", [...SHARED_FAL_ALIASES]);
  // A successful but truncated response cannot prove that the peer policy is absent.
  if (error || !Array.isArray(data) || typeof count !== "number" || !Number.isSafeInteger(count) || count !== data.length || count > SHARED_FAL_ALIASES.length)
    throw new Error("shared_account_policy_read_failed");
  return data;
}

/**
 * Conservative refusal, not an atomic shared-wallet balance check. There is currently no verified
 * authoritative account-pool admission capability in this repository. A JS sum, cached balance, or
 * environment flag cannot supply that capability. Enabling both aliases therefore pauses NEW sends;
 * existing durable paid results/jobs continue through their normal ledger replay paths.
 * BLOCKED: synchronizing administrative policy flips with submission requires atomic SQL pool
 * support. This preflight does not make that race atomic, and no such capability is asserted here.
 */
export async function assertSharedAccountAdmission(service: SupabaseClient, provider: string): Promise<void> {
  if (!(SHARED_FAL_ALIASES as readonly string[]).includes(provider)) return;
  let rows: unknown;
  try { rows = await readSharedAccountPolicies(service); }
  catch { throw new SupplyUnavailableError(provider, "shared account policy unavailable"); }
  if (!Array.isArray(rows) || rows.length > SHARED_FAL_ALIASES.length)
    throw new SupplyUnavailableError(provider, "shared account policy unverified");
  const enabled = new Map<string, boolean>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !(SHARED_FAL_ALIASES as readonly unknown[]).includes(row.provider)
      || typeof row.enabled !== "boolean" || enabled.has(row.provider))
      throw new SupplyUnavailableError(provider, "shared account policy unverified");
    enabled.set(row.provider, row.enabled);
  }
  if (!enabled.has(provider)) throw new SupplyUnavailableError(provider, "shared account policy unverified");
  // Missing peer in this exhaustive successful read means unconfigured, not a read error.
  // pi_supply_state returns UNKNOWN for an absent policy; SQL submit refuses it before SUBMITTED.
  if (SHARED_FAL_ALIASES.every(alias => enabled.get(alias) === true))
    throw new SupplyUnavailableError(provider, "shared account atomic admission unverified");
  // The existing RPC still enforces whether THIS alias is enabled, its limits and claim ownership.
}
