/**
 * decide(): the single deterministic authority for "which method may this shot use,
 * at what maximum cost, with how many attempts". Fallback is part of it: a failure
 * context changes the next decision materially. Same inputs -> same decision
 * (decisionHash), and every outcome carries reasons[].
 */
import { hasFlag, CONTRACT_VERSION, type ShotContract } from "./contract";
import { isGenerativeVideo, type Method } from "./ladder";
import { methodAllowed, type ProductionProfile } from "./profiles";
import type { Policy } from "./policy";
import { providersFor, type RateCard } from "./rate-card";
import { costOf } from "./cost";
import { stableHash } from "./canonical";
import { assertPinned, type ProjectPin } from "./pin";
import type { CapacityStatus } from "./capacity/capacity";

export type FailureKind = "semantic" | "provider_no_output" | "transport" | "still_qa_fail";
export type FailureContext = { kind: FailureKind; method: Method; variant: "standard" | "simplified"; infrastructureRetriesUsed?: number } | null;

export type BudgetState = {
  /** Reserved project budget not yet consumed (USD). */
  remainingReservedUsd: number;
  /** Generative seconds still available under the profile's global budget. */
  generativeSecondsRemaining: number;
  heroRemaining: number;
};

export type DecideInput = {
  contract: ShotContract;
  profile: ProductionProfile;
  policy: Policy;
  rateCard: RateCard;
  /** Read-only memory snapshot id; V1 statistics are informative and never change the decision. */
  memorySnapshotId: string;
  pin: ProjectPin;
  /** Method proposed by the Mix Engine; absent = cheapest compatible. */
  requestedMethod?: Method;
  attempt: number;
  failure: FailureContext;
  budget: BudgetState;
  /** Result of still QA when known. A FAIL makes motion impossible. */
  stillQa?: "PASS" | "FAIL" | "PENDING";
  stillAttemptsUsed?: number;
  capacity?: Partial<Record<string, CapacityStatus>>;
};

export type Decision = {
  shotId: string;
  method: Method;
  variant: "standard" | "simplified";
  attemptKind: "initial" | "infrastructure_retry" | "simplified_retry" | "still_regeneration" | "none";
  blocked: boolean;
  eligibleProviders: string[];
  expectedCostUsd: number;
  maxCostUsd: number;
  authorizedAttempts: number;
  generativeSeconds: number;
  downgrade: { from: Method; to: Method } | null;
  reasons: string[];
  versions: { policyVersion: string; profileVersion: string; contractVersion: string; rateCardVersion: string; memorySnapshotId: string };
  decisionHash: string;
};

const HUMAN_CLASSES = new Set(["single_human", "multi_human", "talking_head", "human_creature"]);

/** Cheapest method that satisfies the contract without generative video. */
export function floorMethod(c: ShotContract, p: ProductionProfile): { method: Method; reason: string } {
  if (c.existingApprovedAssetId && methodAllowed(p, "EXISTING_APPROVED_ASSET")) return { method: "EXISTING_APPROVED_ASSET", reason: `reuse approved asset ${c.existingApprovedAssetId} (ladder step 1)` };
  if (c.stockAvailable && c.motionRequirement !== "complex" && methodAllowed(p, "STOCK")) return { method: "STOCK", reason: "licensed stock satisfies the contract (ladder step 2)" };
  if (p.minimumOnScreenMotion === "none" || c.shotClass === "graphic" || c.shotClass === "map") {
    if (p.minimumOnScreenMotion === "camera" && methodAllowed(p, "STILL_KEN_BURNS")) return { method: "STILL_KEN_BURNS", reason: "graphic/map with controlled camera motion" };
    return { method: "AI_STILL", reason: "still satisfies the contract" };
  }
  const depth = c.shotClass === "landscape" || c.shotClass === "corridor";
  if (depth && methodAllowed(p, "STILL_PARALLAX")) return { method: "STILL_PARALLAX", reason: "still + parallax camera motion (depth shot)" };
  return { method: "STILL_KEN_BURNS", reason: "still + controlled camera motion (cheapest moving picture)" };
}

