/**
 * PI V1.1 CANDIDATE adversarial re-exam. Same methodology and inputs as the V1 exam (exam.ts):
 * same DULCE contracts + human sets, same Ocean normalization (lib.ts), same S1/S2/S3 scenarios,
 * same budgets, same 8 s/min, same rate card, memory mem_empty. Only policy/profile change
 * (POLICY_V1_1 + PROFILES_V1_1). DULCE additionally gets the storyboard timeline (dulce-timeline.json).
 * Zero providers, zero spend: global fetch throws for the whole run.
 * Writes docs/pi-exam/results-v1_1.json. Usage: npx tsx scripts/pi-exam/exam-v1_1.ts
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { parseShotContract, isProtectedExistingAsset, type ShotContract, type ShotContractInput } from "@/lib/production-intelligence/contract";
import { PROFILES_V1_1, generativeSecondsBudget, methodAllowed, type ProductionProfile } from "@/lib/production-intelligence/profiles";
import { POLICY_V1_1, type Policy } from "@/lib/production-intelligence/policy";
import { RATE_CARD_V1 } from "@/lib/production-intelligence/rate-card";
import { planMix, type MixPlan, type TimelineSlot } from "@/lib/production-intelligence/mix";
import { decide, upgradeReasonInvalidity, type DecideInput } from "@/lib/production-intelligence/decide";
import { pinProject } from "@/lib/production-intelligence/pin";
import { reserveProject } from "@/lib/production-intelligence/budget";
import { idempotencyKey } from "@/lib/production-intelligence/ledger";
import { auditUnusedPaidAssets, gateMaster } from "@/lib/production-intelligence/qa-gate";
import { assessCapacity } from "@/lib/production-intelligence/capacity/capacity";
import { runwaySnapshot } from "@/lib/production-intelligence/capacity/adapters";
import { runShadow } from "@/lib/production-intelligence/shadow";
import { isGenerativeVideo } from "@/lib/production-intelligence/ladder";
import { r4, overlap, sb, FINISHED, BUDGET, oceanContract } from "./lib";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden during the exam"); }) as typeof fetch;

const POL = POLICY_V1_1;
const P = PROFILES_V1_1.LONGFORM_16X9;
const NOW = "2026-09-29T00:00:00.000Z";
const head = execSync("git rev-parse HEAD").toString().trim();
const treeHash = execSync("git ls-tree -r HEAD src/lib/production-intelligence | sha256sum").toString().slice(0, 64);
const dirty = execSync("git status --porcelain src/lib/production-intelligence scripts/pi-exam").toString().trim();
const V1 = JSON.parse(fs.readFileSync("docs/pi-exam/results.json", "utf8"));
const pinOf = (projectId: string, profile: ProductionProfile = P, policy: Policy = POL) => pinProject({ projectId, policyVersion: policy.policyVersion, profileVersion: profile.profileVersion, contractVersion: "shot-contract/1", rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId: "mem_empty" }, NOW);
const motionUsd = (s: MixPlan["shots"][number]) => r4(s.decision.generativeSeconds * RATE_CARD_V1.entries["runway:gen4_turbo"].price);
const genIds = (p: MixPlan) => p.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => s.shotId).sort();

function plan(projectId: string, contracts: ShotContract[], finishedSeconds: number, projectBudgetUsd: number, timeline?: TimelineSlot[], profile: ProductionProfile = P) {
  return planMix({ contracts, finishedSeconds, profile, policy: POL, rateCard: RATE_CARD_V1, pin: pinOf(projectId, profile), memorySnapshotId: "mem_empty", projectBudgetUsd, ...(timeline ? { timeline } : {}) });
}

/** UNJUSTIFIED_GENERATIVE_UPGRADES: generative shots without a valid upgradeReason (any > 0 = FAIL). */
function unjustified(contracts: ShotContract[], p: MixPlan) {
  return p.shots.filter((s) => isGenerativeVideo(s.method)).flatMap((s) => {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    const why = upgradeReasonInvalidity(c, s.method, s.decision.upgradeReason) ?? (s.decision.reasons.includes(`upgradeReason: ${s.decision.upgradeReason}`) ? null : "upgradeReason missing from reasons[]");
    return why ? [{ shotId: s.shotId, why }] : [];
  });
}

