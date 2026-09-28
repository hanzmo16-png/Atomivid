/**
 * Budget reservation. A production starts only if its WORST authorized cost
 * (including authorized fallbacks) fits the reserved project budget. What is
 * not spent is released at settlement. The per-call hard cap stays as an
 * emergency kill switch, not as the primary strategy.
 */
export type Reservation = {
  projectId: string;
  reservedUsd: number;
  expectedUsd: number;
  worstCaseUsd: number;
  committedUsd: number;
  releasedUsd: number;
  status: "RESERVED" | "SETTLED" | "REJECTED";
  reasons: string[];
};

export function reserveProject(projectId: string, plan: { expectedCostUsd: number; worstCaseUsd: number }, projectBudgetUsd: number, extraWorstUsd = 0): Reservation {
  const worst = Math.round((plan.worstCaseUsd + extraWorstUsd) * 1e4) / 1e4;
  if (worst > projectBudgetUsd) {
    return { projectId, reservedUsd: 0, expectedUsd: plan.expectedCostUsd, worstCaseUsd: worst, committedUsd: 0, releasedUsd: 0, status: "REJECTED", reasons: [`worst authorized cost USD ${worst} exceeds project budget USD ${projectBudgetUsd}: no paid call may start`] };
  }
  return { projectId, reservedUsd: worst, expectedUsd: plan.expectedCostUsd, worstCaseUsd: worst, committedUsd: 0, releasedUsd: 0, status: "RESERVED", reasons: [`reserved worst case USD ${worst} (expected USD ${plan.expectedCostUsd}) within budget USD ${projectBudgetUsd}`] };
}

export class HardCapError extends Error {}

/** Emergency kill switch before every paid call (defense in depth). */
export function assertWithinReservation(r: Reservation, spentUsd: number, nextCallMaxUsd: number): void {
  if (r.status !== "RESERVED") throw new HardCapError(`Reservation ${r.status}: no paid call`);
  if (spentUsd + nextCallMaxUsd > r.reservedUsd + 1e-9) throw new HardCapError(`Kill switch: spent ${spentUsd} + next ${nextCallMaxUsd} > reserved ${r.reservedUsd}`);
}

export function settleProject(r: Reservation, committedUsd: number): Reservation {
  const released = Math.round((r.reservedUsd - committedUsd) * 1e4) / 1e4;
  return { ...r, committedUsd, releasedUsd: Math.max(0, released), status: "SETTLED", reasons: [...r.reasons, `settled at USD ${committedUsd}; released USD ${Math.max(0, released)}`] };
}
