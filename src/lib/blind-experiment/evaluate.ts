/**
 * Blind comparison + pre-registered verdict (protocol blind-protocol/001.1).
 * Scores the ORIGINAL sealed human answers; amendments and post-production truth are
 * reported separately and never rewrite the baseline. No minimum Jaccard: PI may differ.
 */
import { isGenerativeVideo, type Method } from "../production-intelligence/ladder";
import { upgradeReasonInvalidity } from "../production-intelligence/decide";
import { isProtectedExistingAsset } from "../production-intelligence/contract";
import { sha256, verifySeal, type SealedBaseline, type Amendment } from "./seal";
import { ShadowGateError, type Protocol, type ShadowResult } from "./shadow-gate";

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
export const RUNWAY_USD_PER_SECOND = 0.05; // rate-card/2026-09-28.1 runway:gen4_turbo

export function overlap(pi: string[], human: string[]) {
  const P = new Set(pi), H = new Set(human);
  const inter = [...P].filter((x) => H.has(x)).sort();
  const union = new Set([...P, ...H]);
  return {
    intersection: inter, piOnly: [...P].filter((x) => !H.has(x)).sort(), humanOnly: [...H].filter((x) => !P.has(x)).sort(),
    precision: P.size ? r4(inter.length / P.size) : 1, recall: H.size ? r4(inter.length / H.size) : 1, jaccard: union.size ? r4(inter.length / union.size) : 1,
  };
}

export type ShotLabel = "AGREE" | "EXPENSIVE_FALSE_POSITIVE" | "QUALITY_FALSE_NEGATIVE" | "ALTERNATIVE_GOOD_DECISION" | "DISAGREEMENT";
export type FinalTruth = { shotId: string; finalUsedMethod: Method | "UNKNOWN"; userKept?: boolean | "UNKNOWN"; userRequestedRegeneration?: boolean | "UNKNOWN"; userReason?: string };

