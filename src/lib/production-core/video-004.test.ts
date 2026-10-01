/**
 * Video #004 (Thermopylae) storyboard gate: real contracts, hook pacing, no placeholders, no gore, no film
 * clichés, zero network, nothing reused from earlier productions. The engine is imported unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { video004ShotRecords, ROWS, VIDEO_004, PAUSES, secondsOf, words } from "../../../content/productions/video-004-thermopylae/storyboard";
import { dryRunPipeline } from "./pipeline";
import { measureMix, MIX_PRESETS, checkMixPreset } from "./mix-presets";
import type { AdapterRegistry } from "./admission";
import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-01T00:00:00.000Z";
const DIR = "content/productions/video-004-thermopylae";
const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "t", unit: "usd", available: 50, reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });

test("every Video #004 shot is a real, parseable contract with narration and visual intent; no placeholder, no gore, no film clichés", () => {
  const all = video004ShotRecords();
  assert.ok(all.length >= 80 && all.length === ROWS.length);
  for (const r of all) {
    assert.ok(r.contract.visualIntent.length > 20 && r.contract.narrationIntent.length > 3, r.contract.shotId);
    assert.ok(!/placeholder|tbd|lorem|todo/i.test(r.contract.visualIntent + r.narrativePurpose), r.contract.shotId);
    assert.ok(!/blood|gore|wound|corpse|bod(y|ies) (lying|strewn)/i.test(r.contract.visualIntent), `${r.contract.shotId} must not depict gore or the dead`);
    assert.ok(!/lambda|six-?pack|abs\b|cape only|bare-chested|monster|giant|fantasy/i.test(r.contract.visualIntent.replace(/no lambda|plain unpainted/g, "")), `${r.contract.shotId} must not imitate the film`);
    assert.ok(r.contract.forbiddenElements.includes("blood, wounds, gore or corpses") && r.contract.forbiddenElements.includes("lambda shield blazon"));
    assert.ok(r.historicalClassification === "real_documented" ? r.assetType === "stock_video" : r.historicalClassification === "reconstruction", "generated/reconstructed imagery is labelled reconstruction, stock is real_documented");
    if (r.assetType === "diagram") assert.ok(/map|diagram|card|graphic|infographic|timeline|cross-section/i.test(r.contract.visualIntent), `${r.contract.shotId} graphics are deterministic`);
    if (r.assetType === "ai_video") assert.ok(r.contract.shotClass !== "multi_human", `${r.contract.shotId}: near-frame crowds are never generated as video`);
  }
  assert.equal(new Set(all.map((r) => r.contract.shotId)).size, all.length);
  const total = all.reduce((t, r) => t + r.durationTargetSec, 0);
  assert.ok(total >= 660 && total <= 800, `narration-led cut (~11–13 min planned), got ${total}s`);
  assert.equal(VIDEO_004.language, "en");
  assert.equal(all.filter((r) => r.contract.qualityTier === "hero").length, 1, "exactly one hero shot (profile hero quota)");
});

test("hook pacing: motion from second 0 (AI clip), >= 8 shots in the first 30 s averaging <= 4.5 s, text-only cards <= 1.5 s, no static run over 20 s", () => {
  const all = video004ShotRecords();
  let t = 0; const first: number[] = [];
  for (const r of all) { if (t >= 30) break; first.push(r.durationTargetSec); t += r.durationTargetSec; }
  assert.ok(first.length >= 8, `first 30 s has ${first.length} shots`);
  assert.ok(first.reduce((a, b) => a + b, 0) / first.length <= 4.5);
  assert.equal(all[0].assetType, "ai_video"); assert.equal(all[0].cameraBehavior, "generated"); assert.equal(all[0].contract.motionLeverage, "HIGH");
  for (const r of all) if (/end card/i.test(r.narrativePurpose)) assert.ok(r.durationTargetSec <= 1.5, "text-only card <= 1.5 s");
  let run = 0; for (const r of all) { run = r.cameraBehavior === "static" ? run + r.durationTargetSec : 0; assert.ok(run <= 20, `static run ${run}s at ${r.contract.shotId}`); }
});

test("dry run of the real plan: zero network, all 11 stages, no policy violation, timeline rules pass, 14 generative shots incl. the hero, cost within ceilings", async () => {
  const records = video004ShotRecords({ includeGraphics: false });
  const finished = records.reduce((t, r) => t + r.durationTargetSec, 0);
  const adapters: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }), elevenlabs: ({ reserved, pending }) => snap("elevenlabs", { unit: "character", available: 200000, reserved, pending }) };
  const d = await dryRunPipeline({ projectId: VIDEO_004.projectId, records, finishedSeconds: finished, narrationCharacters: 9000, speech: [{ startSec: 0, endSec: finished }], projectBudgetUsd: 40, adapters, ceilings: { openai: 20, runway: 20, elevenlabs: 10 }, now: NOW });
  assert.equal(d.networkCalls, 0); assert.equal(d.stagesReached.length, 11);
  assert.deepEqual(d.policyViolations, []); assert.ok(d.timeline.pass, JSON.stringify(d.timeline.findings));
  assert.ok(d.ok, d.blockers.join("; "));
  assert.ok(d.cost.request.reservedUsd <= 40 && d.cost.byProvider.openai.reservedUsd <= 20 && d.cost.byProvider.runway.reservedUsd <= 20);
  assert.equal(d.mix.generativeShots, 14, "the battle, the bridges and the night march get AI motion");
  assert.equal(d.mix.heroShots, 1);
  const generative = d.records.filter((r) => r.plannedMethod === "I2V_ECONOMY" || r.plannedMethod === "I2V_HERO");
  assert.deepEqual(generative.map((r) => r.contract.shotId), records.filter((r) => r.assetType === "ai_video").map((r) => r.contract.shotId), "exactly the storyboard's AI rows are animated");
  assert.equal(generative.find((r) => r.plannedMethod === "I2V_HERO")?.narrativePurpose, "into the open");
  const m = measureMix(d.records);
  assert.ok(m.share.ai_motion > 0.08 && m.share.ai_motion < 0.3, `AI motion share ${m.share.ai_motion}`);
  assert.equal(checkMixPreset(m, MIX_PRESETS.AI_MOTION_100).pass, false);
  assert.equal(networkCalls, 0);
});

test("research, script, verification and topic record exist; uncertainty is stated; nothing is reused from earlier productions", () => {
  for (const f of ["TOPIC-SELECTION.md", "RESEARCH.md", "VERIFICATION.md", "SCRIPT.md"]) assert.ok(fs.existsSync(`${DIR}/${f}`), f);
  const research = fs.readFileSync(`${DIR}/RESEARCH.md`, "utf8");
  assert.ok(research.includes("FACT") && research.includes("INFERENCE") && research.includes("CONTESTED") && research.includes("VISUAL RECONSTRUCTION"));
  const script = fs.readFileSync(`${DIR}/SCRIPT.md`, "utf8");
  assert.ok(/Herodotus counted more than two million/.test(script) && /Modern historians think/.test(script), "both the ancient and the modern numbers are given");
  assert.ok(/does not appear in Herodotus/.test(script) && /in 480 it did not exist/.test(script), "the film's clichés are corrected, not repeated");
  assert.ok(/did Thermopylae matter\?/.test(script), "significance is posed as a question");
  assert.ok(!/Nyos|Kivu|Monoun|Cameroon|limnic/i.test(script + research + ROWS.map((r) => r[3]).join(" ")), "no content from the halted production");
});

test("timeline is narration-led: storyboard narration equals SCRIPT.md verbatim, every duration is speech + tail + a declared pause, no picture-only interval > 5 s", () => {
  const script = fs.readFileSync(`${DIR}/SCRIPT.md`, "utf8").split("## S1")[1].split("\n---")[0].replace(/^[^\n]*\n/, "").replace(/^##.*$/gm, "");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const rows = ROWS.slice(0, -1);
  assert.equal(norm(rows.map((r) => r[4]).join(" ")), norm(script), "storyboard narration must be the script, sentence by sentence");
  const purposes = ROWS.map((r) => r[2]);
  for (const k of Object.keys(PAUSES)) assert.ok(purposes.includes(k), `pause key ${k} names a row`);
  let silentTotal = 0;
  for (const r of rows) {
    const speech = words(r[4]) / 2.5; const pause = PAUSES[r[2]] ?? 0;
    const expected = Math.max(2.5, Math.ceil((speech + 0.5 + pause) * 2) / 2);
    assert.equal(secondsOf(r), expected, `${r[2]}: ${secondsOf(r)}s vs ${expected}s`);
    const silent = secondsOf(r) - speech; silentTotal += silent;
    assert.ok(silent <= 5, `${r[2]} has ${silent}s without narration`);
  }
  const total = rows.reduce((t, r) => t + secondsOf(r), 0);
  assert.ok(silentTotal / total <= 0.25, `picture-only share ${silentTotal / total}`);
});
