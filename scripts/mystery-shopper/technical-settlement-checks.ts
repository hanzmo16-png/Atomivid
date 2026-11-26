/** Registered usage and provider journal overlap: use max, never add the voice twice. */
export function technicalSettlementAmount(operations: any[], generation: any, reservedUsd: number, expectedUsd: number): number {
  if (!Array.isArray(operations) || !operations.length || operations.some(op => op.status !== "COMMITTED" || op.committed_usd === null || !Number.isFinite(Number(op.committed_usd)) || Number(op.committed_usd) < 0 || !Number.isFinite(Number(op.reserved_usd)) || Number(op.reserved_usd) < Number(op.committed_usd))) throw Error("provider journal is open or costs unverified");
  if (!generation || generation.estimated_cost_usd === null || !Number.isFinite(Number(generation.estimated_cost_usd)) || Number(generation.estimated_cost_usd) < 0 || !Number.isFinite(Number(generation.render_ms)) || Number(generation.render_ms) < 0 || Number(generation.script_calls) !== 0) throw Error("registered native usage unverified");
  if (!Number.isFinite(reservedUsd) || reservedUsd <= 0 || reservedUsd > 2 || !Number.isFinite(expectedUsd) || expectedUsd < 0) throw Error("settlement bound unverified");
  const providerActual = operations.filter(op => op.method !== "capacity_hold").reduce((sum, op) => sum + Number(op.committed_usd), 0);
  const amount = Math.ceil((Math.max(providerActual, Number(generation.estimated_cost_usd)) - Number.EPSILON) * 100) / 100;
  if (amount !== expectedUsd || amount > reservedUsd || amount < 0) throw Error("root expected rounded cost or reservation does not match");
  return amount;
}