// ---------- constitution C1-C16 ----------
function constitution(projectId: string, contracts: ShotContract[], p: MixPlan, projectBudgetUsd: number, finishedSeconds: number, timeline?: TimelineSlot[]) {
  const v: string[] = [];
  const res = reserveProject(projectId, p, projectBudgetUsd);
  if (res.status !== "RESERVED" || p.worstCaseUsd > res.reservedUsd) v.push(`C1 worst ${p.worstCaseUsd} vs reserved ${res.reservedUsd} (${res.status})`);
  const base = (c: ShotContract, s?: MixPlan["shots"][number]): DecideInput => ({ contract: c, profile: P, policy: POL, rateCard: RATE_CARD_V1, memorySnapshotId: "mem_empty", pin: pinOf(projectId), attempt: 1, failure: null, stillQa: "PASS", requestedMethod: "I2V_ECONOMY", upgradeReason: s?.decision.upgradeReason ?? "MOTION_ESSENTIAL", budget: { remainingReservedUsd: projectBudgetUsd, generativeSecondsRemaining: p.generativeSecondsBudget, heroRemaining: P.heroQuota } });
  for (const s of p.shots) {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    if (!s.reasons.length) v.push(`E reasons missing ${s.shotId}`);
    if (c.shotClass === "multi_human" && s.method === "I2V_ECONOMY") v.push(`C3 ${s.shotId}`);
    if (s.decision.maxCostUsd > projectBudgetUsd) v.push(`C10 ${s.shotId}`);
    // C13: no automatic repurchase of an existing approved usable asset (plan AND a direct adversarial request).
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
      // C15: every generative decision carries a valid upgradeReason, also written in reasons[].
      if (upgradeReasonInvalidity(c, s.method, s.decision.upgradeReason) || !s.decision.reasons.includes(`upgradeReason: ${s.decision.upgradeReason}`)) v.push(`C15 ${s.shotId}`);
      if (decide({ ...base(c, s), requestedMethod: s.method, upgradeReason: undefined }).method === s.method) v.push(`C15 ${s.shotId} generates without a reason`);
    }
  }
  if (p.heroShots > P.heroQuota) v.push(`C6 hero ${p.heroShots} > ${P.heroQuota}`);
  if (p.generativeSecondsUsed > p.generativeSecondsBudget) v.push(`C7 ${p.generativeSecondsUsed} > ${p.generativeSecondsBudget}`);
  const intended = p.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => ({ assetId: s.shotId, paid: true, approved: true, intendedForMaster: true, kind: "clip" as const }));
  const rendered = p.shots.map((s) => ({ slotId: s.shotId, assetId: s.shotId, kind: isGenerativeVideo(s.method) ? "clip" : "still" }));
  if (!gateMaster(auditUnusedPaidAssets(intended, rendered)).pass) v.push("C8 false positive on the planned render");
  if (intended.length) { const dropped = rendered.map((r) => (r.assetId === intended[0].assetId ? { ...r, kind: "still" } : r)); if (gateMaster(auditUnusedPaidAssets(intended, dropped)).pass) v.push("C8 missed a dropped clip"); }
  if (assessCapacity(runwaySnapshot(p.worstCaseUsd, 0, NOW)).status === "GREEN") v.push("C9");
  const shadow: Policy = { ...POL, policyVersion: "policy/1.1.0-candidate-shadow-copy", status: "SHADOW" };
  for (const s of p.shots) {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    const cmp = runShadow({ ...base(c, s), requestedMethod: s.decision.method }, shadow);
    if (cmp.estimatedDelta.methodChanged) v.push(`shadow copy diverged on ${s.shotId}`);
  }
  if (networkCalls > 0) v.push(`C11 network calls ${networkCalls}`);
  const c0 = contracts[0];
  const plain = decide(base(c0));
  const withYt = decide({ ...base(c0), youtube: { views: 1e9, retention: 0.9 } } as DecideInput);
  const strip = (d: typeof plain) => ({ ...d, decisionHash: "" });
  if (JSON.stringify(strip(plain)) !== JSON.stringify(strip(withYt))) v.push("C12 distribution data changed a decision");
  const importsDistribution = execSync("grep -rl \"distribution\" src/lib/production-intelligence --include=*.ts | grep -v test || true").toString().trim();
  if (importsDistribution) v.push(`C12 engine references distribution: ${importsDistribution}`);
  // C14: the budget is a ceiling. Doubling it may only add shots that were kept economical BY the budget.
  const big: ProductionProfile = { ...P, profileVersion: P.profileVersion + "-ceiling-probe", generativeSecondsPerFinishedMinute: 2 * P.generativeSecondsPerFinishedMinute, generativeSecondsCap: 2 * P.generativeSecondsCap };
  const probe = planMix({ contracts, finishedSeconds, profile: big, policy: POL, rateCard: RATE_CARD_V1, pin: pinOf(projectId, big), memorySnapshotId: "mem_empty", projectBudgetUsd, ...(timeline ? { timeline } : {}) });
  const budgetBound = new Set(p.shots.filter((s) => s.reasons.some((r) => r.includes("global generative budget"))).map((s) => s.shotId));
  for (const id of genIds(probe).filter((x) => !genIds(p).includes(x))) if (!budgetBound.has(id)) v.push(`C14 ${id} appears only because more budget exists`);
  for (const s of p.shots.filter((x) => isGenerativeVideo(x.method))) {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    if (c.motionLeverage === "LOW") v.push(`C14 LOW-leverage ${s.shotId} generated`);
    if (c.motionLeverage === "MEDIUM" && s.decision.upgradeReason !== "TIMELINE_RHYTHM_NEED") v.push(`C14 MEDIUM ${s.shotId} generated without a rhythm need`);
  }
  // C16: a generative rhythm treatment is legal only when no non-generative treatment was available.
  for (const t of p.rhythm?.treatments ?? []) if (t.generative && (t.nonGenerativeAvailable || methodAllowed(P, "STILL_PARALLAX"))) v.push(`C16 ${t.shotId} generated for rhythm while parallax was available`);
  return { violations: v, reservation: res };
}