function generativeBlockers(i: DecideInput, m: Method): string[] {
  const { contract: c, profile: p, policy } = i;
  const out: string[] = [];
  if (!methodAllowed(p, m)) out.push(`profile ${p.profileVersion} forbids ${m}`);
  if (i.stillQa === "FAIL") out.push("R03 still QA FAIL: motion generation is impossible until a still passes");
  if (c.motionLeverage === "LOW") out.push("LOW motion leverage: meaning does not depend on motion; premium is never chosen because it could look better");
  if (m === "I2V_ECONOMY" && p.economyForbiddenClasses.includes(c.shotClass)) out.push(`R01 ${c.shotClass} + economy video is forbidden by profile ${p.profileVersion}`);
  if (policy.params.humanCreatureNeedsHighLeverage && c.shotClass === "human_creature" && c.motionLeverage !== "HIGH") out.push("R02 human_creature without HIGH leverage: prefer still-motion");
  if (policy.params.identityCriticalLowLeverageStill && hasFlag(c, "identity_critical") && HUMAN_CLASSES.has(c.shotClass) && c.motionLeverage !== "HIGH") out.push("R04 identity-critical human without HIGH leverage: prefer still-motion");
  if (policy.params.elevatedRiskNeedsHighLeverage && c.motionLeverage !== "HIGH") {
    if (hasFlag(c, "complex_hands")) out.push("R05 complex hands/body action: elevated generative risk, motion not essential");
    if (hasFlag(c, "enter_exit_frame")) out.push("R06 people entering/exiting frame: elevated semantic risk, motion not essential");
  }
  if (c.maxGeneratedDuration <= 0) out.push("contract allows no generated seconds");
  return out;
}

