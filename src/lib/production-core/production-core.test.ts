/**
 * Deterministic Core tests. No provider is ever called: fetch throws for the whole file
 * and every test asserts zero network calls. PI V1.1 is imported unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseShotRecord, recordFromLongFormShot, type ProductionShotRecord, type ProductionShotRecordInput } from "./shot-record";
import { evaluateTimeline, chooseTransition, TIMELINE_RULES_V1, type TimelineSlot } from "./timeline-rules";
import { checkShotPolicy, checkProjectPolicy, PRODUCTION_POLICY_V1 } from "./policy-engine";
import { CostLedger, CostConflictError } from "./cost-engine";
import { classifyForRecovery, recoveryPlan } from "./recovery";
import { canAcceptJob, capacityView, type AdapterRegistry } from "./admission";
import { dryRunPipeline, PIPELINE_STAGES } from "./pipeline";
import { RATE_CARD_V1 } from "../production-intelligence/rate-card";
import { newAsset, transition, IllegalTransitionError, wouldSpend } from "../production-intelligence/state-machine";
import { executePaidOperation, idempotencyKey, memoryLedgerStore, ReconciliationRequiredError, type PaidOperation } from "../production-intelligence/ledger";
import { runwaySnapshot, elevenLabsSnapshot } from "../production-intelligence/capacity/adapters";
import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";
import type { Shot } from "../video/long-form/types";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-09-29T00:00:00.000Z";

function rec(k: number, o: Partial<ProductionShotRecordInput> = {}, c: Partial<ProductionShotRecordInput["contract"]> = {}): ProductionShotRecord {
  const id = `S${String(k).padStart(3, "0")}`;
  return parseShotRecord({
    contract: { shotId: id, shotClass: "object", narrationIntent: `n${k}`, visualIntent: `v${k}`, motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", desiredDuration: 5, maxGeneratedDuration: 10, qualityTier: "economy", forbiddenElements: [...PRODUCTION_POLICY_V1.content.forbiddenElementsGlobal], ...c },
    sceneId: id, blockId: `B${Math.floor(k / 5)}`, timelineOrder: k, narrativePurpose: "establish", assetType: "ken_burns_image", sourceProvider: "openai", durationTargetSec: 5, minVisibleSec: 2.5, cameraBehavior: "ken_burns", transitionIn: "cut", historicalClassification: "reconstruction", ...o,
  });
}

test("shot record: explicit contract, provenance rules, additive over Long Form shots", () => {
  const r = rec(1);
  assert.equal(r.lifecycleState, "PLANNED"); assert.equal(r.qaStatus, "NOT_RUN"); assert.equal(r.retryCount, 0); assert.equal(r.fallbackState, "NONE");
  assert.throws(() => rec(2, { provenance: { kind: "ai_recreation", provider: "openai" }, historicalClassification: "real_documented" }), /never be classified real_documented/);
  assert.throws(() => rec(3, { assetType: "text", cameraBehavior: "generated" }), /never use generated motion/);
  assert.throws(() => rec(4, { minVisibleSec: 9 }), /minVisibleSec/);
  const lf: Shot = { id: "LF1", beatId: "hook", startSec: 0, endSec: 4, durationSec: 4, type: "stock_video", source: "stock", assetId: "px-1", visualIntent: "waves", motion: "cut", captionText: "c", license: "Pexels", attribution: "x", dedupKey: "d", status: "planned", validationStatus: "pending", historicalClassification: "real_documented" };
  const fromLf = recordFromLongFormShot(lf, { motionLeverage: "LOW", riskClass: "LOW", motionRequirement: "simple", qualityTier: "economy", narrativePurpose: "hook" }, 0);
  assert.equal(fromLf.contract.stockAvailable, true); assert.equal(fromLf.sourceProvider, "pexels"); assert.equal(fromLf.contract.shotClass, "broll"); assert.equal(fromLf.historicalClassification, "real_documented");
});

test("timeline rules: static runs, opening motion, hook density, min visible, text/black cards, speech timing, repetition, deterministic transitions", () => {
  const slot = (i: number, o: Partial<TimelineSlot> = {}): TimelineSlot => ({ slotId: `T${i}`, startSec: i * 5, durationSec: 5, kind: "generated_image", motion: "static", visualKey: `k${i}`, beatId: "b0", ...o });
  const bad = [slot(0), slot(1), slot(2), slot(3), slot(4), slot(5), slot(6, { durationSec: 5 }), slot(7, { kind: "text_card", durationSec: 9, motion: "camera" })];
  const r = evaluateTimeline(bad, TIMELINE_RULES_V1, { speech: [{ startSec: 0, endSec: 44 }], openingMotionRequested: true });
  const rules = new Set(r.findings.map((f) => f.rule));
  for (const x of ["R_OPENING_MOTION", "R_STATIC_RUN", "R_TEXT_CARD_MAX", "R_CAMERA_MEANINGFUL"]) assert.ok(rules.has(x), x);
  assert.equal(r.pass, false);
  const good: TimelineSlot[] = [slot(0, { motion: "live", kind: "stock_video", durationSec: 4 }), slot(1, { startSec: 4, durationSec: 4, motion: "camera" }), slot(2, { startSec: 8, durationSec: 4, motion: "camera" }), slot(3, { startSec: 12, durationSec: 5, motion: "live", kind: "animated_generated_image", beatId: "b1", transitionIn: "dissolve" })];
  const g = evaluateTimeline(good, TIMELINE_RULES_V1, { speech: [{ startSec: 0, endSec: 17 }], openingMotionRequested: true });
  assert.equal(g.pass, true, JSON.stringify(g.findings));
  assert.equal(chooseTransition(good[2], good[3], TIMELINE_RULES_V1), "dissolve");
  assert.equal(chooseTransition(good[0], good[1], TIMELINE_RULES_V1), "cut");
  const rep = evaluateTimeline([good[0], { ...good[1], visualKey: "k0" }, good[2], good[3]], TIMELINE_RULES_V1, { speech: [{ startSec: 0, endSec: 17 }], openingMotionRequested: true });
  assert.ok(rep.findings.some((f) => f.rule === "R_REPETITION"));
  const mis = evaluateTimeline(good, TIMELINE_RULES_V1, { speech: [{ startSec: 0, endSec: 25 }], openingMotionRequested: true });
  assert.ok(mis.findings.some((f) => f.rule === "R_SPEECH_TIMING"));
  const short = evaluateTimeline([{ ...good[0], durationSec: 1 }, ...good.slice(1)], TIMELINE_RULES_V1, { speech: [], openingMotionRequested: false });
  assert.ok(short.findings.some((f) => f.rule === "R_MIN_VISIBLE"));
  assert.deepEqual(evaluateTimeline(good, TIMELINE_RULES_V1, { speech: [], openingMotionRequested: true }), evaluateTimeline(good, TIMELINE_RULES_V1, { speech: [], openingMotionRequested: true }), "deterministic");
});

test("policy engine: eligibility, ceilings, provenance, identity reference, quotas", () => {
  const ok = rec(1);
  assert.deepEqual(checkShotPolicy(ok, PRODUCTION_POLICY_V1), []);
  const badProvider = rec(2, { assetType: "ai_video", sourceProvider: "pexels", cameraBehavior: "generated" });
  assert.ok(checkShotPolicy(badProvider, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_PROVIDER_ELIGIBILITY"));
  const noLabel = rec(3, { historicalClassification: null });
  assert.ok(checkShotPolicy(noLabel, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_PROVENANCE_LABEL"));
  const identity = rec(4, {}, { shotClass: "single_human", riskFlags: ["identity_critical"] });
  assert.ok(checkShotPolicy(identity, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_IDENTITY_REFERENCE"));
  const withRef = rec(4, { characterReferences: [{ character: "Leader", referenceAssetId: "ref-1" }] }, { shotClass: "single_human", riskFlags: ["identity_critical"] });
  assert.ok(!checkShotPolicy(withRef, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_IDENTITY_REFERENCE"));
  const heroes = [rec(5, { plannedMethod: "I2V_HERO", lifecycleState: "STILL_APPROVED" }), rec(6, { plannedMethod: "I2V_HERO", lifecycleState: "STILL_APPROVED" })];
  assert.ok(checkProjectPolicy(heroes, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_HERO_QUOTA"));
  const over = Array.from({ length: 30 }, (_, k) => rec(k + 10, { reservedCostUsd: 1.9 }));
  assert.ok(checkProjectPolicy(over, PRODUCTION_POLICY_V1).some((v) => v.rule === "P_PROJECT_CEILING"));
  assert.ok(checkProjectPolicy([rec(50, { reservedCostUsd: 2.5 })], PRODUCTION_POLICY_V1).some((v) => v.rule === "P_SHOT_CEILING"));
});

test("cost engine: estimated vs reserved vs actual, idempotent commits, top-ups are never COGS", () => {
  const L = new CostLedger("req-1");
  const e = L.estimateShot(rec(1), "I2V_ECONOMY", RATE_CARD_V1, "runway", NOW, { stillExists: true });
  assert.equal(e.estimatedUsd, 0.25);
  assert.equal(L.estimateShot(rec(1), "I2V_ECONOMY", RATE_CARD_V1, "runway", NOW, { stillExists: true }).costKey, e.costKey, "same logical line -> same key");
  L.reserve(e.costKey, 0.25, NOW);
  assert.deepEqual(L.reserve(e.costKey, 0.25, NOW).status, "RESERVED", "reserving twice is a no-op");
  assert.throws(() => L.commit(e.costKey, 0.25, NOW) && L.commit(e.costKey, 0.3, NOW), CostConflictError);
  const flagged = L.commit(e.costKey, 0.25, NOW);
  assert.equal(flagged.actualUsd, 0.25, "the original figure is kept and returned idempotently");
  assert.equal(flagged.status, "RECONCILIATION_REQUIRED", "the conflict stays visible until a person reconciles");
  const n = L.estimateNarration(10000, RATE_CARD_V1, "elevenlabs:eleven_multilingual_v2", NOW);
  L.reserve(n.costKey, n.estimatedUsd, NOW);
  L.recordTopUp({ provider: "openai", kind: "TOP_UP", amountUsd: 10, at: NOW, note: "owner recharge" });
  L.recordTopUp({ provider: "openai", kind: "TOP_UP", amountUsd: 10, at: NOW, note: "owner recharge" });
  const rep = L.report();
  assert.equal(rep.topUpsUsd, 10, "duplicate top-up event recorded once");
  assert.equal(rep.cogsUsd, 0.25, "COGS excludes the top-up");
  assert.equal(rep.byProvider.runway.actualUsd, 0.25); assert.equal(rep.byProvider.elevenlabs.openUsd, 2); assert.equal(rep.byShot.S001.entries, 1); assert.equal(rep.byAssetType.narration.reservedUsd, 2);
  assert.equal(rep.request.estimatedUsd, 2.25); assert.equal(rep.deviation.actualVsEstimatedUsd, -2);
  assert.deepEqual(rep.reconciliationRequired, [e.costKey], "the conflicting commit is flagged, not overwritten");
});

test("QA state machine: invalid transitions are refused; a failed still never reaches motion", () => {
  let a = newAsset("S1");
  assert.throws(() => transition(a, "MOTION_PENDING", NOW), IllegalTransitionError);
  a = transition(a, "STILL_PENDING", NOW); a = transition(a, "STILL_READY", NOW); a = transition(a, "STILL_QA", NOW);
  assert.throws(() => transition(a, "STILL_APPROVED", NOW), IllegalTransitionError, "QA exit without reports");
  a = transition(a, "STILL_FAILED", NOW, { qa: [{ executor: "faces", pass: false, findings: ["EXTRA_LIMB"] }] });
  assert.throws(() => transition(a, "MOTION_AUTHORIZED", NOW, { decisionHash: "h" }), IllegalTransitionError);
  const c = transition(a, "CANCELLED", NOW);
  assert.equal(wouldSpend(c, "STILL_PENDING"), false);
});

test("ledger + recovery: a retry never charges twice, never regenerates a valid asset, resumes in-flight jobs", async () => {
  const store = memoryLedgerStore();
  let submits = 0;
  const port = { submit: async () => { submits++; return { providerJobId: "job-1" }; }, poll: async () => ({ resultRef: "clip.mp4", actualUsd: 0.25 }) };
  const key = idempotencyKey({ projectId: "p", shotId: "S1", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", inputFingerprint: "still-sha", attemptOrdinal: 1 });
  const op = { idempotencyKey: key, projectId: "p", shotId: "S1", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", attemptKind: "initial", reservedUsd: 0.25 };
  const first = await executePaidOperation(store, op, port, () => NOW);
  const second = await executePaidOperation(store, op, port, () => NOW);
  assert.equal(submits, 1); assert.equal(first.status, "COMMITTED"); assert.deepEqual(second, first);
  // Crash after the provider accepted: the resume path polls, never resubmits.
  const store2 = memoryLedgerStore();
  await store2.insert({ ...op, status: "PROVIDER_JOB_RECORDED", providerJobId: "job-9", resultRef: null, committedUsd: null, updatedAt: NOW });
  let submits2 = 0;
  const r = await executePaidOperation(store2, op, { submit: async () => { submits2++; return { providerJobId: "x" }; }, poll: async (id) => ({ resultRef: "r-" + id, actualUsd: 0.25 }) }, () => NOW);
  assert.equal(submits2, 0); assert.equal(r.resultRef, "r-job-9");
  // Ambiguous SUBMITTED: reconciliation, no automatic second charge.
  const store3 = memoryLedgerStore();
  await store3.insert({ ...op, status: "SUBMITTED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: NOW });
  await assert.rejects(executePaidOperation(store3, op, port, () => NOW), ReconciliationRequiredError);
  // Recovery classification from state + ledger + durable assets.
  const ops: PaidOperation[] = [{ ...op, shotId: "S001", status: "PROVIDER_JOB_RECORDED", providerJobId: "job-9", resultRef: null, committedUsd: null, updatedAt: NOW }];
  const asset = { shotId: "S002", kind: "ai_image" as const, status: "COMPLETED" as const, objectPath: "p/S002.png", updatedAtIso: NOW };
  const plan = recoveryPlan([
    rec(1), rec(2, { lifecycleState: "STILL_APPROVED", qaStatus: "PASS" }), rec(3, { lifecycleState: "STILL_FAILED", qaStatus: "FAIL" }), rec(4, {}, { existingApprovedAssetId: "approved-4" }), rec(5, { lifecycleState: "CANCELLED" }),
  ], ops, [asset, { ...asset, shotId: "S003" }]);
  assert.deepEqual(plan.decisions.map((d) => [d.shotId, d.action]), [["S001", "RESUME_IN_FLIGHT"], ["S002", "REUSE"], ["S003", "REGENERATE"], ["S004", "REUSE"], ["S005", "SKIP_CANCELLED"]]);
  assert.equal(classifyForRecovery(rec(6), [{ ...ops[0], shotId: "S006", status: "SUBMITTED", providerJobId: null }], []).action, "RECONCILE");
  assert.deepEqual(plan.blocking, []);
});

const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "t", unit: "usd", available: 50, reserved: 5, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });

test("admission: insufficient capacity rejects; UNKNOWN never accepts silently; ceilings bound spend", async () => {
  const adapters: AdapterRegistry = {
    openai: ({ reserved, pending }) => snap("openai", { reserved, pending }),
    runway: ({ reserved, pending, now }) => runwaySnapshot(reserved, pending, now),
    elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { reserved, pending, unit: "character", available: 1000 }),
  };
  const ctx = { reservedByProvider: {}, queuedByProvider: {}, now: NOW };
  const ok = await canAcceptJob([{ provider: "openai", estimated: 2, worstCase: 4 }], adapters, {}, ctx);
  assert.equal(ok.verdict, "ACCEPT");
  const insufficient = await canAcceptJob([{ provider: "openai", estimated: 40, worstCase: 60 }], adapters, {}, ctx);
  assert.equal(insufficient.verdict, "REJECT"); assert.equal(insufficient.perProvider[0].state, "INSUFFICIENT");
  const unknown = await canAcceptJob([{ provider: "runway", estimated: 1, worstCase: 2 }], adapters, {}, ctx);
  assert.equal(unknown.verdict, "NEEDS_OPERATOR"); assert.equal(unknown.perProvider[0].state, "UNKNOWN"); assert.equal(unknown.accepted, false);
  const overridden = await canAcceptJob([{ provider: "runway", estimated: 1, worstCase: 2 }], adapters, { runway: 20 }, { ...ctx, operatorAcceptsUnknown: true });
  assert.equal(overridden.verdict, "ACCEPT"); assert.match(overridden.perProvider[0].reasons.join(" "), /operator explicitly accepted/);
  const ceiling = await canAcceptJob([{ provider: "openai", estimated: 2, worstCase: 4 }], adapters, { openai: 6 }, { ...ctx, reservedByProvider: { openai: 3 } });
  assert.equal(ceiling.verdict, "REJECT"); assert.match(ceiling.reasons.join(" "), /insufficient/);
  const noAdapter = await canAcceptJob([{ provider: "veo", estimated: 1, worstCase: 1 }], adapters, {}, ctx);
  assert.equal(noAdapter.verdict, "NEEDS_OPERATOR");
  const view = capacityView(snap("openai", { available: null, reliability: "derived_from_ledger", derivedEstimate: 6.2 }), 20);
  assert.equal(view.status, "UNKNOWN"); assert.equal(view.availableBalance, null); assert.equal(view.estimatedRemaining, 15);
  const missingKey = await elevenLabsSnapshot(async () => { throw new Error("must not be called"); }, {}, 0, 0, NOW);
  assert.equal(missingKey.reliability, "none"); assert.equal(missingKey.available, null);
});

test("generic pipeline dry run: topic -> ... -> analytics without a topic-specific rule, zero network", async () => {
  const records = [
    rec(0, { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", durationTargetSec: 4, historicalClassification: "real_documented" }, { shotClass: "broll", motionRequirement: "simple", stockAvailable: true }),
    ...Array.from({ length: 5 }, (_, k) => rec(k + 1, { durationTargetSec: 4 })),
    rec(6, { assetType: "ai_video", sourceProvider: "runway", cameraBehavior: "generated", durationTargetSec: 5 }, { shotClass: "creature", motionRequirement: "complex", motionLeverage: "HIGH" }),
    ...Array.from({ length: 5 }, (_, k) => rec(k + 7, { durationTargetSec: 4 })),
  ];
  const finished = records.reduce((t, r) => t + r.durationTargetSec, 0);
  const adapters: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { reserved, pending }) };
  const r = await dryRunPipeline({ projectId: "blind-generic", records, finishedSeconds: finished, narrationCharacters: 1200, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, adapters, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW });
  assert.deepEqual(r.stagesReached, PIPELINE_STAGES);
  assert.equal(r.networkCalls, 0);
  assert.ok(r.ok, r.blockers.join("; "));
  assert.equal(r.records.find((x) => x.contract.shotId === "S006")!.plannedMethod, "I2V_ECONOMY");
  assert.equal(r.records[0].plannedMethod, "STOCK");
  assert.equal(r.reservation.status, "RESERVED"); assert.equal(r.admission.verdict, "ACCEPT");
  assert.ok(r.cost.byProvider.runway.reservedUsd > 0 && r.cost.cogsUsd === 0, "nothing committed in a dry run");
  assert.equal(r.assets[0].state, "LOCKED", "reused/stock assets lock without a spend path");
  const again = await dryRunPipeline({ projectId: "blind-generic", records, finishedSeconds: finished, narrationCharacters: 1200, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, adapters, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW });
  assert.deepEqual(again.records.map((x) => x.plannedMethod), r.records.map((x) => x.plannedMethod), "deterministic");
  const poor = await dryRunPipeline({ projectId: "blind-generic", records, finishedSeconds: finished, narrationCharacters: 1200, speech: [], projectBudgetUsd: 0.5, adapters, ceilings: {}, now: NOW });
  assert.equal(poor.ok, false); assert.equal(poor.reservation.status, "REJECTED");
});

test("no paid API was called by any test in this file", () => { assert.equal(networkCalls, 0); });