// ================= DULCE =================
const dm = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-mix-contracts.json", "utf8"));
const dt = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-timeline.json", "utf8"));
const smart = JSON.parse(fs.readFileSync("content/long-form/dulce-part1/smart-mix.json", "utf8"));
const dContracts: ShotContract[] = dm.contracts.map((c: ShotContractInput) => parseShotContract(c));
const tl = dt.slots as TimelineSlot[];
const dPlan = plan("dulce-sim", dContracts, dm.finishedSeconds, 40, tl);
const dPlan2 = plan("dulce-sim", dContracts, dm.finishedSeconds, 40, tl);
const dNoTimeline = plan("dulce-sim", dContracts, dm.finishedSeconds, 40);
const humanPlanned: string[] = V1.dulce.sets.HUMAN_PLANNED;
const humanUsed: string[] = V1.dulce.sets.HUMAN_USED;
const piV1: string[] = V1.dulce.sets.PI_SELECTED;
const piV11 = genIds(dPlan);
const clipOf = (a: string) => smart.clips.find((c: { asset: string }) => c.asset === a);
const humanSecs = (ids: string[]) => ids.reduce((t, a) => t + (clipOf(a)?.recommendedMethod === "i2v_hero" ? 10 : 5), 0);
const min = dm.finishedSeconds / 60;
const row = (name: string, ids: string[], secs: number, expected: number | null, worst: number | null) => ({ name, clips: ids.length, seconds: secs, perMinute: r4(secs / min), videoUsd: r4(secs * 0.05), expectedTotalUsd: expected, worstCaseUsd: worst });
const dConst = constitution("dulce-sim", dContracts, dPlan, 40, dm.finishedSeconds, tl);
const shotView = (id: string) => { const s = dPlan.shots.find((x) => x.shotId === id)!; const c = dContracts.find((x) => x.shotId === id)!; return { shotId: id, motionLeverage: c.motionLeverage, shotClass: c.shotClass, method: s.method, upgradeReason: s.decision.upgradeReason ?? null, slots: (dPlan.timeline ?? []).filter((t) => t.shotId === id).map((t) => ({ slotId: t.slotId, motion: t.motion })), reasons: s.reasons }; };
const dulce = {
  timelineFixture: { source: dt.source, sourceSha256: dt.sourceSha256, slots: tl.length, fixedSlots: tl.filter((s) => s.fixed).length, totalSeconds: dt.totalSeconds },
  sets: { HUMAN_PLANNED: humanPlanned, HUMAN_USED: humanUsed, PI_V1: piV1, PI_V1_1: piV11 },
  overlap: [overlap("PI_V1 vs HUMAN_PLANNED", piV1, humanPlanned), overlap("PI_V1 vs HUMAN_USED", piV1, humanUsed), overlap("PI_V1_1 vs HUMAN_PLANNED", piV11, humanPlanned), overlap("PI_V1_1 vs HUMAN_USED", piV11, humanUsed), overlap("PI_V1_1 vs PI_V1", piV11, piV1)],
  economics: [
    row("HUMAN_PLANNED", humanPlanned, humanSecs(humanPlanned), null, null),
    row("HUMAN_USED", humanUsed, humanSecs(humanUsed), null, null),
    row("PI_V1", piV1, V1.dulce.economics.pi.generativeSeconds, V1.dulce.economics.pi.expectedTotalUsd, V1.dulce.economics.pi.worstCaseReservedUsd),
    row("PI_V1_1", piV11, dPlan.generativeSecondsUsed, dPlan.expectedCostUsd, dPlan.worstCaseUsd),
  ],
  generativeBudgetSeconds: dPlan.generativeSecondsBudget,
  unusedGenerativeSeconds: dPlan.unusedGenerativeSeconds,
  UNJUSTIFIED_GENERATIVE_UPGRADES: unjustified(dContracts, dPlan),
  upgradeReasons: Object.fromEntries(dPlan.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => [s.shotId, s.decision.upgradeReason])),
  rhythm: dPlan.rhythm,
  rhythmWithoutTimeline: { violationsBefore: dNoTimeline.rhythm?.violationsBefore, treatments: dNoTimeline.rhythm?.treatments.length, generative: genIds(dNoTimeline) },
  regressionEvidence: { N26: shotView("N26"), N48: shotView("N48"), N05: shotView("N05"), N33: shotView("N33"), N43: shotView("N43") },
  droppedVsV1: piV1.filter((x) => !piV11.includes(x)).map(shotView),
  addedVsV1: piV11.filter((x) => !piV1.includes(x)).map(shotView),
  constitution: dConst.violations,
  deterministic: JSON.stringify(dPlan) === JSON.stringify(dPlan2),
  reasonsCoverage: r4(dPlan.shots.filter((s) => s.reasons.length > 0).length / dPlan.shots.length),
  planReasons: dPlan.reasons,
};

