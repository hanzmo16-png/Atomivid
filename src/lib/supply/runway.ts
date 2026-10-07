import type { CapacitySnapshot } from "@/lib/production-intelligence/capacity/capacity";

/** Official GET /v1/organization, verified 2026-10-05 in Runway api.md.
 * API credits only; never a subscription workspace balance or an estimated USD wallet. */
export async function runwayApiSnapshot(request: typeof fetch, env: Record<string, string | undefined>, checkedAt: string): Promise<CapacitySnapshot> {
  const base: CapacitySnapshot = { provider: "runway", accountLabel: "ATOMIVID production API key", unit: "credit", available: null,
    reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: checkedAt, health: "UNCHECKED", reliability: "none" };
  const key = env.RUNWAY_API_KEY?.trim() || env.RUNWAYML_API_SECRET?.trim();
  if (!key) return base;
  try {
    const response = await request("https://api.dev.runwayml.com/v1/organization", { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${key}`, "X-Runway-Version": "2024-11-06" } });
    if (!response.ok) return { ...base, health: response.status >= 500 ? "DEGRADED" : "DOWN" };
    const value = await response.json() as { creditBalance?: number };
    if (!Number.isFinite(value.creditBalance) || value.creditBalance! < 0) return { ...base, health: "DEGRADED" };
    return { ...base, available: value.creditBalance!, health: "OK", reliability: "provider_api" };
  } catch { return { ...base, health: "DEGRADED" }; }
}
