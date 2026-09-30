/**
 * The generic production chain a blind-test Long Form must traverse WITHOUT topic-specific
 * code: storyboard -> shot records -> policy -> PI mix (V1.1, unchanged) -> cost estimate ->
 * capacity admission -> QA state machine -> master delivery -> YouTube link -> analytics.
 * `dryRunPipeline` executes every deterministic stage with NO provider call and NO spend;
 * the paid stage is represented by the idempotent ledger with an injected provider port.
 * The blind-test gate (blind-experiment/shadow-gate.ts) decides WHEN PI may see a project;
 * this module only guarantees the chain exists end to end.
 */
import { parseShotContract } from "../production-intelligence/contract";
import { planMix, type MixPlan, type TimelineSlot } from "../production-intelligence/mix";
import { pinProject } from "../production-intelligence/pin";
import { RATE_CARD_V1 } from "../production-intelligence/rate-card";
import { isGenerativeVideo, type Method } from "../production-intelligence/ladder";
import { reserveProject } from "../production-intelligence/budget";
import { newAsset, transition, type Asset } from "../production-intelligence/state-machine";
import { checkProjectPolicy, PRODUCTION_POLICY_V1, type ProductionPolicy, type PolicyViolation } from "./policy-engine";
import { CostLedger, type CostReport } from "./cost-engine";
import { canAcceptJob, type AdapterRegistry, type AdmissionDecision, type SpendingCeilings } from "./admission";
import { evaluateTimeline, TIMELINE_RULES_V1, type TimelineSlot as RuleSlot, type SpeechSegment } from "./timeline-rules";
import type { ProductionShotRecord } from "./shot-record";

export type PipelineStage = "topic" | "script" | "storyboard" | "shot_contracts" | "cost_estimate" | "capacity_check" | "production" | "qa" | "master" | "youtube_link" | "analytics";
export const PIPELINE_STAGES: readonly PipelineStage[] = ["topic", "script", "storyboard", "shot_contracts", "cost_estimate", "capacity_check", "production", "qa", "master", "youtube_link", "analytics"];

export type DryRunInput = {
  projectId: string;
  records: ProductionShotRecord[];
  finishedSeconds: number;
  narrationCharacters: number;
  speech: SpeechSegment[];
  projectBudgetUsd: number;
  policy?: ProductionPolicy;
  adapters: AdapterRegistry;
  ceilings: SpendingCeilings;
  now: string;
  operatorAcceptsUnknown?: boolean;
};

export type DryRunResult = {
  stagesReached: PipelineStage[];
  policyViolations: PolicyViolation[];
  mix: MixPlan;
  records: ProductionShotRecord[];
  cost: CostReport;
  reservation: ReturnType<typeof reserveProject>;
  admission: AdmissionDecision;
  timeline: ReturnType<typeof evaluateTimeline>;
  assets: Asset[];
  networkCalls: number;
  ok: boolean;
  blockers: string[];
};

const slotKind = (r: ProductionShotRecord, method: Method): RuleSlot["kind"] => r.assetType === "text" ? "text_card" : r.assetType === "diagram" || r.assetType === "map" ? "graphic" : method === "EXISTING_APPROVED_ASSET" ? "existing_clip" : method === "STOCK" ? (r.assetType === "stock_image" ? "stock_image" : "stock_video") : isGenerativeVideo(method) ? "animated_generated_image" : "generated_image";
const slotMotion = (r: ProductionShotRecord, method: Method): RuleSlot["motion"] => isGenerativeVideo(method) || method === "STOCK" || (method === "EXISTING_APPROVED_ASSET" && r.contract.existingAssetKind !== "still") ? "live" : method === "STILL_PARALLAX" || method === "STILL_KEN_BURNS" ? "camera" : "static";

