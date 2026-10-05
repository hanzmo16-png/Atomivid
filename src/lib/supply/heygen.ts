import type { CapacitySnapshot } from "@/lib/production-intelligence/capacity/capacity";

/** Official GET /v3/users/me, verified 2026-10-05, user-profile.md.
 * Only an explicit prepaid API wallet is spendable supply. Subscription pools and
 * usage-based spending ceilings are NOT treated as a funded wallet. Identities are discarded. */
export async function heygenApiSnapshot(request: typeof fetch, env: Record<string, string | undefined>, checkedAt: string): Promise<CapacitySnapshot> {
  const base: CapacitySnapshot = { provider: "heygen", accountLabel: "ATOMIVID production API key", unit: "usd", available: null,
    reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: checkedAt, health: "UNCHECKED", reliability: "none" };
  if (!env.HEYGEN_API_KEY) return base;
  try {
    const response = await request("https://api.heygen.com/v3/users/me", { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "X-Api-Key": env.HEYGEN_API_KEY } });
    if (!response.ok) return { ...base, health: response.status >= 500 ? "DEGRADED" : "DOWN" };
    const value = await response.json() as { data?: { billing_type?: string; wallet?: { currency?: string; remaining_balance?: number } } };
    const wallet = value.data?.wallet;
    if (value.data?.billing_type !== "wallet" || !wallet || !["usd", "credits"].includes(wallet.currency ?? "")
      || !Number.isFinite(wallet.remaining_balance) || wallet.remaining_balance! < 0) return { ...base, health: "OK" };
    return { ...base, available: wallet.remaining_balance!, unit: wallet.currency === "usd" ? "usd" : "credit", health: "OK", reliability: "provider_api" };
  } catch { return { ...base, health: "DEGRADED" }; }
}