// ================= OCEAN (same inputs as V1) =================
const scenarios: Record<string, "LOW" | "MEDIUM" | "HIGH"> = { S1_primary: "MEDIUM", S2: "HIGH", S3: "LOW" };
const REGRESSION = ["b1-s1", "b1-s4"];
const ocean: Record<string, unknown> = {};
let oceanFail: string[] = [];
for (const [name, lev] of Object.entries(scenarios)) {
  const contracts = sb.shots.map((s) => oceanContract(s, lev));
  const p = plan(`ocean-${name}`, contracts, FINISHED, BUDGET);
  const p2 = plan(`ocean-${name}`, contracts, FINISHED, BUDGET);
  const cons = constitution(`ocean-${name}`, contracts, p, BUDGET, FINISHED);
  const sel = genIds(p);
  const v1 = V1.ocean[name];
  const reg = REGRESSION.map((id) => { const s = p.shots.find((x) => x.shotId === id)!; return { shotId: id, method: s.method, expectedUsd: s.decision.expectedCostUsd, worstUsd: s.decision.maxCostUsd, candidate: s.upgradeRank !== null, pass: s.method === "EXISTING_APPROVED_ASSET" && s.decision.maxCostUsd === 0 && s.decision.expectedCostUsd === 0 && s.upgradeRank === null }; });
  const unj = unjustified(contracts, p);
  const det = JSON.stringify(p) === JSON.stringify(p2);
  if (reg.some((r) => !r.pass)) oceanFail.push(`${name}: regression ${reg.filter((r) => !r.pass).map((r) => r.shotId).join(",")}`);
  if (cons.violations.length) oceanFail.push(`${name}: constitution ${cons.violations.join("; ")}`);
  if (unj.length) oceanFail.push(`${name}: unjustified ${unj.map((u) => u.shotId).join(",")}`);
  if (!det) oceanFail.push(`${name}: non-deterministic`);
  ocean[name] = {
    aiRecreationLeverage: lev, budgetSeconds: p.generativeSecondsBudget, heroQuota: P.heroQuota,
    regression: reg,
    V1: { gen: v1.piGenerativeShots, secs: v1.piGenerativeSeconds, perMinute: v1.piPerMinute, videoUsd: v1.piVideoUsd, expectedUsd: v1.piExpectedUsd, worstUsd: v1.piWorstCaseUsd },
    V1_1: { gen: sel, secs: p.generativeSecondsUsed, perMinute: r4(p.generativeSecondsUsed / (FINISHED / 60)), heroShots: p.heroShots, videoUsd: r4(p.shots.reduce((t, s) => t + motionUsd(s), 0)), expectedUsd: p.expectedCostUsd, worstUsd: p.worstCaseUsd, unusedGenerativeSeconds: p.unusedGenerativeSeconds, upgradeCandidates: p.upgradeCandidates },
    delta: { removed: v1.piGenerativeShots.filter((x: string) => !sel.includes(x)), added: sel.filter((x) => !v1.piGenerativeShots.includes(x)), expectedUsd: r4(p.expectedCostUsd - v1.piExpectedUsd), worstUsd: r4(p.worstCaseUsd - v1.piWorstCaseUsd) },
    vsHumanPlanned: overlap("PI_V1_1 vs HUMAN_PLANNED (storyboard ai-animation)", sel, V1.ocean.baseline.oldPlannedGenerativeShots),
    UNJUSTIFIED_GENERATIVE_UPGRADES: unj,
    rhythm: { violationsBefore: p.rhythm?.violationsBefore, violationsAfter: p.rhythm?.violationsAfter, treatments: p.rhythm?.treatments, unresolved: p.rhythm?.unresolved, minMotionDensity: p.rhythm?.minMotionDensity },
    constitution: cons.violations, reservation: cons.reservation.status, deterministic: det,
    reasonsCoverage: r4(p.shots.filter((s) => s.reasons.length).length / p.shots.length),
    perShot: p.shots.map((s) => ({ shotId: s.shotId, method: s.method, upgradeReason: s.decision.upgradeReason ?? null, piGeneratedSeconds: s.decision.generativeSeconds, expectedUsd: s.decision.expectedCostUsd, worstUsd: s.decision.maxCostUsd, reasons: s.reasons })),
  };
}
if (networkCalls > 0) oceanFail.push(`network calls ${networkCalls}`);
if (dulce.UNJUSTIFIED_GENERATIVE_UPGRADES.length || dulce.constitution.length) oceanFail = [...oceanFail, "DULCE constitution/unjustified (blocks the candidate)"];
const verdict = oceanFail.length ? "FAIL" : "PASS";

