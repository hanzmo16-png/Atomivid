/**
 * Provider Capacity Forecasting / Admission: "CAN THIS JOB BE SAFELY ACCEPTED?"
 * Composes the existing capacity core (capacity/capacity.ts: UNKNOWN never becomes GREEN)
 * with configured spending ceilings, reserved consumption, queued demand and the job's
 * estimated cost per provider. Adapters are pluggable per provider; a provider without a
 * verified balance stays UNKNOWN (never an invented number).
 */
import { assessCapacity, admit, forecastDepletion, type CapacitySnapshot, type UsageSample } from "../production-intelligence/capacity/capacity";
import { PROVIDER_ACCOUNTS } from "../production-intelligence/capacity/accounts";

export type ProviderCapacityState = "HEALTHY" | "LIMITED" | "INSUFFICIENT" | "UNKNOWN";

export type ProviderCapacityView = {
  provider: string;
  plan: string | null;
  unit: CapacitySnapshot["unit"];
  availableBalance: number | null;
  balanceSource: CapacitySnapshot["reliability"];
  spendingCeiling: number | null;
  reservedConsumption: number;
  queuedDemand: number;
  estimatedRemaining: number | null;
  renewalDate: string | null;
  depletionForecast: { dailyUse: number | null; depletionDate: string | null; beforeRenewal: boolean | null } | null;
  status: ProviderCapacityState;
  reasons: string[];
};

/** A capacity adapter returns a snapshot for one provider; the registry keeps the interface open for new providers. */
export type CapacityAdapter = (ctx: { reserved: number; pending: number; now: string }) => Promise<CapacitySnapshot> | CapacitySnapshot;
export type AdapterRegistry = Record<string, CapacityAdapter>;

export type SpendingCeilings = Record<string, number | undefined>;

const toState = (s: "GREEN" | "YELLOW" | "RED" | "UNKNOWN"): ProviderCapacityState => (s === "GREEN" ? "HEALTHY" : s === "YELLOW" ? "LIMITED" : s === "RED" ? "INSUFFICIENT" : "UNKNOWN");

export function capacityView(s: CapacitySnapshot, ceiling: number | undefined, usage: UsageSample[] = []): ProviderCapacityView {
  const a = assessCapacity(s);
  const reasons = [...a.reasons];
  let status = toState(a.status);
  const plan = PROVIDER_ACCOUNTS.find((p) => p.provider === s.provider)?.plan ?? null;
  // A configured ceiling is a hard cap independent of the provider balance.
  let remaining: number | null = a.free;
  if (ceiling !== undefined) {
    const underCeiling = Math.max(0, ceiling - s.reserved);
    remaining = remaining === null ? underCeiling : Math.min(remaining, underCeiling);
    reasons.push(`configured spending ceiling ${ceiling} ${s.unit}: ${underCeiling} left after reserved`);
    if (underCeiling < s.pending) { status = "INSUFFICIENT"; reasons.push("queued demand exceeds the configured ceiling"); }
    if (status === "UNKNOWN") reasons.push("balance unverified: the ceiling bounds spend but does not make capacity known");
  }
  const fc = s.available === null ? null : forecastDepletion(s, usage);
  return { provider: s.provider, plan, unit: s.unit, availableBalance: s.available, balanceSource: s.reliability, spendingCeiling: ceiling ?? null, reservedConsumption: s.reserved, queuedDemand: s.pending, estimatedRemaining: remaining, renewalDate: s.renewalDate, depletionForecast: fc ? { dailyUse: fc.dailyUse, depletionDate: fc.depletionDate, beforeRenewal: fc.beforeRenewal } : null, status, reasons };
}

export type JobRequirement = { provider: string; estimated: number; worstCase: number };
export type AdmissionDecision = { accepted: boolean; verdict: "ACCEPT" | "REJECT" | "NEEDS_OPERATOR"; perProvider: { provider: string; state: ProviderCapacityState; covered: boolean; reasons: string[] }[]; reasons: string[] };

/**
 * Admission uses the WORST case of the job per provider, the configured ceilings and the
 * already-reserved + queued work. UNKNOWN providers block unless an operator explicitly
 * accepts the unverified risk for that run (recorded in reasons).
 */
export async function canAcceptJob(job: JobRequirement[], adapters: AdapterRegistry, ceilings: SpendingCeilings, ctx: { reservedByProvider: Record<string, number>; queuedByProvider: Record<string, number>; now: string; operatorAcceptsUnknown?: boolean; projectBudgetUsd?: number }): Promise<AdmissionDecision> {
  const perProvider: AdmissionDecision["perProvider"] = [];
  const reasons: string[] = [];
  const totalWorst = job.reduce((t, j) => t + j.worstCase, 0);
  if (ctx.projectBudgetUsd !== undefined && totalWorst > ctx.projectBudgetUsd) reasons.push(`worst case USD ${totalWorst.toFixed(2)} exceeds the project budget USD ${ctx.projectBudgetUsd}`);
  for (const j of job) {
    const adapter = adapters[j.provider];
    const reserved = ctx.reservedByProvider[j.provider] ?? 0, pending = ctx.queuedByProvider[j.provider] ?? 0;
    if (!adapter) { perProvider.push({ provider: j.provider, state: "UNKNOWN", covered: false, reasons: ["no capacity adapter registered for this provider"] }); continue; }
    const snap = await adapter({ reserved, pending, now: ctx.now });
    const ceiling = ceilings[j.provider];
    const view = capacityView(snap, ceiling);
    const r = admit({ ...snap, pending }, j.worstCase + pending, { operatorAcceptsUnknown: ctx.operatorAcceptsUnknown });
    let covered = r.covered;
    const why = [...view.reasons, ...r.reasons];
    if (ceiling !== undefined && reserved + pending + j.worstCase > ceiling) { covered = false; why.push(`reserved ${reserved} + queued ${pending} + job worst ${j.worstCase} > ceiling ${ceiling}`); }
    perProvider.push({ provider: j.provider, state: view.status === "HEALTHY" && !covered ? "INSUFFICIENT" : view.status, covered, reasons: why });
  }
  const unknown = perProvider.filter((p) => p.state === "UNKNOWN" && !p.covered);
  const blocked = perProvider.filter((p) => !p.covered && p.state !== "UNKNOWN");
  const accepted = !reasons.length && perProvider.every((p) => p.covered);
  const verdict: AdmissionDecision["verdict"] = accepted ? "ACCEPT" : blocked.length || reasons.length ? "REJECT" : unknown.length ? "NEEDS_OPERATOR" : "REJECT";
  if (unknown.length) reasons.push(`capacity UNKNOWN for ${unknown.map((p) => p.provider).join(", ")}: an operator must accept the unverified risk explicitly`);
  if (blocked.length) reasons.push(`insufficient capacity: ${blocked.map((p) => p.provider).join(", ")}`);
  return { accepted, verdict, perProvider, reasons };
}