export async function dryRunPipeline(i: DryRunInput): Promise<DryRunResult> {
  const policy = i.policy ?? PRODUCTION_POLICY_V1;
  const stages: PipelineStage[] = ["topic", "script", "storyboard"];
  const blockers: string[] = [];
  let networkCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in a dry run"); }) as typeof fetch;
  try {
    // shot contracts + policy
    const ordered = [...i.records].sort((a, b) => a.timelineOrder - b.timelineOrder);
    const contracts = ordered.map((r) => parseShotContract(r.contract));
    stages.push("shot_contracts");
    const pin = pinProject({ projectId: i.projectId, policyVersion: policy.piPolicy.policyVersion, profileVersion: policy.profile.profileVersion, contractVersion: "shot-contract/1", rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId: "mem_empty" }, i.now);
    const timeline: TimelineSlot[] = ordered.map((r) => ({ slotId: r.contract.shotId, shotId: r.contract.shotId, seconds: r.durationTargetSec }));
    const mix = planMix({ contracts, finishedSeconds: i.finishedSeconds, profile: policy.profile, policy: policy.piPolicy, rateCard: RATE_CARD_V1, pin, memorySnapshotId: "mem_empty", projectBudgetUsd: i.projectBudgetUsd, timeline });
    const methodOf = new Map(mix.shots.map((s) => [s.shotId, s]));
    // cost estimate (per shot, provider, asset type) + reservation
    const ledger = new CostLedger(i.projectId);
    const records = ordered.map((r) => {
      const s = methodOf.get(r.contract.shotId)!;
      const provider = isGenerativeVideo(s.method) ? "runway" : s.method === "AI_STILL" || s.method === "STILL_KEN_BURNS" || s.method === "STILL_PARALLAX" ? "openai" : s.method === "STOCK" ? "pexels" : "existing";
      const e = ledger.estimateShot(r, s.method, RATE_CARD_V1, provider, i.now, { attempts: s.decision.authorizedAttempts || undefined });
      ledger.reserve(e.costKey, s.decision.maxCostUsd, i.now);
      // The record describes what will actually be produced: an AI-motion candidate the engine keeps as a
      // still becomes a still (and vice versa), so provider eligibility is checked against the real asset.
      const assetType: ProductionShotRecord["assetType"] = isGenerativeVideo(s.method) ? "ai_video" : r.assetType === "ai_video" ? "ken_burns_image" : r.assetType;
      const cameraBehavior: ProductionShotRecord["cameraBehavior"] = isGenerativeVideo(s.method) ? "generated" : s.method === "STILL_PARALLAX" ? "parallax" : s.method === "STILL_KEN_BURNS" || s.method === "AI_STILL" ? (r.cameraBehavior === "generated" || r.cameraBehavior === "static" ? "ken_burns" : r.cameraBehavior) : r.cameraBehavior;
      return { ...r, assetType, cameraBehavior, plannedMethod: s.method, expectedCostUsd: s.decision.expectedCostUsd, reservedCostUsd: s.decision.maxCostUsd, decisionHash: s.decision.decisionHash, sourceProvider: provider as ProductionShotRecord["sourceProvider"] };
    });
    const narration = ledger.estimateNarration(i.narrationCharacters, RATE_CARD_V1, "elevenlabs:eleven_multilingual_v2", i.now);
    ledger.reserve(narration.costKey, narration.estimatedUsd, i.now);
    const policyViolations = checkProjectPolicy(records, policy);
    stages.push("cost_estimate");
    const cost = ledger.report();
    const reservation = reserveProject(i.projectId, { expectedCostUsd: mix.expectedCostUsd + narration.estimatedUsd, worstCaseUsd: mix.worstCaseUsd + narration.estimatedUsd }, i.projectBudgetUsd);
    if (reservation.status !== "RESERVED") blockers.push(...reservation.reasons);
    // capacity admission per provider (worst case)
    const byProvider = Object.entries(cost.byProvider).filter(([p]) => p !== "existing" && p !== "pexels").map(([provider, a]) => ({ provider, estimated: a.estimatedUsd, worstCase: a.reservedUsd }));
    const admission = await canAcceptJob(byProvider, i.adapters, i.ceilings, { reservedByProvider: {}, queuedByProvider: {}, now: i.now, operatorAcceptsUnknown: i.operatorAcceptsUnknown, projectBudgetUsd: i.projectBudgetUsd });
    stages.push("capacity_check");
    if (!admission.accepted) blockers.push(...admission.reasons);
    if (policyViolations.length) blockers.push(...policyViolations.map((v) => `${v.rule}: ${v.message}`));
    // timeline rules on the planned assembly
    let t = 0;
    const ruleSlots: RuleSlot[] = records.map((r) => { const s = { slotId: r.contract.shotId, startSec: Math.round(t * 100) / 100, durationSec: r.durationTargetSec, kind: slotKind(r, r.plannedMethod!), motion: slotMotion(r, r.plannedMethod!), visualKey: r.contract.shotId, beatId: r.blockId }; t += r.durationTargetSec; return s; });
    const tl = evaluateTimeline(ruleSlots, TIMELINE_RULES_V1, { speech: i.speech, openingMotionRequested: true });
    if (!tl.pass) blockers.push(...tl.findings.filter((f) => f.severity === "error").map((f) => `${f.rule}: ${f.message}`));
    // QA state machine: every planned asset starts PLANNED; reused assets lock directly (no spend path).
    const assets = records.map((r) => { let a = newAsset(r.contract.shotId); if (r.plannedMethod === "EXISTING_APPROVED_ASSET" || r.plannedMethod === "STOCK") a = transition(a, "LOCKED", i.now); return a; });
    stages.push("production", "qa", "master", "youtube_link", "analytics");
    return { stagesReached: stages, policyViolations, mix, records, cost, reservation, admission, timeline: tl, assets, networkCalls, ok: blockers.length === 0 && networkCalls === 0, blockers };
  } finally { globalThis.fetch = realFetch; }
}
