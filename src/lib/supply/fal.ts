import type { CapacitySnapshot } from "@/lib/production-intelligence/capacity/capacity";

/** Official fal Platform API GET /v1/account/billing?expand=credits (docs: fal.ai/docs/platform-apis/v1/account/billing,
 * checked 2026-10-21 through search; the container cannot reach fal.ai). Needs an ADMIN-scoped key: an API-scoped
 * FAL_KEY is refused (401/403) and the reading stays unverified. Only `credits.current_balance` in USD is spendable
 * supply; any other shape, currency or error is NOT a balance. The key is read at call time and never logged.
 * Supply ledger name is "recraft" (the provider of pi_supply_policies / pi_paid_operations for these images). */
export async function falApiSnapshot(request: typeof fetch, env: Record<string, string | undefined>, checkedAt: string): Promise<CapacitySnapshot> {
  const base: CapacitySnapshot = { provider: "recraft", accountLabel: "ATOMIVID fal.ai account", unit: "usd", available: null,
    reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: checkedAt, health: "UNCHECKED", reliability: "none" };
  const key = falBillingKey(env);
  if (!key) return base;
  try {
    const response = await request("https://api.fal.ai/v1/account/billing?expand=credits", { method: "GET", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(10_000), headers: { Authorization: `Key ${key}`, Accept: "application/json" } });
    if (!response.ok) return { ...base, health: response.status >= 500 ? "DEGRADED" : "DOWN" };
    const value = await response.json() as { credits?: { current_balance?: unknown; currency?: unknown } };
    const balance = value.credits?.current_balance, currency = String(value.credits?.currency ?? "").toUpperCase();
    if (currency !== "USD" || typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) return { ...base, health: "DEGRADED" };
    return { ...base, available: balance, health: "OK", reliability: "provider_api" };
  } catch { return { ...base, health: "DEGRADED" }; }
}

/** Only an explicitly configured Admin-scoped key reads billing. A regular (API-scoped) FAL_KEY is refused by the
 * billing endpoint; using it would store a DOWN reading every time and hide a valid manual balance entry, so without
 * FAL_ADMIN_KEY nothing is read or stored. */
export function falBillingKey(env: Record<string, string | undefined>): string | null {
  return env.FAL_ADMIN_KEY?.trim() || null;
}
