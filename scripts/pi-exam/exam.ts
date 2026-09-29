/**
 * PI V1 adversarial exam. Imports the FROZEN engine (d1330e7) without modifying it.
 * Zero providers, zero spend: global fetch is replaced by a thrower for the whole run.
 * Writes docs/pi-exam/results.json. Usage: npx tsx scripts/pi-exam/exam.ts
 */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { parseShotContract, type ShotContract, type ShotContractInput } from "@/lib/production-intelligence/contract";
import { PROFILES, generativeSecondsBudget } from "@/lib/production-intelligence/profiles";
import { POLICY_V1, type Policy } from "@/lib/production-intelligence/policy";
import { RATE_CARD_V1 } from "@/lib/production-intelligence/rate-card";
import { planMix, type MixPlan } from "@/lib/production-intelligence/mix";
import { decide, type DecideInput } from "@/lib/production-intelligence/decide";
import { pinProject } from "@/lib/production-intelligence/pin";
import { reserveProject } from "@/lib/production-intelligence/budget";
import { idempotencyKey } from "@/lib/production-intelligence/ledger";
import { auditUnusedPaidAssets, gateMaster } from "@/lib/production-intelligence/qa-gate";
import { assessCapacity } from "@/lib/production-intelligence/capacity/capacity";
import { runwaySnapshot } from "@/lib/production-intelligence/capacity/adapters";
import { runShadow } from "@/lib/production-intelligence/shadow";
import { isGenerativeVideo } from "@/lib/production-intelligence/ladder";

// ---------- zero network ----------
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden during the exam"); }) as typeof fetch;

const P = PROFILES.LONGFORM_16X9;
const NOW = "2026-09-29T00:00:00.000Z";
const treeHash = execSync("git ls-tree -r HEAD src/lib/production-intelligence | sha256sum").toString().slice(0, 64);
const pin = (projectId: string) => pinProject({ projectId, policyVersion: POLICY_V1.policyVersion, profileVersion: P.profileVersion, contractVersion: "shot-contract/1", rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId: "mem_empty" }, NOW);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const motionUsd = (s: MixPlan["shots"][number]) => r4(s.decision.generativeSeconds * RATE_CARD_V1.entries["runway:gen4_turbo"].price);

function plan(projectId: string, contracts: ShotContract[], finishedSeconds: number, projectBudgetUsd: number) {
  return planMix({ contracts, finishedSeconds, profile: P, policy: POLICY_V1, rateCard: RATE_CARD_V1, pin: pin(projectId), memorySnapshotId: "mem_empty", projectBudgetUsd });
}

