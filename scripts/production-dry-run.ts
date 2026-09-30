/**
 * Acceptance evidence: a full long-form DRY RUN (topic -> analytics) producing shot contracts,
 * mix plan, cost estimate, capacity forecast, QA plan and the production manifest, WITHOUT any
 * billable call (the pipeline throws on any fetch). Three capacity scenarios are written.
 * Usage: npx tsx scripts/production-dry-run.ts [outDir]
 */
import fs from "node:fs";
import path from "node:path";
import { parseShotRecord, type ProductionShotRecord, type ProductionShotRecordInput } from "../src/lib/production-core/shot-record";
import { PRODUCTION_POLICY_V1 } from "../src/lib/production-core/policy-engine";
import { dryRunPipeline, type DryRunInput } from "../src/lib/production-core/pipeline";
import { buildProductionManifest } from "../src/lib/production-core/manifest";
import { MIX_PRESETS } from "../src/lib/production-core/mix-presets";
import type { AdapterRegistry } from "../src/lib/production-core/admission";
import type { CapacitySnapshot } from "../src/lib/production-intelligence/capacity/capacity";

const NOW = new Date().toISOString();
function rec(k: number, o: Partial<ProductionShotRecordInput> = {}, c: Partial<ProductionShotRecordInput["contract"]> = {}): ProductionShotRecord {
  const id = `S${String(k).padStart(3, "0")}`;
  return parseShotRecord({
    contract: { shotId: id, shotClass: "object", narrationIntent: `narration ${k}`, visualIntent: `visual ${k}`, motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", desiredDuration: 5, maxGeneratedDuration: 10, qualityTier: "economy", forbiddenElements: [...PRODUCTION_POLICY_V1.content.forbiddenElementsGlobal], ...c },
    sceneId: id, blockId: `B${Math.floor(k / 5)}`, timelineOrder: k, narrativePurpose: "establish", assetType: "ken_burns_image", sourceProvider: "openai", durationTargetSec: 5, minVisibleSec: 2.5, cameraBehavior: "ken_burns", transitionIn: "cut", historicalClassification: "reconstruction", ...o,
  });
}
const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "mock", unit: "usd", available: 50, reserved: 5, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });

/** Generic mid-length documentary shape (no topic-specific rule): stock openers, two hero creature shots, animated stills. */
function records(shots: number): ProductionShotRecord[] {
  const out: ProductionShotRecord[] = [rec(0, { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", durationTargetSec: 6, historicalClassification: "real_documented" }, { shotClass: "broll", motionRequirement: "simple", stockAvailable: true })];
  for (let k = 1; k < shots; k++) {
    if (k === 6 || k === 36) out.push(rec(k, { assetType: "ai_video", sourceProvider: "runway", cameraBehavior: "generated", durationTargetSec: 5 }, { shotClass: "creature", motionRequirement: "complex", motionLeverage: "HIGH" }));
    else if (k % 5 === 3) out.push(rec(k, { assetType: "stock_video", sourceProvider: "pexels", cameraBehavior: "cut", durationTargetSec: 5, historicalClassification: "real_documented" }, { shotClass: "broll", motionRequirement: "simple", stockAvailable: true }));
    else out.push(rec(k, { durationTargetSec: 5.5 }));
  }
  return out;
}

async function main() {
  const out = process.argv[2] ?? "docs/production-core/evidence";
  fs.mkdirSync(out, { recursive: true });
  const rs = records(40); const finished = rs.reduce((t, r) => t + r.durationTargetSec, 0);
  const big = records(120); const bigFinished = big.reduce((t, r) => t + r.durationTargetSec, 0);
  const healthy: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) };
  const insufficient: AdapterRegistry = { ...healthy, runway: ({ reserved, pending }) => snap("runway", { available: 0.5, reserved, pending }) };
  const unknown: AdapterRegistry = { ...healthy, runway: ({ reserved, pending }) => snap("runway", { available: null, reliability: "none", reserved, pending }) };
  const base: Omit<DryRunInput, "adapters"> = { projectId: "video-003-dry-run", records: rs, finishedSeconds: finished, narrationCharacters: 9800, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW };
  const scenarios: [string, DryRunInput][] = [
    ["healthy", { ...base, adapters: healthy }],
    ["insufficient-runway", { ...base, adapters: insufficient }],
    ["unknown-runway", { ...base, adapters: unknown }],
    ["budget-guard-120-shots", { ...base, records: big, finishedSeconds: bigFinished, speech: [{ startSec: 0, endSec: bigFinished }], adapters: healthy }],
  ];
  for (const [name, inp] of scenarios) {
    const d = await dryRunPipeline(inp);
    const m = buildProductionManifest({ dryRun: d, projectId: base.projectId, projectBudgetUsd: inp.projectBudgetUsd, now: NOW, preset: MIX_PRESETS.ECONOMICAL_30_70 });
    fs.writeFileSync(path.join(out, `dry-run-manifest-${name}.json`), JSON.stringify(m, null, 1) + "\n");
    console.log(`${name}: ok=${m.ok} stages=${m.stagesReached.length}/11 shots=${m.plan.shots.length} finished=${m.plan.finishedSeconds}s generative=${m.plan.generative.shots} shots/${m.plan.generative.secondsUsed}s of ${m.plan.generative.secondsBudget}s | est USD ${m.cost.estimatedUsd} reserved USD ${m.cost.reservedUsd} actual USD ${m.cost.actualUsd} remaining USD ${m.cost.remainingBudgetUsd} | capacity ${m.capacity.verdict} ${m.capacity.perProvider.map((p) => `${p.provider}=${p.state}`).join(",")} | network=${m.networkCalls} | blockers=${m.blockers.length ? [...new Set(m.blockers)].slice(0, 4).join(" / ") + (m.blockers.length > 4 ? ` (+${m.blockers.length - 4})` : "") : "none"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