export function decide(i: DecideInput): Decision {
  const { contract: c, profile: p, policy, rateCard } = i;
  assertPinned(i.pin, { policyVersion: policy.policyVersion, profileVersion: p.profileVersion, contractVersion: c.contractVersion, rateCardVersion: rateCard.rateCardVersion, memorySnapshotId: i.memorySnapshotId });
  const reasons: string[] = [];
  const floor = floorMethod(c, p);
  let method: Method = i.requestedMethod ?? floor.method;
  let variant: Decision["variant"] = "standard";
  let attemptKind: Decision["attemptKind"] = "initial";
  let downgrade: Decision["downgrade"] = null;
  let blocked = false;
  const lower = (to: Method, why: string) => { if (to !== method) downgrade = { from: downgrade?.from ?? method, to }; reasons.push(why); method = to; };
  if (!i.requestedMethod) reasons.push(`floor: ${floor.reason}`);
  else reasons.push(`requested by mix: ${i.requestedMethod}`);

  // ---- failure handling (fallback is part of decide) ----
  const f = i.failure;
  if (f?.kind === "still_qa_fail" || i.stillQa === "FAIL") {
    if ((i.stillAttemptsUsed ?? 0) < p.maxStillAttempts) {
      method = "AI_STILL"; attemptKind = "still_regeneration";
      reasons.push(`R03 still QA FAIL: regenerate the still (${(i.stillAttemptsUsed ?? 0) + 1}/${p.maxStillAttempts}); no motion until it passes`);
    } else {
      blocked = true; attemptKind = "none";
      reasons.push("R03 still QA FAIL and still attempts exhausted: blocked for human review; no paid motion");
    }
  } else if (f?.kind === "transport" && isGenerativeVideo(f.method)) {
    const used = f.infrastructureRetriesUsed ?? 0;
    if (used < policy.params.maxInfrastructureRetries) {
      method = f.method; variant = f.variant; attemptKind = "infrastructure_retry";
      reasons.push(`R09 transport failure: one infrastructure retry under the SAME idempotency key (${used + 1}/${policy.params.maxInfrastructureRetries}); a provider job already accepted is resumed, never resubmitted`);
    } else lower(floor.method, "R09 infrastructure retries exhausted: downgrade to still-motion");
  } else if (f && (f.kind === "semantic" || f.kind === "provider_no_output") && isGenerativeVideo(f.method)) {
    reasons.push(`R07 ${f.kind} on ${f.method}/${f.variant}: the identical paid attempt is never repeated`);
    const canSimplify = policy.params.allowSimplifiedRetryAfterSemanticFailure && f.kind === "semantic" && f.variant !== "simplified" && c.motionLeverage === "HIGH" && methodAllowed(p, "I2V_ECONOMY");
    if (canSimplify) {
      method = "I2V_ECONOMY"; variant = "simplified"; attemptKind = "simplified_retry";
      if (f.method !== "I2V_ECONOMY") downgrade = { from: f.method, to: "I2V_ECONOMY" };
      reasons.push("R08 HIGH leverage: one materially different attempt (simpler motion, shorter economy clip)");
    } else lower(floor.method, "R08 semantic failure: downgrade to approved still + controlled camera motion");
  }

  // ---- generative authorization ----
  if (!blocked && isGenerativeVideo(method)) {
    if (method === "I2V_HERO" && i.budget.heroRemaining <= 0) lower("I2V_ECONOMY", "R10 hero quota exhausted: a shot cannot self-promote to hero");
    const blockers = generativeBlockers(i, method);
    if (blockers.length) lower(floor.method, blockers.join("; "));
  }
  if (!blocked && isGenerativeVideo(method)) {
    const secs = rateCard.clipSeconds[method] ?? 0;
    if (secs > i.budget.generativeSecondsRemaining) lower(floor.method, `global generative budget: ${secs} s needed, ${i.budget.generativeSecondsRemaining} s left`);
  }
  if (!blocked && isGenerativeVideo(method) && i.capacity) {
    const red = providersFor(rateCard, method).filter((pr) => i.capacity?.[pr] === "RED");
    if (red.length) lower(floor.method, `provider capacity RED for ${red.join(", ")}`);
  }

  // ---- cost ----
  const stillExists = i.stillQa === "PASS";
  const attempts = isGenerativeVideo(method) ? Math.max(1, p.maxMotionAttempts) : 1;
  let cost = costOf(rateCard, method, { stillExists, attempts, stillAttempts: attemptKind === "still_regeneration" ? 1 : p.maxStillAttempts });
  if (!blocked && cost.worstCaseUsd > i.budget.remainingReservedUsd && isGenerativeVideo(method)) {
    lower(floor.method, `worst case USD ${cost.worstCaseUsd} exceeds remaining reserved budget USD ${i.budget.remainingReservedUsd}`);
    cost = costOf(rateCard, method, { stillExists, stillAttempts: p.maxStillAttempts });
  }
  if (!blocked && cost.worstCaseUsd > i.budget.remainingReservedUsd) {
    blocked = true; attemptKind = "none";
    reasons.push(`blocked: even the cheapest method (USD ${cost.worstCaseUsd}) exceeds the remaining reserved budget`);
  }
  if (!blocked && i.capacity) {
    const red = providersFor(rateCard, method).filter((pr) => i.capacity?.[pr] === "RED");
    if (red.length) { blocked = true; attemptKind = "none"; reasons.push(`blocked: provider capacity RED for ${red.join(", ")}`); }
    const unknown = providersFor(rateCard, method).filter((pr) => i.capacity?.[pr] === "UNKNOWN");
    if (unknown.length) reasons.push(`capacity UNKNOWN for ${unknown.join(", ")}: not verified, never treated as GREEN`);
  }
  reasons.push(`memory ${i.memorySnapshotId} is informative only in V1`);

  const versions = { policyVersion: policy.policyVersion, profileVersion: p.profileVersion, contractVersion: c.contractVersion ?? CONTRACT_VERSION, rateCardVersion: rateCard.rateCardVersion, memorySnapshotId: i.memorySnapshotId };
  const body = {
    shotId: c.shotId, method, variant, attemptKind, blocked,
    eligibleProviders: blocked ? [] : providersFor(rateCard, method),
    expectedCostUsd: blocked ? 0 : cost.expectedUsd,
    maxCostUsd: blocked ? 0 : cost.worstCaseUsd,
    authorizedAttempts: blocked ? 0 : isGenerativeVideo(method) ? (attemptKind === "infrastructure_retry" ? 1 : Math.max(1, p.maxMotionAttempts)) : attemptKind === "still_regeneration" ? 1 : p.maxStillAttempts,
    generativeSeconds: !blocked && isGenerativeVideo(method) ? cost.billedSeconds : 0,
    downgrade, reasons, versions,
  };
  return { ...body, decisionHash: stableHash({ input: { ...i, pin: i.pin }, output: body }) };
}
