/**
 * Production Memory V1: a read-only projection of telemetry. It never writes
 * policy. Cells are keyed by (provider, modelVersion, shotClass, method,
 * rateCardVersion) within a time window, so a new model version never inherits
 * another version's statistics. Human-intervened results are counted but do not
 * vote in the automatic statistics.
 */
import { stableHash } from "./canonical";
import type { AttemptEvent, OutcomeEvent, TelemetryEvent } from "./telemetry";

export type MemoryCell = {
  key: string;
  provider: string;
  modelVersion: string;
  shotClass: string;
  productionMethod: string;
  rateCardVersion: string;
  /** Automatic (no human intervention) attempts: the only ones that vote. */
  n: number;
  nHuman: number;
  technicalPassRate: number | null;
  visualPassRate: number | null;
  keepRate: number | null;
  costPerAcceptedSecond: number | null;
  modelVersionKnown: boolean;
};

export type MemorySnapshot = { memorySnapshotId: string; asOf: string; windowDays: number; cells: Record<string, MemoryCell> };

const rate = (num: number, den: number) => (den ? Math.round((num / den) * 1e4) / 1e4 : null);

export function cellKey(e: Pick<AttemptEvent, "provider" | "modelVersion" | "shotClass" | "productionMethod" | "rateCardVersion">): string {
  return [e.provider, e.modelVersion || "unknown", e.shotClass, e.productionMethod, e.rateCardVersion].join("|");
}

export function buildMemorySnapshot(events: readonly TelemetryEvent[], asOf: string, windowDays = 90): Readonly<MemorySnapshot> {
  const end = Date.parse(asOf), start = end - windowDays * 86400000;
  const attempts = events.filter((e): e is AttemptEvent => e.type === "attempt" && Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) <= end);
  const outcomes = new Map<string, OutcomeEvent[]>();
  for (const e of events) if (e.type === "outcome" && Date.parse(e.timestamp) <= end) outcomes.set(e.attemptId, [...(outcomes.get(e.attemptId) ?? []), e]);
  const acc = new Map<string, { a: AttemptEvent[]; h: number }>();
  for (const a of attempts) {
    const k = cellKey(a);
    const cur = acc.get(k) ?? { a: [], h: 0 };
    if (a.humanIntervention === "human") cur.h++; else cur.a.push(a);
    acc.set(k, cur);
  }
  const cells: Record<string, MemoryCell> = {};
  for (const [k, { a, h }] of [...acc.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const s = a[0] ?? attempts.find((x) => cellKey(x) === k)!;
    const tech = a.filter((x) => x.technicalPass !== null), vis = a.filter((x) => x.visualQaPass !== null);
    const kept = a.map((x) => (outcomes.get(x.attemptId) ?? []).reduce<boolean | undefined>((v, o) => (o.userKept !== undefined ? o.userKept : v), undefined)).filter((x): x is boolean => x !== undefined);
    const acceptedSecs = a.reduce((t, x) => t + x.acceptedSeconds, 0);
    cells[k] = {
      key: k, provider: s.provider, modelVersion: s.modelVersion || "unknown", shotClass: s.shotClass, productionMethod: s.productionMethod, rateCardVersion: s.rateCardVersion,
      n: a.length, nHuman: h,
      technicalPassRate: rate(tech.filter((x) => x.technicalPass).length, tech.length),
      visualPassRate: rate(vis.filter((x) => x.visualQaPass).length, vis.length),
      keepRate: rate(kept.filter(Boolean).length, kept.length),
      costPerAcceptedSecond: acceptedSecs ? Math.round((a.reduce((t, x) => t + x.costUsd, 0) / acceptedSecs) * 1e4) / 1e4 : null,
      modelVersionKnown: !!s.modelVersion && s.modelVersion !== "unknown",
    };
  }
  const body = { asOf, windowDays, cells };
  return Object.freeze({ memorySnapshotId: "mem_" + stableHash(body), ...body });
}

/**
 * Future data-driven gate (documented, never auto-applied in V1): a cell may
 * influence policy only with n >= 50 automatic attempts, a model version active
 * >= 30 days, and a shadow run showing >= 15% lower cost per accepted second
 * without a material keep-rate drop.
 */
export function promotionGate(cell: MemoryCell, modelActiveDays: number, shadow: { costPerAcceptedSecondDelta: number; keepRateDelta: number }): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (cell.n < 50) reasons.push(`n=${cell.n} < 50`);
  if (!cell.modelVersionKnown) reasons.push("model version unknown");
  if (modelActiveDays < 30) reasons.push(`model version active ${modelActiveDays} < 30 days`);
  if (shadow.costPerAcceptedSecondDelta > -0.15) reasons.push("shadow saving < 15% per accepted second");
  if (shadow.keepRateDelta < -0.02) reasons.push("keep rate drops materially");
  return { eligible: reasons.length === 0, reasons: reasons.length ? reasons : ["all gate conditions met; still requires explicit human promotion"] };
}