export function evaluate(o: { sealed: SealedBaseline; protocol: Protocol; shadow: ShadowResult; constitutionViolations: string[]; amendments?: readonly Amendment[]; finalTruth?: FinalTruth[] }) {
  const { sealed, shadow } = o;
  verifySeal(sealed);
  if (sha256(o.protocol) !== sealed.protocolSha256 || shadow.protocolSha256 !== sealed.protocolSha256) throw new ShadowGateError("protocol differs from the one sealed with the baseline");
  if (shadow.sealHash !== sealed.sealHash) throw new ShadowGateError("shadow result belongs to another baseline");
  const human = sealed.baseline.shots;
  const pi = new Map(shadow.plan.shots.map((s) => [s.shotId, s]));
  const contract = new Map(shadow.contracts.map((c) => [c.shotId, c]));
  const unresolved = new Set((shadow.plan.rhythm?.unresolved ?? []).flat());
  const minutes = sealed.baseline.finishedSeconds / 60;

  const perShot = human.map((h) => {
    const s = pi.get(h.shotId)!;
    const hGen = h.humanWouldGenerateVideo, pGen = isGenerativeVideo(s.method);
    const labels: ShotLabel[] = [];
    if (pGen && !hGen && (h.motionJudgment === "MOTION_UNNECESSARY" || h.cheaperMethodSufficient || h.generationRiskUnacceptable)) labels.push("EXPENSIVE_FALSE_POSITIVE");
    if (h.motionJudgment === "MOTION_ESSENTIAL" && !h.adequateMethods.includes(s.method)) labels.push("QUALITY_FALSE_NEGATIVE");
    if (hGen && !pGen && h.adequateMethods.includes(s.method) && !unresolved.has(h.shotId) && s.decision.expectedCostUsd <= h.i2vPlan!.estimatedCostUsd) labels.push("ALTERNATIVE_GOOD_DECISION");
    if (!labels.length) labels.push(hGen === pGen ? "AGREE" : "DISAGREEMENT");
    return { shotId: h.shotId, humanMethod: h.humanPreferredMethod, piMethod: s.method, upgradeReason: s.decision.upgradeReason ?? null, motionJudgment: h.motionJudgment, labels, unsafe: labels.includes("EXPENSIVE_FALSE_POSITIVE") && h.generationRiskUnacceptable, piReasons: s.reasons };
  });
  const count = (l: ShotLabel) => perShot.filter((x) => x.labels.includes(l)).length;
  const humanSel = human.filter((h) => h.humanWouldGenerateVideo).map((h) => h.shotId);
  const piSel = shadow.plan.shots.filter((s) => isGenerativeVideo(s.method)).map((s) => s.shotId);
  const humanSecs = human.filter((h) => h.humanWouldGenerateVideo).reduce((t, h) => t + h.i2vPlan!.durationSeconds, 0);
  const unjustified = shadow.plan.shots.filter((s) => isGenerativeVideo(s.method) && (upgradeReasonInvalidity(contract.get(s.shotId)!, s.method, s.decision.upgradeReason) !== null || !s.decision.reasons.includes(`upgradeReason: ${s.decision.upgradeReason}`))).map((s) => s.shotId);
  const repurchase = shadow.plan.shots.filter((s) => isProtectedExistingAsset(contract.get(s.shotId)!) && s.method !== "EXISTING_APPROVED_ASSET").map((s) => s.shotId);
  const reasonsCoverage = r4(shadow.plan.shots.filter((s) => s.reasons.length).length / shadow.plan.shots.length);

  const metrics = {
    HUMAN_SELECTED: humanSel.sort(), PI_SELECTED: piSel.sort(), ...overlap(piSel, humanSel),
    human: { generativeClips: humanSel.length, generatedSeconds: humanSecs, perMinute: r4(humanSecs / minutes), expectedCostUsd: sealed.summary.expectedCostUsd },
    pi: { generativeClips: piSel.length, generatedSeconds: shadow.plan.generativeSecondsUsed, perMinute: r4(shadow.plan.generativeSecondsUsed / minutes), videoExpectedUsd: r4(shadow.plan.generativeSecondsUsed * RUNWAY_USD_PER_SECOND), expectedCostUsd: shadow.plan.expectedCostUsd, worstCaseReservedUsd: shadow.plan.worstCaseUsd, budgetSeconds: shadow.plan.generativeSecondsBudget },
    EXPENSIVE_FALSE_POSITIVE: count("EXPENSIVE_FALSE_POSITIVE"), UNSAFE_EXPENSIVE_FALSE_POSITIVE: perShot.filter((x) => x.unsafe).length,
    QUALITY_FALSE_NEGATIVE: count("QUALITY_FALSE_NEGATIVE"), ALTERNATIVE_GOOD_DECISION: count("ALTERNATIVE_GOOD_DECISION"), DISAGREEMENT: count("DISAGREEMENT"),
    UNJUSTIFIED_GENERATIVE_UPGRADES: unjustified, AUTOMATIC_REPURCHASE: repurchase, reasonsCoverage,
  };

  // ---- pre-registered verdict ----
  const fail: string[] = [];
  if (o.constitutionViolations.length) fail.push(`constitutional violations: ${o.constitutionViolations.join("; ")}`);
  if (shadow.networkCalls > 0) fail.push(`provider/network calls during shadow: ${shadow.networkCalls}`);
  if (unjustified.length) fail.push(`unjustified generative upgrades: ${unjustified.join(", ")}`);
  if (shadow.plan.generativeSecondsUsed > shadow.plan.generativeSecondsBudget || shadow.plan.worstCaseUsd > sealed.baseline.productionBudgetUsd) fail.push("financially unsafe: budget or reservation exceeded");
  if (repurchase.length) fail.push(`automatic repurchase: ${repurchase.join(", ")}`);
  if (!shadow.deterministic) fail.push("non-deterministic shadow output");
  if (reasonsCoverage < 1) fail.push(`reasons coverage ${reasonsCoverage}`);
  if (metrics.UNSAFE_EXPENSIVE_FALSE_POSITIVE >= 1) fail.push(`unsafe expensive false positives: ${metrics.UNSAFE_EXPENSIVE_FALSE_POSITIVE}`);
  if (metrics.QUALITY_FALSE_NEGATIVE >= 2) fail.push(`repeated quality false negatives: ${metrics.QUALITY_FALSE_NEGATIVE}`);
  const inconclusive: string[] = [];
  if (human.length < 30) inconclusive.push(`only ${human.length} shots (< 30)`);
  if (human.filter((h) => h.motionJudgment === "MOTION_ESSENTIAL").length < 3) inconclusive.push("fewer than 3 MOTION_ESSENTIAL shots");
  if (!humanSel.length && !piSel.length) inconclusive.push("neither human nor PI selected generative video");

  // ---- post-production truth: a third comparison, never written back into the baseline ----
  let final: null | Record<string, unknown> = null;
  if (o.finalTruth) {
    const known = o.finalTruth.filter((f) => f.finalUsedMethod !== "UNKNOWN");
    const unknownShare = r4(1 - known.length / human.length);
    const finalSel = known.filter((f) => isGenerativeVideo(f.finalUsedMethod as Method)).map((f) => f.shotId);
    const humanChangedMind = known.filter((f) => human.find((h) => h.shotId === f.shotId)?.humanPreferredMethod !== f.finalUsedMethod).map((f) => f.shotId);
    final = { unknownShare, unknownShots: o.finalTruth.filter((f) => f.finalUsedMethod === "UNKNOWN").map((f) => f.shotId), FINAL_SELECTED: finalSel.sort(), PI_vs_FINAL: overlap(piSel.filter((x) => known.some((k) => k.shotId === x)), finalSel), HUMAN_vs_FINAL: overlap(humanSel.filter((x) => known.some((k) => k.shotId === x)), finalSel), humanChangedMind, userAcceptance: o.finalTruth.filter((f) => f.userKept !== undefined).map((f) => ({ shotId: f.shotId, userKept: f.userKept, userRequestedRegeneration: f.userRequestedRegeneration ?? "UNKNOWN", userReason: f.userReason ?? null })) };
    if (unknownShare > 0.2) inconclusive.push(`post-production UNKNOWN share ${unknownShare} > 0.2`);
  }
  const verdict = fail.length ? "FAIL" : inconclusive.length ? "INCONCLUSIVE" : "PASS";
  return { baselineId: sealed.baselineId, protocolVersion: sealed.protocolVersion, stage: o.finalTruth ? "FINAL" : "SHADOW_PRE_PRODUCTION", verdict, fail, inconclusive, metrics, perShot, final, amendments: (o.amendments ?? []).map((a) => ({ seq: a.seq, shotId: a.shotId, field: a.field, from: a.from, to: a.to, reason: a.reason })), scoredAgainst: "original sealed baseline" };
}
