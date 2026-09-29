/**
 * SMART_REPAIR: repairs that may need another asset, a regeneration, a new animation or a
 * partial re-render. This module PLANS and GATES; it never spends. A RepairPlan is executed
 * only with an explicit human authorization carrying a reservation, and even then through
 * the idempotent paid-operation ledger of Production Intelligence.
 */
import { RATE_CARD_V1 } from "../production-intelligence/rate-card";
import { costOf } from "../production-intelligence/cost";
import { reserveProject } from "../production-intelligence/budget";
import type { Method } from "../production-intelligence/ladder";
import { canAcceptJob, type AdapterRegistry, type AdmissionDecision, type SpendingCeilings } from "../production-core/admission";
import { PRODUCTION_POLICY_V1, type ProductionPolicy } from "../production-core/policy-engine";
import { slotEnd, slotsSorted, type MasterEdl } from "./edl";
import type { Issue } from "./report";

export type RepairKind = "SUBSTITUTE_EXISTING_ASSET" | "REGENERATE_STILL" | "ANIMATE_STILL" | "NEW_SHOT" | "PARTIAL_RERENDER" | "REMASTER_AUDIO";
export type RepairPlan = {
  repairId: string;
  masterId: string;
  issueId: string;
  rule: string;
  affected: { shotId: string | null; startSec: number | null; endSec: number | null };
  proposedRepair: RepairKind;
  method: Method | null;
  providerRequired: string | null;
  estimatedIncrementalUsd: number;
  worstCaseUsd: number;
  expectedImprovement: string;
  fallback: RepairKind;
  provenanceImpact: string;
  gates: { cost: "PASS" | "FAIL" | "PENDING"; capacity: AdmissionDecision["verdict"] | "PENDING"; policy: "PASS" | "FAIL" | "PENDING"; reasons: string[] };
  status: "PROPOSED" | "GATED_OK" | "GATED_BLOCKED" | "AUTHORIZED" | "EXECUTED" | "REJECTED";
};

export class RepairAuthorizationError extends Error {}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const PROVIDER_OF: Record<Method, string | null> = { EXISTING_APPROVED_ASSET: null, STOCK: "pexels", AI_STILL: "openai", STILL_KEN_BURNS: "openai", STILL_PARALLAX: "openai", I2V_ECONOMY: "runway", I2V_HERO: "runway" };

/** Deterministic proposal per issue (cheapest repair that plausibly resolves it; never I2V when camera motion can). */
export function proposeRepair(e: MasterEdl, i: Issue): RepairPlan {
  const slot = i.shotId ? slotsSorted(e).find((s) => s.shotId === i.shotId) : null;
  const affected = { shotId: i.shotId, startSec: i.startTime, endSec: i.endTime };
  const hasAlt = !!slot?.validatedAlternates?.length;
  let kind: RepairKind, method: Method | null, improvement: string, fallback: RepairKind, prov: string;
  switch (i.rule) {
    case "R_STATIC_RUN": case "O_STILL_STREAK": case "O_MOVEMENT_DENSITY": case "R_OPENING_MOTION": case "V_FREEZE":
      kind = "ANIMATE_STILL"; method = "STILL_PARALLAX"; improvement = "breaks the static run with camera/depth motion at USD 0 generative"; fallback = "PARTIAL_RERENDER"; prov = "none: same approved still, deterministic motion"; break;
    case "R_HOOK_DENSITY": case "O_SHOT_COUNT": case "O_AVG_SHOT": case "V_SHOT_TOO_LONG": case "R_TOO_FAST_CUTS": case "R_MIN_VISIBLE":
      kind = "PARTIAL_RERENDER"; method = null; improvement = "re-cuts the affected range with the existing assets"; fallback = "SUBSTITUTE_EXISTING_ASSET"; prov = "none: existing assets only"; break;
    case "V_ASSET_REPETITION": case "R_REPETITION": case "O_REPETITION":
      kind = hasAlt ? "SUBSTITUTE_EXISTING_ASSET" : "REGENERATE_STILL"; method = hasAlt ? null : "AI_STILL"; improvement = "removes the visible reuse"; fallback = "PARTIAL_RERENDER"; prov = hasAlt ? "none: validated alternate" : "new AI recreation: must keep the reconstruction label"; break;
    case "V_ANATOMY": case "V_DEFORMED":
      kind = "REGENERATE_STILL"; method = "AI_STILL"; improvement = "replaces the defective still (QA gate applies before any motion)"; fallback = "SUBSTITUTE_EXISTING_ASSET"; prov = "new AI recreation of the same intent"; break;
    case "V_MOTION_INCOHERENT":
      kind = "ANIMATE_STILL"; method = "STILL_KEN_BURNS"; improvement = "falls back to controlled camera motion on the approved still"; fallback = "PARTIAL_RERENDER"; prov = "none"; break;
    case "A_CLIPPING": case "A_MUSIC_OVER_VOICE": case "A_DISCONTINUITY": case "A_WORD_CUT": case "S_FINAL_TRUNCATED":
      kind = "REMASTER_AUDIO"; method = null; improvement = "re-masters from stems / re-conforms narration"; fallback = "PARTIAL_RERENDER"; prov = "none"; break;
    default:
      kind = "PARTIAL_RERENDER"; method = null; improvement = "re-render of the affected range"; fallback = "PARTIAL_RERENDER"; prov = "none";
  }
  const cost = method ? costOf(RATE_CARD_V1, method, { stillExists: method === "STILL_PARALLAX" || method === "STILL_KEN_BURNS" }) : { expectedUsd: 0, worstCaseUsd: 0 };
  return { repairId: `rp_${i.issueId.slice(4)}`, masterId: e.masterId, issueId: i.issueId, rule: i.rule, affected, proposedRepair: kind, method, providerRequired: method ? PROVIDER_OF[method] : null, estimatedIncrementalUsd: r4(cost.expectedUsd), worstCaseUsd: r4(cost.worstCaseUsd), expectedImprovement: improvement, fallback, provenanceImpact: prov, gates: { cost: "PENDING", capacity: "PENDING", policy: "PENDING", reasons: [] }, status: "PROPOSED" };
}