// ---------- constitution ----------
function constitution(projectId: string, contracts: ShotContract[], p: MixPlan, projectBudgetUsd: number) {
  const v: string[] = [];
  const res = reserveProject(projectId, p, projectBudgetUsd);
  if (res.status !== "RESERVED" || p.worstCaseUsd > res.reservedUsd) v.push(`C1 worst ${p.worstCaseUsd} vs reserved ${res.reservedUsd} (${res.status})`);
  const base = (c: ShotContract): DecideInput => ({ contract: c, profile: P, policy: POLICY_V1, rateCard: RATE_CARD_V1, memorySnapshotId: "mem_empty", pin: pin(projectId), attempt: 1, failure: null, stillQa: "PASS", requestedMethod: "I2V_ECONOMY", budget: { remainingReservedUsd: projectBudgetUsd, generativeSecondsRemaining: p.generativeSecondsBudget, heroRemaining: P.heroQuota } });
  for (const s of p.shots) {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    if (!s.reasons.length) v.push(`E reasons missing ${s.shotId}`);
    if (c.shotClass === "multi_human" && s.method === "I2V_ECONOMY") v.push(`C3 ${s.shotId}`);
    if (s.decision.maxCostUsd > projectBudgetUsd) v.push(`C10 ${s.shotId}`);
    if (isGenerativeVideo(s.method)) {
      if (isGenerativeVideo(decide({ ...base(c), stillQa: "FAIL" }).method)) v.push(`C2 ${s.shotId}`);
      const sem = decide({ ...base(c), requestedMethod: s.method, failure: { kind: "semantic", method: s.method, variant: s.decision.variant } });
      if (sem.method === s.method && sem.variant === s.decision.variant) v.push(`C4 ${s.shotId}`);
      const tr = decide({ ...base(c), requestedMethod: s.method, failure: { kind: "transport", method: s.method, variant: s.decision.variant, infrastructureRetriesUsed: 0 } });
      const k = (m: string) => idempotencyKey({ projectId, shotId: c.shotId, provider: "runway", model: "gen4_turbo", method: m, inputFingerprint: "still-sha", attemptOrdinal: 1 });
      if (tr.attemptKind !== "infrastructure_retry" || k(tr.method) !== k(s.method)) v.push(`C5 ${s.shotId}`);
    }
  }
  if (p.heroShots > P.heroQuota) v.push(`C6 hero ${p.heroShots} > ${P.heroQuota}`);
  if (p.generativeSecondsUsed > p.generativeSecondsBudget) v.push(`C7 ${p.generativeSecondsUsed} > ${p.generativeSecondsBudget}`);
  // C8: the audit must pass for the planned render and FAIL if one selected clip is dropped.
  const intended = p.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => ({ assetId: s.shotId, paid: true, approved: true, intendedForMaster: true, kind: "clip" as const }));
  const rendered = p.shots.map((s) => ({ slotId: s.shotId, assetId: s.shotId, kind: isGenerativeVideo(s.method) ? "clip" : "still" }));
  if (!gateMaster(auditUnusedPaidAssets(intended, rendered)).pass) v.push("C8 false positive on the planned render");
  if (intended.length) { const dropped = rendered.map((r) => (r.assetId === intended[0].assetId ? { ...r, kind: "still" } : r)); if (gateMaster(auditUnusedPaidAssets(intended, dropped)).pass) v.push("C8 missed a dropped clip"); }
  if (assessCapacity(runwaySnapshot(p.worstCaseUsd, 0, NOW)).status === "GREEN") v.push("C9");
  // C11: shadow over every shot with an identical SHADOW policy -> zero network, zero delta.
  const shadow: Policy = { ...POLICY_V1, policyVersion: "policy/1.0.0-shadow-copy", status: "SHADOW" };
  for (const s of p.shots) {
    const c = contracts.find((x) => x.shotId === s.shotId)!;
    const cmp = runShadow({ ...base(c), requestedMethod: s.decision.method }, shadow);
    if (cmp.estimatedDelta.methodChanged) v.push(`shadow copy diverged on ${s.shotId}`);
  }
  if (networkCalls > 0) v.push(`C11 network calls ${networkCalls}`);
  // C12: distribution data injected into the input must not change the decision.
  const c0 = contracts[0];
  const plain = decide(base(c0));
  const withYt = decide({ ...base(c0), youtube: { views: 1e9, retention: 0.9 } } as DecideInput);
  const strip = (d: typeof plain) => ({ ...d, decisionHash: "" });
  if (JSON.stringify(strip(plain)) !== JSON.stringify(strip(withYt))) v.push("C12 distribution data changed a decision");
  const importsDistribution = execSync("grep -rl \"distribution\" src/lib/production-intelligence --include=*.ts | grep -v test || true").toString().trim();
  if (importsDistribution) v.push(`C12 engine references distribution: ${importsDistribution}`);
  return { violations: v, reservation: res };
}

function overlap(name: string, pi: string[], human: string[]) {
  const P_ = new Set(pi), H = new Set(human);
  const inter = [...P_].filter((x) => H.has(x)).sort();
  const union = new Set([...P_, ...H]);
  return { comparison: name, pi: pi.length, human: human.length, intersection: inter, piOnly: [...P_].filter((x) => !H.has(x)).sort(), humanOnly: [...H].filter((x) => !P_.has(x)).sort(), precision: r4(inter.length / (P_.size || 1)), recall: r4(inter.length / (H.size || 1)), jaccard: r4(inter.length / (union.size || 1)) };
}

