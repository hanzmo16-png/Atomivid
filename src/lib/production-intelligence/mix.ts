/**
 * Mix Engine: optimizes the WHOLE timeline, not shot by shot.
 * 1) every shot starts at its cheapest compatible method (floor);
 * 2) upgrade candidates are ranked by motion leverage and risk;
 * 3) upgrades stop at the global generative-seconds budget, hero quota and project budget.
 * A collection of locally reasonable upgrades can therefore never inflate the mix.
 */
import { hasFlag, isProtectedExistingAsset, type ShotContract } from "./contract";
import { isGenerativeVideo, type Method } from "./ladder";
import { generativeSecondsBudget, methodAllowed, type ProductionProfile } from "./profiles";
import type { Policy } from "./policy";
import type { RateCard } from "./rate-card";
import { decide, floorMethod, type Decision, type UpgradeReason } from "./decide";
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
  /** V1.1 rhythm: ordered on-screen slots. `fixed` marks slots not decided here (e.g. reused footage). Default: contracts in order. */
  timeline?: TimelineSlot[];
};

export type TimelineSlot = { slotId: string; shotId: string | null; seconds: number; fixed?: "live" | "static" };
export type SlotMotion = "live" | "depth" | "static";
export type RhythmTreatment = { runSlots: string[]; runSeconds: number; slotId: string; shotId: string; treatment: Method; generative: boolean; nonGenerativeAvailable: boolean; reason: string };

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
  // ---- V1.1 only ----
  unusedGenerativeSeconds?: number;
  timeline?: { slotId: string; shotId: string | null; seconds: number; method: Method | null; motion: SlotMotion; reasons: string[] }[];
  rhythm?: { limits: NonNullable<ProductionProfile["rhythm"]>; violationsBefore: number; violationsAfter: number; treatments: RhythmTreatment[]; unresolved: string[][]; minMotionDensity: number | null };
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
  const ceiling = !!i.policy.params.requireUpgradeReason;
  const reuse = !!i.policy.params.reuseApprovedAssets;
  // V1.1: the budget is a ceiling, so only shots with a positive reason compete (HIGH leverage = motion essential);
  // existing approved usable assets never enter the pool (R12).
  const candidates = i.contracts
    .filter((c) => !(reuse && isProtectedExistingAsset(c)))
    .filter((c) => (ceiling ? c.motionLeverage === "HIGH" : LEV[c.motionLeverage] >= minLev) && (c.motionRequirement === "simple" || c.motionRequirement === "complex"))
    .sort(rank);
  planReasons.push(ceiling
    ? `${candidates.length} of ${i.contracts.length} shots are upgrade candidates (HIGH leverage = MOTION_ESSENTIAL; budget is a ceiling, not a target${reuse ? "; approved reusable assets excluded" : ""})`
    : `${candidates.length} of ${i.contracts.length} shots are upgrade candidates (leverage >= ${i.policy.params.minUpgradeLeverage} and motion required)`);

  // Step 4: allocate within global limits.
  let secsLeft = budgetSecs, heroLeft = i.profile.heroQuota;
  const upgraded = new Map<string, { d: Decision; rank: number }>();
  const skipped: string[] = [];
  const skipWhy = new Map<string, string>();
  candidates.forEach((c, idx) => {
    const want: Method = c.qualityTier === "hero" && heroLeft > 0 && c.motionLeverage === "HIGH" ? "I2V_HERO" : "I2V_ECONOMY";
    const floorCost = floorDecisions.get(c.shotId)!.maxCostUsd;
    const upgradeReason: UpgradeReason | undefined = ceiling ? (want === "I2V_HERO" ? "HERO_VALUE" : "MOTION_ESSENTIAL") : undefined;
    const d = decide({ ...base, contract: c, requestedMethod: want, ...(upgradeReason ? { upgradeReason } : {}), budget: { remainingReservedUsd: Math.max(0, usdLeft + floorCost), generativeSecondsRemaining: secsLeft, heroRemaining: heroLeft } });
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

  // ---- V1.1 timeline rhythm (anti-slideshow), deterministic and global ----
  let rhythm: MixPlan["rhythm"]; let timelineOut: MixPlan["timeline"];
  const lim = i.profile.rhythm;
  if (i.policy.params.timelineRhythm && lim) {
    const byId = new Map(i.contracts.map((c) => [c.shotId, c]));
    const slots: TimelineSlot[] = i.timeline ?? i.contracts.map((c) => ({ slotId: c.shotId, shotId: c.shotId, seconds: c.desiredDuration }));
    const override = new Map<string, Method>();
    const slotWhy = new Map<string, string[]>();
    const methodOf = (sl: TimelineSlot): Method | null => (sl.shotId && byId.has(sl.shotId) ? override.get(sl.slotId) ?? (upgraded.get(sl.shotId)?.d ?? floorDecisions.get(sl.shotId)!).method : null);
    const motionOf = (sl: TimelineSlot): SlotMotion => {
      if (sl.fixed) return sl.fixed;
      const m = methodOf(sl); const c = sl.shotId ? byId.get(sl.shotId) : undefined;
      if (!m || !c) return "static";
      if (m === "EXISTING_APPROVED_ASSET") return c.existingAssetKind === "still" ? "static" : "live";
      if (m === "STOCK" || isGenerativeVideo(m)) return "live";
      if (m === "STILL_PARALLAX") return "depth";
      return "static";
    };
    const unresolvedStarts = new Set<number>();
    const runs = () => {
      const out: number[][] = []; let cur: number[] = [];
      slots.forEach((sl, k) => { if (motionOf(sl) === "static") cur.push(k); else { if (cur.length) out.push(cur); cur = []; } });
      if (cur.length) out.push(cur);
      return out;
    };
    const secsOf = (r: number[]) => Math.round(r.reduce((t, k) => t + slots[k].seconds, 0) * 100) / 100;
    const violates = (r: number[]) => secsOf(r) > lim.maxConsecutiveStillSeconds || r.length > lim.maxConsecutiveStillShots;
    const violationsBefore = runs().filter(violates).length;
    const treatments: RhythmTreatment[] = []; const unresolved: string[][] = [];
    const parallaxAllowed = methodAllowed(i.profile, "STILL_PARALLAX");
    const eligible = (k: number) => { const sl = slots[k]; const c = sl.shotId ? byId.get(sl.shotId) : undefined; const m = methodOf(sl); return !!c && !sl.fixed && c.shotClass !== "graphic" && c.shotClass !== "map" && (m === "STILL_KEN_BURNS" || m === "AI_STILL"); };
    // Mission order: leverage, semantic risk, identity risk, expected cost, position in run, existing-asset availability, id.
    const order = (run: number[]) => (a: number, b: number) => {
      const ca = byId.get(slots[a].shotId!)!, cb = byId.get(slots[b].shotId!)!, mid = (run[0] + run[run.length - 1]) / 2;
      return LEV[cb.motionLeverage] - LEV[ca.motionLeverage] || RISK[ca.riskClass] - RISK[cb.riskClass] || Number(hasFlag(ca, "identity_critical")) - Number(hasFlag(cb, "identity_critical"))
        || floorDecisions.get(ca.shotId)!.expectedCostUsd - floorDecisions.get(cb.shotId)!.expectedCostUsd || Math.abs(a - mid) - Math.abs(b - mid)
        || Number(!!ca.existingApprovedAssetId) - Number(!!cb.existingApprovedAssetId) || slots[a].slotId.localeCompare(slots[b].slotId);
    };
    for (let guard = 0; guard < 10 * slots.length; guard++) {
      const bad = runs().find((r) => violates(r) && !unresolvedStarts.has(r[0]));
      if (!bad) break;
      const why = `TIMELINE_RHYTHM_NEED: ${bad.length} consecutive flat stills / ${secsOf(bad)} s exceed ${lim.maxConsecutiveStillShots} shots / ${lim.maxConsecutiveStillSeconds} s [${i.profile.profileVersion}]`;
      const cands = bad.filter(eligible).sort(order(bad));
      if (parallaxAllowed && cands.length) {
        const k = cands[0];
        override.set(slots[k].slotId, "STILL_PARALLAX");
        slotWhy.set(slots[k].slotId, [...(slotWhy.get(slots[k].slotId) ?? []), `${why}; broken with STILL_PARALLAX (non-generative motion first, USD 0 extra)`]);
        treatments.push({ runSlots: bad.map((x) => slots[x].slotId), runSeconds: secsOf(bad), slotId: slots[k].slotId, shotId: slots[k].shotId!, treatment: "STILL_PARALLAX", generative: false, nonGenerativeAvailable: true, reason: why });
        continue;
      }
      // Only when no non-generative treatment exists: a MEDIUM/HIGH shot may be generated, inside the ceiling.
      let done = false;
      for (const k of cands.filter((x) => byId.get(slots[x].shotId!)!.motionLeverage !== "LOW" && !(reuse && isProtectedExistingAsset(byId.get(slots[x].shotId!)!)))) {
        const c = byId.get(slots[k].shotId!)!; const floorCost = floorDecisions.get(c.shotId)!.maxCostUsd;
        const d = decide({ ...base, contract: c, requestedMethod: "I2V_ECONOMY", upgradeReason: "TIMELINE_RHYTHM_NEED", budget: { remainingReservedUsd: Math.max(0, usdLeft + floorCost), generativeSecondsRemaining: secsLeft, heroRemaining: heroLeft } });
        if (!isGenerativeVideo(d.method)) continue;
        secsLeft -= d.generativeSeconds; usdLeft += floorCost - d.maxCostUsd;
        upgraded.set(c.shotId, { d, rank: candidates.length + treatments.length + 1 });
        treatments.push({ runSlots: bad.map((x) => slots[x].slotId), runSeconds: secsOf(bad), slotId: slots[k].slotId, shotId: c.shotId, treatment: d.method, generative: true, nonGenerativeAvailable: false, reason: why });
        done = true; break;
      }
      if (!done) { unresolvedStarts.add(bad[0]); unresolved.push(bad.map((x) => slots[x].slotId)); }
    }
    // Informative motion density: minimum share of non-static seconds in any window.
    let minDensity: number | null = null;
    const total = slots.reduce((t, sl) => t + sl.seconds, 0);
    if (total >= lim.motionDensityWindowSeconds) {
      const starts: number[] = []; let t0 = 0; for (const sl of slots) { starts.push(t0); t0 += sl.seconds; }
      for (let w = 0; w + lim.motionDensityWindowSeconds <= total + 1e-9; w += lim.motionDensityWindowSeconds / 2) {
        let moving = 0;
        slots.forEach((sl, k) => { const a = Math.max(w, starts[k]), b = Math.min(w + lim.motionDensityWindowSeconds, starts[k] + sl.seconds); if (b > a && motionOf(sl) !== "static") moving += b - a; });
        const share = Math.round((moving / lim.motionDensityWindowSeconds) * 1000) / 1000;
        minDensity = minDensity === null ? share : Math.min(minDensity, share);
      }
    }
    rhythm = { limits: lim, violationsBefore, violationsAfter: runs().filter(violates).length, treatments, unresolved, minMotionDensity: minDensity };
    timelineOut = slots.map((sl) => ({ slotId: sl.slotId, shotId: sl.shotId, seconds: sl.seconds, method: methodOf(sl), motion: motionOf(sl), reasons: slotWhy.get(sl.slotId) ?? [] }));
    planReasons.push(`rhythm: ${violationsBefore} over-long flat-still runs before, ${rhythm.violationsAfter} after; ${treatments.filter((t) => !t.generative).length} non-generative and ${treatments.filter((t) => t.generative).length} generative treatments`);
  }

  const shots: MixShot[] = i.contracts.map((c) => {
    const u = upgraded.get(c.shotId);
    const d = u?.d ?? floorDecisions.get(c.shotId)!;
    const why = u ? [`upgrade #${u.rank}${u.d.upgradeReason ? ` (${u.d.upgradeReason})` : ` by motion leverage ${c.motionLeverage}`}`, ...d.reasons] : skipWhy.has(c.shotId) ? [...d.reasons, skipWhy.get(c.shotId)!] : d.reasons;
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
    ...(ceiling ? { unusedGenerativeSeconds: budgetSecs - used } : {}),
    ...(rhythm ? { rhythm, timeline: timelineOut } : {}),
  };
}

export { floorMethod };