const out = {
  candidate: { commitAtRun: head, treeSha256AtRun: treeHash, workingTreeCleanForEngineAndExam: dirty === "", policyVersion: POL.policyVersion, profileVersion: P.profileVersion, rhythmLimits: P.rhythm, rateCardVersion: RATE_CARD_V1.rateCardVersion, contractVersion: "shot-contract/1", memorySnapshotId: "mem_empty", oceanBudgetSeconds: generativeSecondsBudget(P, FINISHED), timelineFixture: "dulce-timeline.json v" + dt.version },
  baselineV1: { commit: V1.frozen.commit, treeSha256: V1.frozen.expectedTreeSha256, results: "docs/pi-exam/results.json (unchanged)" },
  networkCalls, dulce, ocean,
  oceanVerdict: { verdict, failures: oceanFail, meaning: "PASS = eligible for a single-project pilot only; selection quality on Ocean stays unjudgeable (circular AI_RECREATION labels)" },
};
fs.writeFileSync("docs/pi-exam/results-v1_1.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ commit: head, tree: treeHash, clean: dirty === "", networkCalls, verdict, failures: oceanFail }, null, 1));
console.log("DULCE", JSON.stringify({ PI_V1_1: piV11, unjustified: dulce.UNJUSTIFIED_GENERATIVE_UPGRADES, unused: dulce.unusedGenerativeSeconds, economics: dulce.economics, overlap: dulce.overlap.map((o) => [o.comparison, o.intersection.length, o.piOnly, o.humanOnly, o.precision, o.recall, o.jaccard]), rhythm: { before: dPlan.rhythm?.violationsBefore, after: dPlan.rhythm?.violationsAfter, treat: dPlan.rhythm?.treatments.map((t) => [t.shotId, t.treatment, t.runSeconds, t.runSlots.length]), unresolved: dPlan.rhythm?.unresolved, density: dPlan.rhythm?.minMotionDensity }, cons: dulce.constitution }, null, 1));
for (const n of Object.keys(scenarios)) { const o = ocean[n] as Record<string, unknown>; console.log(n, JSON.stringify({ reg: o.regression, V1: o.V1, V1_1: o.V1_1, delta: o.delta, cons: o.constitution, rhythm: { b: (o.rhythm as { violationsBefore: number }).violationsBefore, a: (o.rhythm as { violationsAfter: number }).violationsAfter, t: ((o.rhythm as { treatments: unknown[] }).treatments ?? []).length, u: ((o.rhythm as { unresolved: unknown[] }).unresolved ?? []).length } })); }