// ================= DULCE =================
const dm = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-mix-contracts.json", "utf8"));
const smart = JSON.parse(fs.readFileSync("content/long-form/dulce-part1/smart-mix.json", "utf8"));
const dContracts: ShotContract[] = dm.contracts.map((c: ShotContractInput) => parseShotContract(c));
const dPlan = plan("dulce-sim", dContracts, dm.finishedSeconds, 40);
const dPlan2 = plan("dulce-sim", dContracts, dm.finishedSeconds, 40);
const piSelected = dPlan.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => s.shotId);
const planB = smart.clips.filter((c: { recommendedMethod: string }) => c.recommendedMethod.startsWith("i2v")).map((c: { asset: string }) => c.asset);
const humanPlanned = [...new Set([...planB, ...smart.summary.upgradePack.assets])].sort();
const humanUsed = ["N01", "N04", "N05", "N11", "N12", "N26", "N33", "N35", "N41", "N46", "N48"]; // DULCE Part I master (run 21 qc.json: generativeClipsInMaster 11)
const clipOf = (a: string) => smart.clips.find((c: { asset: string }) => c.asset === a);
const humanSecs = (ids: string[]) => ids.reduce((t, a) => t + (clipOf(a)?.recommendedMethod === "i2v_hero" ? 10 : 5), 0);
const piSecs = dPlan.generativeSecondsUsed;
const dulceFinishedMin = dm.finishedSeconds / 60;
const detail = (ids: string[]) => ids.map((id) => { const s = dPlan.shots.find((x) => x.shotId === id)!; const c = dContracts.find((x) => x.shotId === id)!; const k = clipOf(id); return { shotId: id, shotClass: c.shotClass, motionLeverage: c.motionLeverage, motionRequirement: c.motionRequirement, riskClass: c.riskClass, riskFlags: c.riskFlags, humanClassification: k.classification, humanRecommended: k.recommendedMethod, humanReason: k.reason, piMethod: s.method, piSeconds: s.decision.generativeSeconds, piExpectedUsd: s.decision.expectedCostUsd, piReasons: s.reasons }; });
const ovPlanned = overlap("PI vs HUMAN_PLANNED", piSelected, humanPlanned);
const ovUsed = overlap("PI vs HUMAN_USED", piSelected, humanUsed);
const dConst = constitution("dulce-sim", dContracts, dPlan, 40);
const dulce = {
  sets: { HUMAN_PLANNED: humanPlanned, HUMAN_USED: humanUsed, PI_SELECTED: piSelected.sort() },
  overlap: [ovPlanned, ovUsed],
  economics: {
    humanPlanned: { clips: humanPlanned.length, generativeSeconds: humanSecs(humanPlanned), perMinute: r4(humanSecs(humanPlanned) / dulceFinishedMin), videoUsd: r4(humanSecs(humanPlanned) * 0.05), recordedPlan: { planBVideoUsd: smart.summary.planB.videoCost, upgradePackVideoUsd: smart.summary.upgradePack.videoCost, planBWorstCaseUsd: smart.summary.planB.worstCase } },
    humanUsed: { clips: humanUsed.length, billedGenerativeSeconds: humanSecs(humanUsed), perMinute: r4(humanSecs(humanUsed) / dulceFinishedMin), videoUsd: r4(humanSecs(humanUsed) * 0.05), actualVideoSpendAllAttemptsUsd: 3.75, note: "3.75 = 14 Runway attempts incl. N20 x2 and N43 (ledger)" },
    pi: { clips: piSelected.length, generativeSeconds: piSecs, perMinute: r4(piSecs / dulceFinishedMin), videoUsd: r4(dPlan.shots.reduce((t, s) => t + motionUsd(s), 0)), expectedTotalUsd: dPlan.expectedCostUsd, worstCaseReservedUsd: dPlan.worstCaseUsd, budget: dPlan.generativeSecondsBudget },
  },
  errorAnalysis: { piOnlyVsUsed: detail(ovUsed.piOnly), humanOnlyVsUsed: detail(ovUsed.humanOnly), piOnlyVsPlanned: ovPlanned.piOnly, humanOnlyVsPlanned: detail(ovPlanned.humanOnly) },
  constitution: dConst.violations,
  deterministic: JSON.stringify(dPlan) === JSON.stringify(dPlan2),
  reasonsCoverage: r4(dPlan.shots.filter((s) => s.reasons.length > 0).length / dPlan.shots.length),
};

