/**
 * Provider Capacity Monitor (pure core). Balance is NOT free capacity:
 * free = available - reserved for accepted work. UNKNOWN never becomes GREEN.
 */
export type CapacityStatus = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type SourceReliability = "provider_api" | "derived_from_ledger" | "manual_entry" | "none";

export type CapacitySnapshot = {
  provider: string;
  accountLabel: string;
  unit: "character" | "usd" | "credit";
  /** Provider-reported balance; null when no reliable source exists. */
  available: number | null;
  /** Units reserved by already-accepted projects. */
  reserved: number;
  /** Units required by projects awaiting admission. */
  pending: number;
  renewalDate: string | null;
  lastCheckedAt: string;
  health: "OK" | "DEGRADED" | "DOWN" | "UNCHECKED";
  reliability: SourceReliability;
  /** Estimated remaining when only derived data exists (never promoted to `available`). */
  derivedEstimate?: number | null;
};

export type CapacityAssessment = {
  provider: string;
  status: CapacityStatus;
  free: number | null;
  reasons: string[];
};

/** Required buffer: a fraction of reserved + pending work (default 15%). */
export function requiredBuffer(s: CapacitySnapshot, ratio = 0.15): number {
  return Math.ceil((s.reserved + s.pending) * ratio);
}

export function assessCapacity(s: CapacitySnapshot, bufferRatio = 0.15): CapacityAssessment {
  const reasons: string[] = [];
  if (s.health === "DOWN") return { provider: s.provider, status: "RED", free: null, reasons: ["provider health DOWN"] };
  if (s.available === null || s.reliability === "none" || s.reliability === "derived_from_ledger") {
    reasons.push(`balance not verifiable (${s.reliability}); UNKNOWN is never treated as GREEN`);
    if (s.derivedEstimate != null) reasons.push(`derived estimate ${s.derivedEstimate} ${s.unit} (informative only)`);
    return { provider: s.provider, status: "UNKNOWN", free: null, reasons };
  }
  const free = s.available - s.reserved;
  const buffer = requiredBuffer(s, bufferRatio);
  reasons.push(`available ${s.available} - reserved ${s.reserved} = free ${free} ${s.unit}; pending ${s.pending}; buffer ${buffer}`);
  if (s.available < s.reserved) return { provider: s.provider, status: "RED", free, reasons: [...reasons, "cannot guarantee already-reserved work"] };
  if (free < s.pending + buffer) return { provider: s.provider, status: "YELLOW", free, reasons: [...reasons, "committed work is covered; accepting pending work is risky"] };
  if (s.health === "DEGRADED") return { provider: s.provider, status: "YELLOW", free, reasons: [...reasons, "provider health DEGRADED"] };
  return { provider: s.provider, status: "GREEN", free, reasons: [...reasons, "reserved + pending + buffer covered"] };
}

export type AdmissionResult = { covered: boolean; status: CapacityStatus; reasons: string[] };

/**
 * Admission control: a new requirement is covered only when free capacity is at least
 * requirement + buffer. UNKNOWN is not covered unless an operator explicitly accepts the risk.
 */
export function admit(s: CapacitySnapshot, requirement: number, opts: { bufferRatio?: number; operatorAcceptsUnknown?: boolean } = {}): AdmissionResult {
  const a = assessCapacity({ ...s, pending: 0 }, opts.bufferRatio);
  if (a.status === "UNKNOWN") return { covered: !!opts.operatorAcceptsUnknown, status: "UNKNOWN", reasons: [...a.reasons, opts.operatorAcceptsUnknown ? "operator explicitly accepted unverified capacity" : "not covered: capacity unverified"] };
  if (a.status === "RED") return { covered: false, status: "RED", reasons: a.reasons };
  const buffer = Math.ceil((s.reserved + requirement) * (opts.bufferRatio ?? 0.15));
  const covered = (a.free ?? 0) >= requirement + buffer;
  return { covered, status: covered ? "GREEN" : "RED", reasons: [...a.reasons, `requirement ${requirement} + buffer ${buffer} vs free ${a.free}: ${covered ? "covered" : "BLOCKED"}`] };
}

export type UsageSample = { at: string; used: number };

/** Simple forecast: mean daily use over the window; no ML. */
export function forecastDepletion(s: CapacitySnapshot, samples: UsageSample[], windowDays = 14): { dailyUse: number | null; depletionDate: string | null; beforeRenewal: boolean | null; reason: string } {
  if (s.available === null) return { dailyUse: null, depletionDate: null, beforeRenewal: null, reason: "no verified balance" };
  const end = Date.parse(s.lastCheckedAt), start = end - windowDays * 86400000;
  const inWin = samples.filter((x) => { const t = Date.parse(x.at); return t >= start && t <= end; });
  if (inWin.length < 2) return { dailyUse: null, depletionDate: null, beforeRenewal: null, reason: "not enough usage samples" };
  const total = inWin.reduce((a, x) => a + x.used, 0);
  const days = Math.max(1, (Date.parse(inWin[inWin.length - 1].at) - Date.parse(inWin[0].at)) / 86400000);
  const daily = total / days;
  if (daily <= 0) return { dailyUse: 0, depletionDate: null, beforeRenewal: false, reason: "no consumption in window" };
  const free = Math.max(0, s.available - s.reserved);
  const depletion = new Date(end + (free / daily) * 86400000).toISOString().slice(0, 10);
  const before = s.renewalDate ? depletion < s.renewalDate : null;
  return { dailyUse: Math.round(daily * 100) / 100, depletionDate: depletion, beforeRenewal: before, reason: `free ${free} / ${daily.toFixed(1)} per day` };
}
