/**
 * Cost Engine: ESTIMATED vs RESERVED vs ACTUAL per request, provider, shot and asset type.
 * Built on the PI rate card (cost.ts) and the idempotent paid-operation ledger (ledger.ts).
 * Accounting rule: a provider TOP-UP (balance recharge) is NEVER COGS. Only committed API
 * consumption is production cost. Top-ups live in a separate balance journal.
 * Every write is idempotent: the same key with the same figures is a no-op; the same key
 * with different figures is refused for reconciliation, never silently overwritten.
 */
import { costOf } from "../production-intelligence/cost";
import type { RateCard } from "../production-intelligence/rate-card";
import type { Method } from "../production-intelligence/ladder";
import { stableHash } from "../production-intelligence/canonical";
import type { ProductionShotRecord } from "./shot-record";

export type CostStatus = "ESTIMATED" | "RESERVED" | "COMMITTED" | "REFUNDED" | "RECONCILIATION_REQUIRED";
export type CostEntry = {
  costKey: string;
  requestId: string;
  shotId: string;
  provider: string;
  assetType: string;
  method: Method | "narration";
  estimatedUsd: number;
  reservedUsd: number;
  actualUsd: number | null;
  status: CostStatus;
  updatedAt: string;
};
export type BalanceEvent = { provider: string; kind: "TOP_UP" | "CREDIT_GRANT"; amountUsd: number; at: string; note: string };

export class CostConflictError extends Error {}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
export const costKey = (requestId: string, shotId: string, provider: string, method: string) => "cost_" + stableHash({ requestId, shotId, provider, method }, 24);

export class CostLedger {
  readonly entries = new Map<string, CostEntry>();
  readonly balanceJournal: BalanceEvent[] = [];
  constructor(private readonly requestId: string) {}

  /** Estimate one shot for a method from the rate card (worst case becomes the reservation). */
  estimateShot(r: ProductionShotRecord, method: Method, card: RateCard, provider: string, now: string, opts: { stillExists?: boolean; attempts?: number } = {}): CostEntry {
    const c = costOf(card, method, { stillExists: opts.stillExists, attempts: opts.attempts, stillAttempts: opts.attempts === undefined ? 1 : undefined });
    const key = costKey(this.requestId, r.contract.shotId, provider, method);
    const e: CostEntry = { costKey: key, requestId: this.requestId, shotId: r.contract.shotId, provider, assetType: r.assetType, method, estimatedUsd: c.expectedUsd, reservedUsd: 0, actualUsd: null, status: "ESTIMATED", updatedAt: now };
    return this.put(e, ["ESTIMATED"]);
  }

  /** Narration cost line (characters x rate) attributed to the request, not a shot. */
  estimateNarration(characters: number, card: RateCard, entry: string, now: string): CostEntry {
    const e = card.entries[entry];
    const key = costKey(this.requestId, "__narration__", e.provider, "narration");
    return this.put({ costKey: key, requestId: this.requestId, shotId: "__narration__", provider: e.provider, assetType: "narration", method: "narration", estimatedUsd: r4(e.price * characters), reservedUsd: 0, actualUsd: null, status: "ESTIMATED", updatedAt: now }, ["ESTIMATED"]);
  }

  reserve(key: string, worstCaseUsd: number, now: string): CostEntry {
    const cur = this.must(key);
    if (cur.status === "RESERVED" && cur.reservedUsd === r4(worstCaseUsd)) return cur;
    if (cur.status !== "ESTIMATED") throw new CostConflictError(`${key}: cannot reserve from ${cur.status}`);
    return this.set({ ...cur, reservedUsd: r4(worstCaseUsd), status: "RESERVED", updatedAt: now });
  }

  /** Commit the ACTUAL provider consumption. Idempotent; a different actual for the same key is a conflict. */
  commit(key: string, actualUsd: number, now: string): CostEntry {
    const cur = this.must(key);
    // The original committed figure stays idempotent even after a conflicting attempt flagged the entry.
    if ((cur.status === "COMMITTED" || cur.status === "RECONCILIATION_REQUIRED") && cur.actualUsd === r4(actualUsd)) return cur;
    if (cur.status === "COMMITTED") {
      this.set({ ...cur, status: "RECONCILIATION_REQUIRED", updatedAt: now });
      throw new CostConflictError(`${key}: already committed at USD ${cur.actualUsd}, got USD ${actualUsd}; reconciliation required`);
    }
    if (cur.status !== "RESERVED") throw new CostConflictError(`${key}: cannot commit from ${cur.status} (reserve first)`);
    return this.set({ ...cur, actualUsd: r4(actualUsd), status: "COMMITTED", updatedAt: now });
  }