// ================= OCEAN =================
type Sb = { shotId: string; beatId: string; durationApprox: number; assetType: string; motion: string; hybridClassification: string; reused?: boolean; description: string; visualIntent: string; estimatedCostUsd?: number; billableVideoSeconds?: number; aiGenerated?: boolean };
const sb = JSON.parse(fs.readFileSync("docs/pi-exam/ocean-input/ocean-storyboard-001.v003.json", "utf8")) as { shots: Sb[] };
const manifest = JSON.parse(fs.readFileSync("docs/pi-exam/ocean-input/episode-manifest.json", "utf8"));
const scenes = (manifest.scenes ?? manifest) as { source: { kind: string; key?: string } }[];
const FINISHED = 659.343, BUDGET = 17.65;
const CREATURE = /\b(fish|fishes|angler|dragonfish|jelly|squid|octopus|shrimp|worm|animal|lure|bacteria|silhouette|counterillumination|biolumin)/i;
const VEHICLE = /\b(vehicle|rov|submersible|deep discoverer|bathyscaphe|trieste)/i;
const PEOPLE = /\b(people|person|men|crew|scientist|piccard|walsh)\b/i;
function oceanContract(s: Sb, aiLeverage: "LOW" | "MEDIUM" | "HIGH"): ShotContract {
  const text = `${s.visualIntent} ${s.description}`;
  const common = { shotId: s.shotId, narrationIntent: s.visualIntent, visualIntent: s.description, desiredDuration: s.durationApprox, maxGeneratedDuration: 8, qualityTier: "economy" as const, continuityGroup: s.beatId, existingApprovedAssetId: s.reused ? s.shotId : null };
  if (s.hybridClassification === "AI_RECREATION") {
    const shotClass = CREATURE.test(text) ? "creature" : VEHICLE.test(text) ? "object" : "landscape";
    return parseShotContract({ ...common, shotClass, motionRequirement: "simple", motionLeverage: aiLeverage, riskClass: shotClass === "creature" ? "MEDIUM" : "LOW", humanIntervention: "human", stockAvailable: false });
  }
  if (s.motion === "map-graphic") return parseShotContract({ ...common, shotClass: "map", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: false });
  if (s.motion === "figure-over-motion") return parseShotContract({ ...common, shotClass: "graphic", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
  if (s.motion.startsWith("still-push")) return parseShotContract({ ...common, shotClass: PEOPLE.test(text) ? "other" : "object", motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
  return parseShotContract({ ...common, shotClass: "broll", motionRequirement: "simple", motionLeverage: "LOW", riskClass: "LOW", stockAvailable: true });
}
const oldMethod = (s: Sb) => (s.motion.startsWith("ai-animation") ? "GENERATIVE_VIDEO (Veo 8 s)" : s.motion === "real-footage" ? "STOCK" : s.motion === "figure-over-motion" ? "GRAPHIC_OVER_FOOTAGE" : s.motion === "map-graphic" ? "MAP_GRAPHIC" : "ARCHIVAL_STILL_PUSH");
const oldGenerative = sb.shots.filter((s) => s.motion.startsWith("ai-animation")).map((s) => s.shotId);
const oldNewVeo = sb.shots.filter((s) => s.motion.startsWith("ai-animation") && !s.reused);
const veoKeys = [...new Set(scenes.filter((x) => x.source.kind === "veo-clip").map((x) => x.source.key))];
const oceanFinishedMin = FINISHED / 60;
const scenarios: Record<string, "LOW" | "MEDIUM" | "HIGH"> = { S1_primary: "MEDIUM", S2: "HIGH", S3: "LOW" };
const ocean: Record<string, unknown> = {
  baseline: {
    storyboardShots: sb.shots.length, manifestScenes: scenes.length, finishedSeconds: FINISHED,
    oldPlannedGenerativeShots: oldGenerative, oldPlannedNewVeo: oldNewVeo.length, oldPlannedReusedFirstMinute: oldGenerative.length - oldNewVeo.length,
    oldPlannedBillableSeconds: oldNewVeo.reduce((t, s) => t + (s.billableVideoSeconds ?? 0), 0) + (oldGenerative.length - oldNewVeo.length) * 8,
    oldPlannedVeoUsd: r4(oldNewVeo.reduce((t, s) => t + (s.estimatedCostUsd ?? 0), 0)),
    manifestVeoClips: veoKeys.length, manifestVeoKeys: veoKeys,
    recordedSpend: { spentUsd: 13.36019, voiceUsd: 3.2061, imagesAndClipsUsd: 10.15409, committedUsd: 14.3202, capUsd: 17.65, source: "docs/quality/ocean-deep-001/PLAN.md §13.6 on 5427188" },
    unknown: ["per-shot actual cost (ledger JSON lives in Storage, not in git)", "shot-level mapping storyboard -> manifest (no join key; final Veo clips are all in b5 with different keys)", "final master (no verified master found)", "motionLeverage (never recorded; pre-registered scenarios)"],
  },
};
for (const [name, lev] of Object.entries(scenarios)) {
  const contracts = sb.shots.map((s) => oceanContract(s, lev));
  const p = plan(`ocean-${name}`, contracts, FINISHED, BUDGET);
  const p2 = plan(`ocean-${name}`, contracts, FINISHED, BUDGET);
  const cons = constitution(`ocean-${name}`, contracts, p, BUDGET);
  const sel = p.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => s.shotId);
  ocean[name] = {
    aiRecreationLeverage: lev,
    budgetSeconds: p.generativeSecondsBudget, heroQuota: P.heroQuota,
    piGenerativeShots: sel, piGenerativeSeconds: p.generativeSecondsUsed, piPerMinute: r4(p.generativeSecondsUsed / oceanFinishedMin), heroShots: p.heroShots,
    piVideoUsd: r4(p.shots.reduce((t, s) => t + motionUsd(s), 0)), piExpectedUsd: p.expectedCostUsd, piWorstCaseUsd: p.worstCaseUsd,
    constitution: cons.violations, reservation: cons.reservation.status, deterministic: JSON.stringify(p) === JSON.stringify(p2),
    reasonsCoverage: r4(p.shots.filter((s) => s.reasons.length).length / p.shots.length),
    vsHumanPlanned: overlap("PI vs HUMAN_PLANNED (storyboard ai-animation)", sel, oldGenerative),
    perShot: p.shots.map((s) => { const c = contracts.find((x) => x.shotId === s.shotId)!; const o = sb.shots.find((x) => x.shotId === s.shotId)!; return { shotId: s.shotId, oldMethod: oldMethod(o), piMethod: s.method, shotClass: c.shotClass, motionLeverage: c.motionLeverage, riskClass: c.riskClass, oldGeneratedSeconds: o.motion.startsWith("ai-animation") ? (o.billableVideoSeconds || 8) : 0, piGeneratedSeconds: s.decision.generativeSeconds, oldEstimatedUsd: o.estimatedCostUsd ?? null, piExpectedUsd: s.decision.expectedCostUsd, piWorstCaseUsd: s.decision.maxCostUsd, reasons: s.reasons }; }),
  };
}
const oceanOld = ocean.baseline as { oldPlannedBillableSeconds: number };
(ocean.baseline as Record<string, unknown>).oldPerMinute = r4(oceanOld.oldPlannedBillableSeconds / oceanFinishedMin);

const out = { frozen: { commit: "d1330e7", treeSha256AtRun: treeHash, expectedTreeSha256: "c57bf6236e1f9fa049ded33faa822d17d694b2dba83906e04d0ddd7ceef1cc49", unchanged: treeHash === "c57bf6236e1f9fa049ded33faa822d17d694b2dba83906e04d0ddd7ceef1cc49", policyVersion: POLICY_V1.policyVersion, profileVersion: P.profileVersion, rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId: "mem_empty", oceanBudgetSeconds: generativeSecondsBudget(P, FINISHED) }, networkCalls, dulce, ocean };
fs.writeFileSync("docs/pi-exam/results.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify({ unchanged: out.frozen.unchanged, networkCalls, dulceConstitution: dulce.constitution, overlap: dulce.overlap.map((o) => ({ c: o.comparison, i: o.intersection.length, piOnly: o.piOnly, humanOnly: o.humanOnly, p: o.precision, r: o.recall, j: o.jaccard })) }, null, 1));
for (const n of Object.keys(scenarios)) { const o = ocean[n] as Record<string, unknown>; console.log(n, JSON.stringify({ sel: o.piGenerativeShots, secs: o.piGenerativeSeconds, perMin: o.piPerMinute, hero: o.heroShots, videoUsd: o.piVideoUsd, exp: o.piExpectedUsd, worst: o.piWorstCaseUsd, cons: o.constitution, det: o.deterministic, reasons: o.reasonsCoverage, vs: (o.vsHumanPlanned as { precision: number; recall: number; jaccard: number }) })); }
console.log("baseline", JSON.stringify(ocean.baseline));
