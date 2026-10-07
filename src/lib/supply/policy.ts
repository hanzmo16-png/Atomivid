/** All quantities are provider units. Manual observations persist; API evidence expires. */
export type SupplyLevel = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type SupplyState = {
  unit?: string; provider: string; level: SupplyLevel; free: number | null; remainingRatio: number | null;
  coverageHours: number | null; reason: string;
};
export function assessSupply(input: {
  provider: string; available: number | null; held: number; baseline: number;
  dailyForecast: number; recentDailyPeak?: number; pending?: number;
  checkedAt: string | null; now: number; health: string; reliable: boolean;
  reliability?: "provider_api" | "manual_entry" | "none";
}): SupplyState {
  const base = { provider: input.provider, free: null, remainingRatio: null, coverageHours: null };
  const age = input.checkedAt ? input.now - Date.parse(input.checkedAt) : NaN;
  // Manual balances are a starting balance, not a live wallet read. The SQL gate
  // subtracts all consumption since checkedAt and unresolved holds on every call.
  const usableObservation = Number.isFinite(age) && age >= 0
    && (input.reliability === "manual_entry" || age <= 300_000);
  if (!input.reliable || input.available === null || !Number.isFinite(input.available)
    || input.reliability === "none" || input.available < 0 || !usableObservation || !(input.baseline > 0))
    return { ...base, level: "UNKNOWN", reason: "unverified, stale or unconfigured supply" };
  const free = Math.max(0, input.available - input.held);
  const remainingRatio = free / input.baseline;
  const daily = Math.max(input.dailyForecast, input.recentDailyPeak ?? 0, input.pending ?? 0);
  const coverageHours = daily > 0 ? free / daily * 24 : null;
  const state = { provider: input.provider, free, remainingRatio, coverageHours };
  if (input.health === "DOWN" || free <= 0 || remainingRatio <= .15 || (coverageHours !== null && coverageHours <= 24))
    return { ...state, level: "RED", reason: "urgent replenishment or provider unavailable" };
  if (input.health !== "OK" || remainingRatio <= .3 || (coverageHours !== null && coverageHours <= 72))
    return { ...state, level: "YELLOW", reason: "replenish before supply is exhausted" };
  return { ...state, level: "GREEN", reason: "verified supply covers the current forecast" };
}

export class SupplyUnavailableError extends Error {
  readonly customerMessage = "La producción está temporalmente en espera. Conservamos tu solicitud y sus avances; no se iniciará una llamada sin recursos confirmados.";
  readonly diagnosticId = "SUPPLY-WAIT";
  constructor(readonly provider: string, readonly reason: string) {
    super(`SUPPLY_UNAVAILABLE:${provider}:${reason}`);
    this.name = "SupplyUnavailableError";
  }
}