  refund(key: string, now: string): CostEntry {
    const cur = this.must(key);
    if (cur.status === "REFUNDED") return cur;
    return this.set({ ...cur, actualUsd: 0, status: "REFUNDED", updatedAt: now });
  }

  /** A recharge of the provider balance: recorded for capacity, EXCLUDED from every COGS figure. */
  recordTopUp(ev: BalanceEvent): void {
    if (ev.amountUsd <= 0) throw new CostConflictError("top-up must be positive");
    if (!this.balanceJournal.some((b) => b.provider === ev.provider && b.at === ev.at && b.amountUsd === ev.amountUsd)) this.balanceJournal.push({ ...ev });
  }

  report(): CostReport {
    const all = [...this.entries.values()];
    // A flagged entry keeps its originally committed figure: the money was spent; the conflict is reported, not hidden.
    const spent = (e: CostEntry) => (e.status === "COMMITTED" || e.status === "RECONCILIATION_REQUIRED" ? e.actualUsd ?? 0 : 0);
    const agg = (rows: CostEntry[]) => ({
      estimatedUsd: r4(rows.reduce((t, e) => t + e.estimatedUsd, 0)),
      reservedUsd: r4(rows.reduce((t, e) => t + (e.status === "RESERVED" ? e.reservedUsd : 0), 0)),
      actualUsd: r4(rows.reduce((t, e) => t + spent(e), 0)),
      openUsd: r4(rows.reduce((t, e) => t + (e.status === "RESERVED" ? e.reservedUsd : 0), 0)),
      entries: rows.length,
    });
    const group = (k: (e: CostEntry) => string) => Object.fromEntries([...new Set(all.map(k))].sort().map((g) => [g, agg(all.filter((e) => k(e) === g))]));
    const req = agg(all);
    return {
      requestId: this.requestId, request: req, byProvider: group((e) => e.provider), byShot: group((e) => e.shotId), byAssetType: group((e) => e.assetType),
      deviation: { actualVsEstimatedUsd: r4(req.actualUsd - req.estimatedUsd), actualVsReservedUsd: r4(req.actualUsd - all.reduce((t, e) => t + (spent(e) || e.status === "COMMITTED" ? e.reservedUsd : 0), 0)) },
      topUpsUsd: r4(this.balanceJournal.reduce((t, b) => t + b.amountUsd, 0)),
      cogsUsd: req.actualUsd,
      note: "COGS = committed API consumption only; top-ups are balance events and never cost of production",
      reconciliationRequired: all.filter((e) => e.status === "RECONCILIATION_REQUIRED").map((e) => e.costKey),
    };
  }

  private must(key: string): CostEntry { const e = this.entries.get(key); if (!e) throw new CostConflictError(`unknown cost entry ${key}`); return e; }
  private set(e: CostEntry): CostEntry { this.entries.set(e.costKey, e); return e; }
  private put(e: CostEntry, replaceable: CostStatus[]): CostEntry {
    const cur = this.entries.get(e.costKey);
    if (!cur) return this.set(e);
    if (!replaceable.includes(cur.status)) return cur; // an estimate never overwrites a reservation or a commit
    if (cur.estimatedUsd === e.estimatedUsd) return cur;
    return this.set({ ...cur, estimatedUsd: e.estimatedUsd, updatedAt: e.updatedAt });
  }
}

type Agg = { estimatedUsd: number; reservedUsd: number; actualUsd: number; openUsd: number; entries: number };
export type CostReport = { requestId: string; request: Agg; byProvider: Record<string, Agg>; byShot: Record<string, Agg>; byAssetType: Record<string, Agg>; deviation: { actualVsEstimatedUsd: number; actualVsReservedUsd: number }; topUpsUsd: number; cogsUsd: number; note: string; reconciliationRequired: string[] };