/** Run the three gates (Cost Engine reservation, Provider Capacity admission, Policy Engine ceilings). No spend. */
export async function gateRepairs(plans: RepairPlan[], ctx: { remainingBudgetUsd: number; adapters: AdapterRegistry; ceilings: SpendingCeilings; now: string; policy?: ProductionPolicy; operatorAcceptsUnknown?: boolean }): Promise<RepairPlan[]> {
  const policy = ctx.policy ?? PRODUCTION_POLICY_V1;
  const out: RepairPlan[] = [];
  for (const p of plans) {
    const reasons: string[] = [];
    const res = reserveProject(`${p.masterId}:${p.repairId}`, { expectedCostUsd: p.estimatedIncrementalUsd, worstCaseUsd: p.worstCaseUsd }, ctx.remainingBudgetUsd);
    const cost = res.status === "RESERVED" ? "PASS" : "FAIL";
    reasons.push(...res.reasons);
    let capacity: RepairPlan["gates"]["capacity"] = "ACCEPT";
    if (p.providerRequired && p.worstCaseUsd > 0) {
      const a = await canAcceptJob([{ provider: p.providerRequired, estimated: p.estimatedIncrementalUsd, worstCase: p.worstCaseUsd }], ctx.adapters, ctx.ceilings, { reservedByProvider: {}, queuedByProvider: {}, now: ctx.now, operatorAcceptsUnknown: ctx.operatorAcceptsUnknown });
      capacity = a.verdict; reasons.push(...a.reasons);
    }
    let pol: "PASS" | "FAIL" = "PASS";
    if (p.worstCaseUsd > policy.budget.perShotCeilingUsd) { pol = "FAIL"; reasons.push(`worst case USD ${p.worstCaseUsd} exceeds the per-shot ceiling USD ${policy.budget.perShotCeilingUsd}`); }
    if (p.providerRequired && (policy.budget.perProviderCeilingUsd[p.providerRequired] ?? Infinity) < p.worstCaseUsd) { pol = "FAIL"; reasons.push(`provider ${p.providerRequired} ceiling too low for this repair`); }
    const ok = cost === "PASS" && capacity === "ACCEPT" && pol === "PASS";
    out.push({ ...p, gates: { cost, capacity, policy: pol, reasons }, status: ok ? "GATED_OK" : "GATED_BLOCKED" });
  }
  return out;
}

export type RepairAuthorization = { repairId: string; authorizedBy: string; reservationId: string; at: string };

/** A person authorizes ONE gated plan. Nothing else can move a plan to AUTHORIZED. */
export function authorizeRepair(p: RepairPlan, auth: RepairAuthorization): RepairPlan {
  if (p.status !== "GATED_OK") throw new RepairAuthorizationError(`${p.repairId} is ${p.status}: only GATED_OK plans can be authorized`);
  if (auth.repairId !== p.repairId || !auth.authorizedBy.trim() || !auth.reservationId.trim()) throw new RepairAuthorizationError("authorization must name the repair, a person and a reservation");
  return { ...p, status: "AUTHORIZED" };
}

/**
 * Execution port: the caller supplies the paid executor (which must go through the PI ledger).
 * Without AUTHORIZED status the executor is never invoked; in tests the executor counts calls.
 */
export async function executeRepair(p: RepairPlan, executor: (plan: RepairPlan) => Promise<{ resultRef: string; actualUsd: number }>): Promise<RepairPlan & { result: { resultRef: string; actualUsd: number } }> {
  if (p.status !== "AUTHORIZED") throw new RepairAuthorizationError(`${p.repairId} is ${p.status}: SMART_REPAIR cannot spend without an explicit authorization`);
  const result = await executor(p);
  return { ...p, status: "EXECUTED", result };
}

export const affectedRange = (e: MasterEdl, p: RepairPlan) => { const s = p.affected.shotId ? slotsSorted(e).find((x) => x.shotId === p.affected.shotId) : null; return s ? { startSec: s.startSec, endSec: slotEnd(s) } : { startSec: p.affected.startSec, endSec: p.affected.endSec }; };
