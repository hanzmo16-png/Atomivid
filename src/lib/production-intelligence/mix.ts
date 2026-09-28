/**
 * Mix Engine: optimizes the WHOLE timeline, not shot by shot.
 * 1) every shot starts at its cheapest compatible method (floor);
 * 2) upgrade candidates are ranked by motion leverage and risk;
 * 3) upgrades stop at the global generative-seconds budget, hero quota and project budget.
 * A collection of locally reasonable upgrades can therefore never inflate the mix.
 */
import type { ShotContract } from "./contract";
import { isGenerativeVideo, type Method } from "./ladder";
import { generativeSecondsBudget, type ProductionProfile } from "./profiles";
import type { Policy } from "./policy";
import type { RateCard } from "./rate-card";
import { decide, floorMethod, type Decision } from "./decide";
import type { ProjectPin } from "./pin";
import type { CapacityStatus } from "./capacity/capacity";

export type MixInput = {
  contracts: ShotContract[];
  finishedSeconds: number;
  profile: ProductionProfile;
  policy: Policy;
  rateCard: RateCard;
  pin: ProjectPin;
  memorySnapshotId: string;
  /** Reserved project budget available for this timeline (USD). */
  projectBudgetUsd: number;
  capacity?: Partial<Record<string, CapacityStatus>>;
};

export type MixShot = { shotId: string; method: Method; decision: Decision; upgradeRank: number | null; reasons: string[] };

export type MixPlan = {
  shots: MixShot[];
  generativeSecondsBudget: number;
  generativeSecondsUsed: number;
  generativeShots: number;
  heroShots: number;
  upgradeCandidates: number;
  expectedCostUsd: number;
  worstCaseUsd: number;
  reasons: string[];
};

const LEV = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const RISK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const MOT = { none: 0, camera_only: 1, simple: 2, complex: 3 } as const;

/** Deterministic upgrade ordering: essential motion first, then leverage, lower risk, cheaper, then id. */
function rank(a: ShotContract, b: ShotContract): number {
  const ess = (c: ShotContract) => (c.motionLeverage === "HIGH" && c.motionRequirement === "complex" ? 1 : 0);
  return ess(b) - ess(a) || LEV[b.motionLeverage] - LEV[a.motionLeverage] || MOT[b.motionRequirement] - MOT[a.motionRequirement] || RISK[a.riskClass] - RISK[b.riskClass] || a.desiredDuration - b.desiredDuration || a.shotId.localeCompare(b.shotId);
}

export function planMix(i: MixInput): MixPlan {
  const budgetSecs = generativeSecondsBudget(i.profile, i.finishedSeconds);
  const base = { profile: i.profile, policy: i.policy, rateCard: i.rateCard, pin: i.pin, memorySnapshotId: i.memorySnapshotId, attempt: 1, failure: null, capacity: i.capacity } as const;
  const planReasons: string[] = [`generative budget ${budgetSecs} s = min(${i.profile.generativeSecondsCap}, ${i.profile.generativeSecondsPerFinishedMinute} s/min x ${(i.finishedSeconds / 60).toFixed(2)} min) [${i.profile.profileVersion}]`];

  // Step 1: floor for everyone, with a budget that never allows paid motion.
  let usdLeft = i.projectBudgetUsd;
  const floorDecisions = new Map<string, Decision>();
  for (const c of i.contracts) {
    const d = decide({ ...base, contract: c, budget: { remainingReservedUsd: Number.MAX_SAFE_INTEGER, generativeSecondsRemaining: 0, heroRemaining: 0 } });
    floorDecisions.set(c.shotId, d);
    usdLeft -= d.maxCostUsd;
  }
  if (usdLeft < 0) planReasons.push(`WARNING: floor alone needs USD ${(i.projectBudgetUsd - usdLeft).toFixed(2)} worst case, above the project budget`);

  // Step 2-3: rank candidates whose meaning depends on motion.
  const minLev = LEV[i.policy.params.minUpgradeLeverage];
  const candidates = i.contracts.filter((c) => LEV[c.motionLeverage] >= minLev && (c.motionRequirement === "simple" || c.motionRequirement === "complex")).sort(rank);
  planReasons.push(`${candidates.length} of ${i.contracts.length} shots are upgrade candidates (leverage >= ${i.policy.params.minUpgradeLeverage} and motion required)`);

  // Step 4: allocate within global limits.
  let secsLeft = budgetSecs, heroLeft = i.profile.heroQuota;
  const upgraded = new Map<string, { d: Decision; rank: number }>();
  const skipped: string[] = [];
  const skipWhy = new Map<string, string>();
  candidates.forEach((c, idx) => {
    const want: Method = c.qualityTier === "hero" && heroLeft > 0 && c.motionLeverage === "HIGH" ? "I2V_HERO" : "I2V_ECONOMY";
    const floorCost = floorDecisions.get(c.shotId)!.maxCostUsd;
    const d = decide({ ...base, contract: c, requestedMethod: want, budget: { remainingReservedUsd: Math.max(0, usdLeft + floorCost), generativeSecondsRemaining: secsLeft, heroRemaining: heroLeft } });
    if (isGenerativeVideo(d.method)) {
      secsLeft -= d.generativeSeconds;
      if (d.method === "I2V_HERO") heroLeft -= 1;
      usdLeft += floorCost - d.maxCostUsd;
      upgraded.set(c.shotId, { d, rank: idx + 1 });
    } else {
      const why = d.reasons.filter((r) => !r.startsWith("requested") && !r.startsWith("memory")).join("; ");
      skipWhy.set(c.shotId, `upgrade candidate #${idx + 1} kept economical: ${why}`);
      skipped.push(`${c.shotId}: ${why}`);
    }
  });

  const shots: MixShot[] = i.contracts.map((c) => {
    const u = upgraded.get(c.shotId);
    const d = u?.d ?? floorDecisions.get(c.shotId)!;
    const why = u ? [`upgrade #${u.rank} by motion leverage ${c.motionLeverage}`, ...d.reasons] : skipWhy.has(c.shotId) ? [...d.reasons, skipWhy.get(c.shotId)!] : d.reasons;
    return { shotId: c.shotId, method: d.method, decision: d, upgradeRank: u?.rank ?? null, reasons: why };
  });
  const gen = shots.filter((s) => isGenerativeVideo(s.method));
  const used = gen.reduce((a, s) => a + s.decision.generativeSeconds, 0);
  planReasons.push(`${gen.length} generative shots, ${used}/${budgetSecs} s; ${skipped.length} candidates kept economical`);
  return {
    shots,
    generativeSecondsBudget: budgetSecs,
    generativeSecondsUsed: used,
    generativeShots: gen.length,
    heroShots: gen.filter((s) => s.method === "I2V_HERO").length,
    upgradeCandidates: candidates.length,
    expectedCostUsd: Math.round(shots.reduce((a, s) => a + s.decision.expectedCostUsd, 0) * 1e4) / 1e4,
    worstCaseUsd: Math.round(shots.reduce((a, s) => a + s.decision.maxCostUsd, 0) * 1e4) / 1e4,
    reasons: [...planReasons, ...skipped.map((s) => "kept economical " + s)],
  };
}

export { floorMethod };
