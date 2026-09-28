/** Cost Engine: pure arithmetic over a rate card. No policy, no aesthetics. */
import type { Method } from "./ladder";
import type { RateCard } from "./rate-card";

export type CostBreakdown = {
  method: Method;
  expectedUsd: number;
  /** Upper bound across all authorized attempts. */
  worstCaseUsd: number;
  billedSeconds: number;
  lines: { entry: string; units: number; expectedUsd: number; worstUsd: number }[];
};

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Cost of producing one shot with `method`.
 * `stillExists`: an approved still is already paid for (no new image cost).
 * `attempts`: authorized attempts for the paid motion step (worst case pays all).
 */
export function costOf(card: RateCard, method: Method, opts: { stillExists?: boolean; attempts?: number; stillAttempts?: number } = {}): CostBreakdown {
  const lines: CostBreakdown["lines"] = [];
  const me = card.methodEntries[method];
  let billedSeconds = 0;
  if (me?.still && !opts.stillExists) {
    const e = card.entries[me.still];
    const n = opts.stillAttempts ?? 1;
    lines.push({ entry: me.still, units: n, expectedUsd: e.price, worstUsd: e.worstPrice * n });
  }
  if (me?.motion && card.clipSeconds[method]) {
    const e = card.entries[me.motion];
    billedSeconds = card.clipSeconds[method]!;
    const n = opts.attempts ?? 1;
    lines.push({ entry: me.motion, units: billedSeconds * n, expectedUsd: e.price * billedSeconds, worstUsd: e.worstPrice * billedSeconds * n });
  }
  return {
    method,
    expectedUsd: r4(lines.reduce((a, l) => a + l.expectedUsd, 0)),
    worstCaseUsd: r4(lines.reduce((a, l) => a + l.worstUsd, 0)),
    billedSeconds,
    lines,
  };
}

/** Narration cost for a character count. */
export function narrationCost(card: RateCard, entry: string, characters: number): { expectedUsd: number; worstCaseUsd: number } {
  const e = card.entries[entry];
  return { expectedUsd: r4(e.price * characters), worstCaseUsd: r4(e.worstPrice * characters) };
}

export type LedgerTotals = { reservedUsd: number; committedUsd: number; refundedUsd: number };

export function sumLedger(entries: { status: string; reservedUsd: number; committedUsd: number | null }[]): LedgerTotals {
  let reservedUsd = 0, committedUsd = 0, refundedUsd = 0;
  for (const e of entries) {
    if (e.status === "COMMITTED") committedUsd += e.committedUsd ?? e.reservedUsd;
    else if (e.status === "REFUNDED") refundedUsd += e.reservedUsd;
    else reservedUsd += e.reservedUsd; // RESERVED / SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED stay exposed
  }
  return { reservedUsd: r4(reservedUsd), committedUsd: r4(committedUsd), refundedUsd: r4(refundedUsd) };
}
