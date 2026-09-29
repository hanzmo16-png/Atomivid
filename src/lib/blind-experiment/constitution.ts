/**
 * C1-C16 of PI V1.1, checked by the experiment harness on the shadow plan (same checks as
 * scripts/pi-exam/exam-v1_1.ts). Any violation makes the blind test FAIL.
 */
import { isProtectedExistingAsset, type ShotContract } from "../production-intelligence/contract";
import { decide, upgradeReasonInvalidity, type DecideInput } from "../production-intelligence/decide";
import { isGenerativeVideo } from "../production-intelligence/ladder";
import { planMix, type MixInput, type MixPlan } from "../production-intelligence/mix";
import { methodAllowed, type ProductionProfile } from "../production-intelligence/profiles";
import { reserveProject } from "../production-intelligence/budget";
import { idempotencyKey } from "../production-intelligence/ledger";
import { auditUnusedPaidAssets, gateMaster } from "../production-intelligence/qa-gate";
import { assessCapacity } from "../production-intelligence/capacity/capacity";
import { runwaySnapshot } from "../production-intelligence/capacity/adapters";
import { runShadow } from "../production-intelligence/shadow";
import { pinProject } from "../production-intelligence/pin";

export function checkConstitution(input: MixInput, p: MixPlan, networkCalls: number, now: string): string[] {
  const v: string[] = [];
  const P = input.profile, POL = input.policy, projectId = input.pin.projectId;
  const byId = new Map(input.contracts.map((c) => [c.shotId, c]));
  const res = reserveProject(projectId, p, input.projectBudgetUsd);
  if (res.status !== "RESERVED" || p.worstCaseUsd > res.reservedUsd) v.push(`C1 worst ${p.worstCaseUsd} vs reserved ${res.reservedUsd} (${res.status})`);
  const base = (c: ShotContract, s?: MixPlan["shots"][number]): DecideInput => ({ contract: c, profile: P, policy: POL, rateCard: input.rateCard, memorySnapshotId: input.memorySnapshotId, pin: input.pin, attempt: 1, failure: null, stillQa: "PASS", requestedMethod: "I2V_ECONOMY", upgradeReason: s?.decision.upgradeReason ?? "MOTION_ESSENTIAL", budget: { remainingReservedUsd: input.projectBudgetUsd, generativeSecondsRemaining: p.generativeSecondsBudget, heroRemaining: P.heroQuota } });
  for (const s of p.shots) {
    const c = byId.get(s.shotId)!;
    if (!s.reasons.length) v.push(`E reasons missing ${s.shotId}`);
    if (c.shotClass === "multi_human" && s.method === "I2V_ECONOMY") v.push(`C3 ${s.shotId}`);
    if (s.decision.maxCostUsd > input.projectBudgetUsd) v.push(`C10 ${s.shotId}`);
    if (isProtectedExistingAsset(c)) {
      if (s.method !== "EXISTING_APPROVED_ASSET" || s.decision.maxCostUsd !== 0 || s.upgradeRank !== null) v.push(`C13 ${s.shotId} ${s.method}`);
      if (decide(base(c)).method !== "EXISTING_APPROVED_ASSET") v.push(`C13 direct I2V request repurchases ${s.shotId}`);
    }
    if (isGenerativeVideo(s.method)) {
      if (isGenerativeVideo(decide({ ...base(c, s), stillQa: "FAIL" }).method)) v.push(`C2 ${s.shotId}`);
      const sem = decide({ ...base(c, s), requestedMethod: s.method, failure: { kind: "semantic", method: s.method, variant: s.decision.variant } });
      if (sem.method === s.method && sem.variant === s.decision.variant) v.push(`C4 ${s.shotId}`);
      const tr = decide({ ...base(c, s), requestedMethod: s.method, failure: { kind: "transport", method: s.method, variant: s.decision.variant, infrastructureRetriesUsed: 0 } });
      const k = (m: string) => idempotencyKey({ projectId, shotId: c.shotId, provider: "runway", model: "gen4_turbo", method: m, inputFingerprint: "still-sha", attemptOrdinal: 1 });
      if (tr.attemptKind !== "infrastructure_retry" || k(tr.method) !== k(s.method)) v.push(`C5 ${s.shotId}`);
      if (upgradeReasonInvalidity(c, s.method, s.decision.upgradeReason) || !s.decision.reasons.includes(`upgradeReason: ${s.decision.upgradeReason}`)) v.push(`C15 ${s.shotId}`);
      if (decide({ ...base(c, s), requestedMethod: s.method, upgradeReason: undefined }).method === s.method) v.push(`C15 ${s.shotId} generates without a reason`);
      if (c.motionLeverage === "LOW") v.push(`C14 LOW-leverage ${s.shotId} generated`);
      if (c.motionLeverage === "MEDIUM" && s.decision.upgradeReason !== "TIMELINE_RHYTHM_NEED") v.push(`C14 MEDIUM ${s.shotId} generated without a rhythm need`);
    }
  }
  if (p.heroShots > P.heroQuota) v.push(`C6 hero ${p.heroShots} > ${P.heroQuota}`);
  if (p.generativeSecondsUsed > p.generativeSecondsBudget) v.push(`C7 ${p.generativeSecondsUsed} > ${p.generativeSecondsBudget}`);
  const intended = p.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => ({ assetId: s.shotId, paid: true, approved: true, intendedForMaster: true, kind: "clip" as const }));
  const rendered = p.shots.map((s) => ({ slotId: s.shotId, assetId: s.shotId, kind: isGenerativeVideo(s.method) ? "clip" : "still" }));
  if (!gateMaster(auditUnusedPaidAssets(intended, rendered)).pass) v.push("C8 false positive on the planned render");
  if (intended.length) { const dropped = rendered.map((r) => (r.assetId === intended[0].assetId ? { ...r, kind: "still" } : r)); if (gateMaster(auditUnusedPaidAssets(intended, dropped)).pass) v.push("C8 missed a dropped clip"); }
  if (assessCapacity(runwaySnapshot(p.worstCaseUsd, 0, now)).status === "GREEN") v.push("C9");
  const shadowCopy = { ...POL, policyVersion: POL.policyVersion + "-shadow-copy", status: "SHADOW" as const };
  for (const s of p.shots) if (runShadow({ ...base(byId.get(s.shotId)!, s), requestedMethod: s.decision.method }, shadowCopy).estimatedDelta.methodChanged) v.push(`C11 shadow copy diverged on ${s.shotId}`);
  if (networkCalls > 0) v.push(`C11 network calls ${networkCalls}`);
  const c0 = input.contracts[0];
  const strip = (d: ReturnType<typeof decide>) => JSON.stringify({ ...d, decisionHash: "" });
  if (strip(decide(base(c0))) !== strip(decide({ ...base(c0), youtube: { views: 1e9 } } as DecideInput))) v.push("C12 distribution data changed a decision");
  // C14: doubling the budget may only add shots that were kept economical BY the budget.
  const big: ProductionProfile = { ...P, profileVersion: P.profileVersion + "-ceiling-probe", generativeSecondsPerFinishedMinute: 2 * P.generativeSecondsPerFinishedMinute, generativeSecondsCap: 2 * P.generativeSecondsCap };
  const probe = planMix({ ...input, profile: big, pin: pinProject({ ...input.pin, profileVersion: big.profileVersion }, input.pin.pinnedAt) });
  const gen = (x: MixPlan) => x.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => s.shotId);
  const budgetBound = new Set(p.shots.filter((s) => s.reasons.some((r) => r.includes("global generative budget"))).map((s) => s.shotId));
  for (const id of gen(probe).filter((x) => !gen(p).includes(x))) if (!budgetBound.has(id)) v.push(`C14 ${id} appears only because more budget exists`);
  for (const t of p.rhythm?.treatments ?? []) if (t.generative && (t.nonGenerativeAvailable || methodAllowed(P, "STILL_PARALLAX"))) v.push(`C16 ${t.shotId} generated for rhythm while parallax was available`);
  return v;
}
