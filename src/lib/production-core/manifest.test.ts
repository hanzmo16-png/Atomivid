/**
 * Production manifest + mix presets. Zero network: fetch throws for the whole file.
 * PI V1.1 is imported unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseShotRecord, type ProductionShotRecord, type ProductionShotRecordInput } from "./shot-record";
import { PRODUCTION_POLICY_V1 } from "./policy-engine";
import { dryRunPipeline, type DryRunInput } from "./pipeline";
import { buildProductionManifest, MANIFEST_VERSION, TECHNICAL_QA_CHECKS, EDITORIAL_QA_CHECKS } from "./manifest";
import { MIX_PRESETS, measureMix, checkMixPreset, categoryOf } from "./mix-presets";
import type { AdapterRegistry } from "./admission";
import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";
import { executePaidOperation, idempotencyKey, memoryLedgerStore, type PaidOperation } from "../production-intelligence/ledger";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-01T00:00:00.000Z";

function rec(k: number, o: Partial<ProductionShotRecordInput> = {}, c: Partial<ProductionShotRecordInput["contract"]> = {}): ProductionShotRecord {
  const id = `S${String(k).padStart(3, "0")}`;
  return parseShotRecord({
    contract: { shotId: id, shotClass: "object", narrationIntent: `n${k}`, visualIntent: `v${k}`, motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", desiredDuration: 5, maxGeneratedDuration: 10, qualityTier: "economy", forbiddenElements: [...PRODUCTION_POLICY_V1.content.forbiddenElementsGlobal], ...c },
    sceneId: id, blockId: `B${Math.floor(k / 5)}`, timelineOrder: k, narrativePurpose: "establish", assetType: "ken_burns_image", sourceProvider: "openai", durationTargetSec: 5, minVisibleSec: 2.5, cameraBehavior: "ken_burns", transitionIn: "cut", historicalClassification: "reconstruction", ...o,
  });
}
const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "t", unit: "usd", available: 50, reserved: 5, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });
const records = () => [
  rec(0, { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", durationTargetSec: 4, historicalClassification: "real_documented" }, { shotClass: "broll", motionRequirement: "simple", stockAvailable: true }),
  ...Array.from({ length: 5 }, (_, k) => rec(k + 1, { durationTargetSec: 4 })),
  rec(6, { assetType: "ai_video", sourceProvider: "runway", cameraBehavior: "generated", durationTargetSec: 5 }, { shotClass: "creature", motionRequirement: "complex", motionLeverage: "HIGH" }),
  ...Array.from({ length: 5 }, (_, k) => rec(k + 7, { durationTargetSec: 4 })),
];
const input = (over: Partial<DryRunInput> = {}): DryRunInput => {
  const rs = records(); const finished = rs.reduce((t, r) => t + r.durationTargetSec, 0);
  const adapters: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) };
  return { projectId: "acceptance-dry-run", records: rs, finishedSeconds: finished, narrationCharacters: 1200, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, adapters, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW, ...over };
};

test("manifest answers planned / provider / cost / capacity / QA questions from a dry run, with zero network", async () => {
  const d = await dryRunPipeline(input());
  assert.ok(d.ok, d.blockers.join("; "));
  const m = buildProductionManifest({ dryRun: d, projectId: "acceptance-dry-run", projectBudgetUsd: 40, now: NOW, preset: MIX_PRESETS.ECONOMICAL_30_70 });
  assert.equal(m.manifestVersion, MANIFEST_VERSION); assert.equal(m.networkCalls, 0); assert.equal(m.ok, true);
  assert.equal(m.plan.shots.length, 12); assert.ok(m.plan.shots.every((s) => s.plannedMethod && s.provider && s.decisionHash));
  assert.equal(m.plan.shots.find((s) => s.shotId === "S006")!.plannedMethod, "I2V_ECONOMY"); assert.equal(m.plan.shots.find((s) => s.shotId === "S006")!.provider, "runway");
  assert.ok(m.pins && m.pins.policy.startsWith("policy/") && m.pins.rateCard.startsWith("rate-card/"));
  assert.ok(m.cost.estimatedUsd > 0 && m.cost.reservedUsd >= m.cost.estimatedUsd && m.cost.actualUsd === 0 && m.cost.retryUsd === 0, "dry run: nothing spent");
  assert.equal(m.cost.remainingBudgetUsd, Math.round((40 - m.cost.reservedUsd) * 1e4) / 1e4); assert.equal(m.cost.topUpsExcludedUsd, 0);
  assert.ok(m.cost.byProvider.runway.reservedUsd > 0 && m.cost.byProvider.pexels.estimatedUsd === 0);
  assert.equal(m.capacity.verdict, "ACCEPT"); assert.ok(m.capacity.perProvider.every((p) => p.covered));
  assert.deepEqual([...m.qa.technicalChecks], [...TECHNICAL_QA_CHECKS]); assert.deepEqual([...m.qa.humanRequired], [...EDITORIAL_QA_CHECKS]); assert.ok(m.qa.note.includes("never that motion looks good"));
  assert.equal(m.qa.assets.find((a) => a.assetId === "S000")!.state, "LOCKED"); assert.equal(m.qa.assets.find((a) => a.assetId === "S006")!.state, "PLANNED");
  assert.equal(m.plan.mix.finishedSeconds, 49); assert.equal(m.plan.mix.seconds.ai_motion, 5); assert.equal(m.plan.mix.seconds.real_footage, 4); assert.equal(m.plan.mix.seconds.animated_stills, 40);
  assert.equal(m.plan.presetCheck!.pass, false, "an economical plan is honestly reported as off-preset");
  assert.ok(m.plan.shots.every((s) => s.fallback.explicit === true && s.fallback.used === false));
  const again = buildProductionManifest({ dryRun: await dryRunPipeline(input()), projectId: "acceptance-dry-run", projectBudgetUsd: 40, now: NOW, preset: MIX_PRESETS.ECONOMICAL_30_70 });
  assert.deepEqual(again, m, "same inputs -> identical manifest");
});

test("insufficient capacity: manifest is NOT ok, names the provider, reserves nothing spendable, and the plan is still inspectable", async () => {
  const d = await dryRunPipeline(input({ adapters: { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { available: 0.2, reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) } }));
  const m = buildProductionManifest({ dryRun: d, projectId: "acceptance-dry-run", projectBudgetUsd: 40, now: NOW });
  assert.equal(m.ok, false); assert.equal(m.capacity.verdict, "REJECT");
  assert.equal(m.capacity.perProvider.find((p) => p.provider === "runway")!.state, "INSUFFICIENT");
  assert.ok(m.blockers.some((b) => /insufficient capacity: runway/.test(b)));
  assert.equal(m.cost.actualUsd, 0); assert.equal(m.plan.shots.length, 12);
  const unknown = await dryRunPipeline(input({ adapters: { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { available: null, reliability: "none", reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) } }));
  const mu = buildProductionManifest({ dryRun: unknown, projectId: "acceptance-dry-run", projectBudgetUsd: 40, now: NOW });
  assert.equal(mu.capacity.verdict, "NEEDS_OPERATOR", "UNKNOWN capacity never starts silently");
});

test("explicit fallback and retries are visible per shot; a downgrade is a state, never a silent quality change", async () => {
  const d = await dryRunPipeline(input());
  const degraded = { ...d, records: d.records.map((r) => (r.contract.shotId === "S006" ? { ...r, fallbackState: "STILL_MOTION_FALLBACK" as const, retryCount: 2, lifecycleState: "MOTION_FAILED" as const, qaStatus: "FALLBACK" as const } : r)) };
  const store = memoryLedgerStore();
  const port = { submit: async () => ({ providerJobId: "job-1" }), poll: async () => ({ resultRef: "asset-1", actualUsd: 0.25 }) };
  const base = { projectId: "acceptance-dry-run", shotId: "S006", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", reservedUsd: 0.5 };
  const k1 = idempotencyKey({ projectId: "acceptance-dry-run", shotId: "S006", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", inputFingerprint: "fp-1", attemptOrdinal: 1 });
  await executePaidOperation(store, { ...base, idempotencyKey: k1, attemptKind: "initial" }, port, () => NOW);
  await executePaidOperation(store, { ...base, idempotencyKey: k1, attemptKind: "initial" }, port, () => NOW);
  const k2 = idempotencyKey({ projectId: "acceptance-dry-run", shotId: "S006", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", inputFingerprint: "fp-2", attemptOrdinal: 2 });
  await executePaidOperation(store, { ...base, idempotencyKey: k2, attemptKind: "simplified_retry" }, port, () => NOW);
  const ops: PaidOperation[] = [...store.ops.values()];
  assert.equal(ops.length, 2, "the repeated identical attempt did not create a second billable operation");
  const m = buildProductionManifest({ dryRun: degraded, projectId: "acceptance-dry-run", projectBudgetUsd: 40, now: NOW, operations: ops, failures: [{ shotId: "S006", kind: "provider_no_output", detail: "runway returned no clip" }] });
  const s = m.plan.shots.find((x) => x.shotId === "S006")!;
  assert.equal(s.fallback.used, true); assert.equal(s.fallback.state, "STILL_MOTION_FALLBACK"); assert.equal(s.lifecycleState, "MOTION_FAILED"); assert.equal(s.qaStatus, "FALLBACK");
  assert.equal(s.retries.count, 2); assert.ok(s.retries.reasons.includes("simplified_retry"));
  assert.equal(s.operations.length, 2); assert.ok(s.operations.every((o) => o.status === "COMMITTED" && o.providerJobId === "job-1"));
  assert.equal(m.generated.length, 2); assert.equal(m.cost.actualUsd, 0.5); assert.equal(m.cost.retryUsd, 0.25);
  assert.equal(m.cost.varianceUsd, Math.round((0.5 - m.cost.estimatedUsd) * 1e4) / 1e4);
  assert.deepEqual(m.failures, [{ shotId: "S006", kind: "provider_no_output", detail: "runway returned no clip" }]);
  assert.ok(!JSON.stringify(m).includes("720"), "no resolution downgrade exists in policy: nothing can degrade to 720p silently");
});

test("mix presets: categories come from records + planned method, deviations are deterministic and honest", () => {
  const rs = records().map((r, i) => ({ ...r, plannedMethod: (i === 6 ? "I2V_ECONOMY" : i === 0 ? "STOCK" : "STILL_KEN_BURNS") as ProductionShotRecord["plannedMethod"] }));
  const graphic = rec(20, { assetType: "text", sourceProvider: "internal", cameraBehavior: "static", durationTargetSec: 3 }, { shotClass: "graphic", motionRequirement: "none" });
  assert.equal(categoryOf(rs[6], "I2V_ECONOMY"), "ai_motion"); assert.equal(categoryOf(rs[0], "STOCK"), "real_footage"); assert.equal(categoryOf(graphic, null), "graphics"); assert.equal(categoryOf(rs[1], "STILL_KEN_BURNS"), "animated_stills");
  const m = measureMix([...rs, graphic]);
  assert.equal(m.finishedSeconds, 52); assert.equal(m.share.ai_motion, 0.096); assert.equal(m.shots.animated_stills, 10); assert.equal(m.seconds.graphics, 3);
  assert.equal(checkMixPreset(m, MIX_PRESETS.AI_MOTION_100).pass, false);
  assert.equal(checkMixPreset(m, MIX_PRESETS.HYBRID_50_50).pass, false);
  const all = rs.map((r) => ({ ...r, assetType: "ai_video" as const, cameraBehavior: "generated" as const, plannedMethod: "I2V_ECONOMY" as const }));
  assert.equal(checkMixPreset(measureMix(all), MIX_PRESETS.AI_MOTION_100).pass, true);
  for (const p of Object.values(MIX_PRESETS)) assert.equal(Math.round(Object.values(p.targets).reduce((a, b) => a + b, 0) * 1000) / 1000, 1, `${p.presetId} targets sum to 1`);
  assert.equal(networkCalls, 0);
});
