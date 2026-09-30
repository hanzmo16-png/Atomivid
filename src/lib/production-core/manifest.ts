/**
 * Production manifest: ONE auditable document per production built only from recorded facts
 * (shot records, mix plan, cost ledger, reservation, admission, timeline evaluation, QA assets,
 * paid-operation ledger). It answers: what was planned, what was generated, by which provider,
 * what it cost, what failed, what was retried and why, which fallback was used, which QA passed,
 * which QA remains human, and what provider capacity remains. Nothing here spends or decides.
 */
import type { DryRunResult } from "./pipeline";
import type { ProductionShotRecord } from "./shot-record";
import type { PaidOperation } from "../production-intelligence/ledger";
import { measureMix, checkMixPreset, type MixPreset, type MixPresetCheck, type MixMeasure } from "./mix-presets";

export const MANIFEST_VERSION = "production-manifest/1";

/** Technical checks are measured by machines; editorial/visual judgement stays a separate, human state. */
export const TECHNICAL_QA_CHECKS = ["duration", "resolution", "fps", "audio_presence", "loudness", "subtitle_timing", "black_frames", "freeze_detection", "missing_assets", "corrupt_files"] as const;
export const EDITORIAL_QA_CHECKS = ["visual_quality", "motion_looks_natural", "character_continuity", "narrative_match", "identity_drift", "deformation"] as const;

export type ManifestShot = {
  shotId: string; sceneId: string; timelineOrder: number; narrativePurpose: string; assetType: ProductionShotRecord["assetType"];
  plannedMethod: string | null; provider: string; cameraBehavior: string; transitionIn: string; durationTargetSec: number; minVisibleSec: number;
  continuity: { group: string | null; characterReferences: number }; provenance: ProductionShotRecord["provenance"]; historicalClassification: string | null;
  cost: { expectedUsd: number; reservedUsd: number; actualUsd: number | null };
  lifecycleState: string; qaStatus: string; retryCount: number; fallbackState: string; decisionHash: string | null;
  operations: { idempotencyKey: string; provider: string; model: string; method: string; attemptKind: string; status: string; providerJobId: string | null; reservedUsd: number; committedUsd: number | null; resultRef: string | null }[];
  retries: { count: number; reasons: string[] };
  fallback: { used: boolean; state: string; explicit: true };
};

