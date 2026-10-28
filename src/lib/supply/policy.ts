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

/**
 * Refusals of pi_submit_with_supply that cannot clear before the provider's next budget period (day or month in the
 * policy timezone): retrying sooner never succeeds. Everything else (concurrency, a stale balance, a paused level)
 * can clear within minutes and keeps the bounded short wait.
 */
export const NEXT_PERIOD_REASONS: Readonly<Record<string, string>> = {
  "daily request quota": "el número máximo de solicitudes del día de un proveedor",
  "provider funded spend ceiling": "el gasto máximo del periodo de un proveedor",
  "global funded spend ceiling": "el gasto máximo del periodo de producción",
};
export function waitsForNextPeriod(reason: string): boolean {
  return Object.prototype.hasOwnProperty.call(NEXT_PERIOD_REASONS, reason);
}
/** Customer text for a next-period wait: what limit, that nothing was called or charged, and when to resume. */
export function nextPeriodMessage(reason: string): string {
  return `Se alcanzó ${NEXT_PERIOD_REASONS[reason] ?? "un límite del periodo de un proveedor"}. No se hizo ninguna llamada nueva ni se cobró; `
    + "tu solicitud y sus avances están guardados. Pulsa «Reanudar» a partir del próximo periodo (los límites diarios se reinician a medianoche, hora de Cancún).";
}

export class SupplyUnavailableError extends Error {
  readonly customerMessage = "La producción está temporalmente en espera. Conservamos tu solicitud y sus avances; no se iniciará una llamada sin recursos confirmados.";
  readonly diagnosticId = "SUPPLY-WAIT";
  constructor(readonly provider: string, readonly reason: string) {
    super(`SUPPLY_UNAVAILABLE:${provider}:${reason}`);
    this.name = "SupplyUnavailableError";
  }
  /** True when retrying before the provider's next budget period cannot succeed (see NEXT_PERIOD_REASONS). */
  get waitsForNextPeriod(): boolean { return waitsForNextPeriod(this.reason); }
}
