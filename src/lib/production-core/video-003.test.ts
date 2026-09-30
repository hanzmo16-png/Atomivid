/**
 * Video #003 storyboard gate: real contracts, Ocean-derived pacing, no placeholders, no victims,
 * zero network. The engine is imported unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { video003ShotRecords, ROWS, VIDEO_003 } from "../../../content/productions/video-003-lake-nyos/storyboard";
import { dryRunPipeline } from "./pipeline";
import { measureMix, MIX_PRESETS, checkMixPreset } from "./mix-presets";
import type { AdapterRegistry } from "./admission";
import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-01T00:00:00.000Z";
const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "t", unit: "usd", available: 50, reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });

test("every Video #003 shot is a real, parseable contract with narration and visual intent; no placeholder, no victims", () => {
  const all = video003ShotRecords();
  assert.ok(all.length >= 80 && all.length === ROWS.length);
  for (const r of all) {
    assert.ok(r.contract.visualIntent.length > 20 && r.contract.narrationIntent.length > 3, r.contract.shotId);
    assert.ok(!/placeholder|tbd|lorem|todo/i.test(r.contract.visualIntent + r.narrativePurpose), r.contract.shotId);
    assert.ok(!/bod(y|ies)|corpse|victim/i.test(r.contract.visualIntent), `${r.contract.shotId} must not depict victims`);
    assert.ok(r.contract.forbiddenElements.includes("human bodies or victims"));
    assert.ok(r.historicalClassification === "real_documented" ? r.assetType === "stock_video" : r.historicalClassification === "reconstruction", "generated/reconstructed imagery is labelled reconstruction, stock is real_documented");
  }
  assert.equal(new Set(all.map((r) => r.contract.shotId)).size, all.length);
  const total = all.reduce((t, r) => t + r.durationTargetSec, 0);
  assert.ok(total >= 540 && total <= 660, `target ~9.5–10.5 min, got ${total}s`);
  assert.equal(VIDEO_003.language, "en");
});

test("pacing learned from Ocean: >= 8 shots in the first 30 s averaging <= 4.5 s, motion from second 0, text-only cards <= 1.5 s", () => {
  const all = video003ShotRecords();
  let t = 0; const first: number[] = [];
  for (const r of all) { if (t >= 30) break; first.push(r.durationTargetSec); t += r.durationTargetSec; }
  assert.ok(first.length >= 8, `first 30 s has ${first.length} shots`);
  assert.ok(first.reduce((a, b) => a + b, 0) / first.length <= 4.5);
  assert.equal(all[0].assetType, "stock_video"); assert.notEqual(all[0].cameraBehavior, "static");
  for (const r of all) if (/end card/i.test(r.narrativePurpose)) assert.ok(r.durationTargetSec <= 1.5, "text-only card <= 1.5 s");
  let run = 0; for (const r of all) { run = r.cameraBehavior === "static" ? run + r.durationTargetSec : 0; assert.ok(run <= 8, `static run ${run}s at ${r.contract.shotId}`); }
});

test("dry run of the real plan: zero network, all 11 stages, no policy violation, timeline rules pass, cost within the project ceiling", async () => {
  const records = video003ShotRecords({ includeGraphics: false });
  const finished = records.reduce((t, r) => t + r.durationTargetSec, 0);
  const adapters: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) };
  const d = await dryRunPipeline({ projectId: VIDEO_003.projectId, records, finishedSeconds: finished, narrationCharacters: 5600, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, adapters, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW });
  assert.equal(d.networkCalls, 0); assert.equal(d.stagesReached.length, 11);
  assert.deepEqual(d.policyViolations, []); assert.ok(d.timeline.pass, JSON.stringify(d.timeline.findings));
  assert.ok(d.ok, d.blockers.join("; "));
  assert.ok(d.cost.request.reservedUsd <= 40 && d.cost.byProvider.openai.reservedUsd <= 20 && d.cost.byProvider.runway.reservedUsd <= 20);
  assert.ok(d.mix.generativeShots >= 8, "the eruption/fountain sequences get AI motion");
  for (const r of d.records) assert.ok((r.plannedMethod === "I2V_ECONOMY" || r.plannedMethod === "I2V_HERO") === (r.assetType === "ai_video"), "record asset type matches the planned method");
  const m = measureMix(d.records);
  assert.ok(m.share.ai_motion > 0.1 && m.share.ai_motion < 0.3, `AI motion share ${m.share.ai_motion}`);
  assert.equal(checkMixPreset(m, MIX_PRESETS.AI_MOTION_100).pass, false);
  assert.equal(networkCalls, 0);
});

test("research, script and topic selection exist and the script carries no fabricated certainty markers", () => {
  const dir = "content/productions/video-003-lake-nyos";
  for (const f of ["TOPIC-SELECTION.md", "RESEARCH.md", "SCRIPT.md"]) assert.ok(fs.existsSync(`${dir}/${f}`), f);
  const research = fs.readFileSync(`${dir}/RESEARCH.md`, "utf8");
  assert.ok(research.includes("FACT") && research.includes("INFERENCE") && research.includes("VISUAL RECONSTRUCTION"));
  const script = fs.readFileSync(`${dir}/SCRIPT.md`, "utf8");
  assert.ok(/still cannot say what/.test(script) && /Shoreline damage suggests/.test(script), "uncertainty is stated, not hidden");
  assert.ok(!/conspiracy|cover-up/i.test(script));
});