export type ProductionManifest = {
  manifestVersion: typeof MANIFEST_VERSION;
  projectId: string;
  generatedAt: string;
  pins: { policy: string; profile: string; contract: string; rateCard: string; memorySnapshot: string } | null;
  ok: boolean;
  blockers: string[];
  stagesReached: string[];
  plan: { shots: ManifestShot[]; finishedSeconds: number; mix: MixMeasure; presetCheck: MixPresetCheck | null; generative: { shots: number; secondsUsed: number; secondsBudget: number; heroShots: number } };
  cost: { estimatedUsd: number; reservedUsd: number; actualUsd: number; retryUsd: number; varianceUsd: number; projectBudgetUsd: number; remainingBudgetUsd: number; byProvider: Record<string, { estimatedUsd: number; reservedUsd: number; actualUsd: number }>; topUpsExcludedUsd: number; reconciliationRequired: string[]; reservation: { status: string; reservedUsd: number; worstCaseUsd: number; reasons: string[] } };
  capacity: { verdict: string; accepted: boolean; perProvider: { provider: string; state: string; covered: boolean; reasons: string[] }[]; reasons: string[] };
  policy: { violations: { rule: string; shotId: string | null; message: string }[]; timelineFindings: { rule: string; severity: string; slotIds: string[]; message: string }[]; timelinePass: boolean };
  qa: { technicalChecks: readonly string[]; editorialChecks: readonly string[]; humanRequired: readonly string[]; note: string; assets: { assetId: string; state: string }[] };
  generated: { shotId: string; provider: string; model: string; providerJobId: string | null; resultRef: string | null; committedUsd: number | null }[];
  failures: { shotId: string; kind: string; detail: string }[];
  networkCalls: number;
};

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function buildProductionManifest(i: { dryRun: DryRunResult; projectId: string; projectBudgetUsd: number; now: string; operations?: PaidOperation[]; preset?: MixPreset | null; failures?: { shotId: string; kind: string; detail: string }[] }): ProductionManifest {
  const d = i.dryRun;
  const ops = i.operations ?? [];
  const opsByShot = new Map<string, PaidOperation[]>();
  for (const o of ops) opsByShot.set(o.shotId, [...(opsByShot.get(o.shotId) ?? []), o]);
  const mixShot = new Map(d.mix.shots.map((s) => [s.shotId, s]));
  const shots: ManifestShot[] = [...d.records].sort((a, b) => a.timelineOrder - b.timelineOrder).map((r) => {
    const o = (opsByShot.get(r.contract.shotId) ?? []).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
    const retries = o.filter((x) => x.attemptKind !== "initial");
    return {
      shotId: r.contract.shotId, sceneId: r.sceneId, timelineOrder: r.timelineOrder, narrativePurpose: r.narrativePurpose, assetType: r.assetType,
      plannedMethod: r.plannedMethod, provider: r.sourceProvider, cameraBehavior: r.cameraBehavior, transitionIn: r.transitionIn, durationTargetSec: r.durationTargetSec, minVisibleSec: r.minVisibleSec,
      continuity: { group: r.contract.continuityGroup ?? null, characterReferences: r.characterReferences.length }, provenance: r.provenance, historicalClassification: r.historicalClassification,
      cost: { expectedUsd: r.expectedCostUsd, reservedUsd: r.reservedCostUsd, actualUsd: r.actualCostUsd },
      lifecycleState: r.lifecycleState, qaStatus: r.qaStatus, retryCount: Math.max(r.retryCount, retries.length), fallbackState: r.fallbackState, decisionHash: r.decisionHash,
      operations: o.map((x) => ({ idempotencyKey: x.idempotencyKey, provider: x.provider, model: x.model, method: x.method, attemptKind: x.attemptKind, status: x.status, providerJobId: x.providerJobId, reservedUsd: x.reservedUsd, committedUsd: x.committedUsd, resultRef: x.resultRef })),
      retries: { count: Math.max(r.retryCount, retries.length), reasons: [...new Set([...retries.map((x) => x.attemptKind), ...(mixShot.get(r.contract.shotId)?.decision.attemptKind && mixShot.get(r.contract.shotId)!.decision.attemptKind !== "initial" ? [mixShot.get(r.contract.shotId)!.decision.attemptKind] : [])])] },
      fallback: { used: r.fallbackState !== "NONE", state: r.fallbackState, explicit: true },
    };
  });
  const committed = ops.filter((o) => o.status === "COMMITTED" && o.committedUsd !== null);
  const retryUsd = r4(committed.filter((o) => o.attemptKind !== "initial").reduce((t, o) => t + (o.committedUsd ?? 0), 0));
  const actualUsd = r4(Math.max(d.cost.cogsUsd, committed.reduce((t, o) => t + (o.committedUsd ?? 0), 0)));
  const reservedUsd = r4(d.reservation.status === "RESERVED" ? d.reservation.reservedUsd : d.cost.request.reservedUsd);
  const mix = measureMix(d.records);
  return {
    manifestVersion: MANIFEST_VERSION, projectId: i.projectId, generatedAt: i.now,
    pins: d.mix.shots[0] ? { policy: d.mix.shots[0].decision.versions.policyVersion, profile: d.mix.shots[0].decision.versions.profileVersion, contract: d.mix.shots[0].decision.versions.contractVersion, rateCard: d.mix.shots[0].decision.versions.rateCardVersion, memorySnapshot: d.mix.shots[0].decision.versions.memorySnapshotId } : null,
    ok: d.ok, blockers: d.blockers, stagesReached: d.stagesReached,
    plan: { shots, finishedSeconds: mix.finishedSeconds, mix, presetCheck: i.preset ? checkMixPreset(mix, i.preset) : null, generative: { shots: d.mix.generativeShots, secondsUsed: d.mix.generativeSecondsUsed, secondsBudget: d.mix.generativeSecondsBudget, heroShots: d.mix.heroShots } },
    cost: {
      estimatedUsd: r4(d.cost.request.estimatedUsd), reservedUsd, actualUsd, retryUsd, varianceUsd: r4(actualUsd - d.cost.request.estimatedUsd),
      projectBudgetUsd: i.projectBudgetUsd, remainingBudgetUsd: r4(i.projectBudgetUsd - Math.max(reservedUsd, actualUsd)),
      byProvider: Object.fromEntries(Object.entries(d.cost.byProvider).map(([p, a]) => [p, { estimatedUsd: a.estimatedUsd, reservedUsd: a.reservedUsd, actualUsd: a.actualUsd }])),
      topUpsExcludedUsd: d.cost.topUpsUsd, reconciliationRequired: d.cost.reconciliationRequired,
      reservation: { status: d.reservation.status, reservedUsd: d.reservation.reservedUsd, worstCaseUsd: d.reservation.worstCaseUsd, reasons: d.reservation.reasons },
    },
    capacity: { verdict: d.admission.verdict, accepted: d.admission.accepted, perProvider: d.admission.perProvider, reasons: d.admission.reasons },
    policy: { violations: d.policyViolations, timelineFindings: d.timeline.findings, timelinePass: d.timeline.pass },
    qa: { technicalChecks: TECHNICAL_QA_CHECKS, editorialChecks: EDITORIAL_QA_CHECKS, humanRequired: EDITORIAL_QA_CHECKS, note: "technical checks are measured (freeze detection only proves frames changed, never that motion looks good); editorial checks remain a separate human state", assets: d.assets.map((a) => ({ assetId: a.assetId, state: a.state })) },
    generated: committed.map((o) => ({ shotId: o.shotId, provider: o.provider, model: o.model, providerJobId: o.providerJobId, resultRef: o.resultRef, committedUsd: o.committedUsd })),
    failures: i.failures ?? [],
    networkCalls: d.networkCalls,
  };
}
