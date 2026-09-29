/**
 * Final Cut Intelligence V1 tests. Global fetch throws for the whole file; the last test
 * asserts zero network calls. Media tests use a synthetic clip rendered by LOCAL ffmpeg.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EDL_VERSION, emptyMeasured, parseEdl, type EdlSlot, type MasterEdl } from "./edl";
import { FINAL_CUT_POLICY_V1 } from "./policy";
import { inspect, edlFingerprint } from "./inspect";
import { planAutoFix, applyFixPlan, renderOps } from "./auto-fix";
import { proposeRepair, gateRepairs, authorizeRepair, executeRepair, RepairAuthorizationError } from "./smart-repair";
import { newEditorialRecord, editorialTransition, distributionEligible, IllegalEditorialTransitionError } from "./gate";
import { runFinalCut } from "./run";
import { memoryFinalCutStore } from "./persistence";
import { measureMedia, edlFromMeasurement, mergeMeasurement } from "./adapters/media";
import { edlFromMotionStoryboard, edlFromSlotStoryboard } from "./adapters/storyboard";
import type { AdapterRegistry } from "../production-core/admission";
import type { CapacitySnapshot } from "../production-intelligence/capacity/capacity";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-09-29T00:00:00.000Z";
const P = FINAL_CUT_POLICY_V1;

function slot(i: number, start: number, dur: number, o: Partial<EdlSlot> = {}): EdlSlot {
  return { slotId: `T${i}`, shotId: `S${i}`, startSec: start, durationSec: dur, kind: "generated_image", motion: "camera", visualKey: `k${i}`, beatId: `b${Math.floor(i / 6)}`, ...o };
}
/** A clean 60 s master: moving opening, camera motion everywhere, speech covering the whole cut. */
function cleanEdl(o: Partial<MasterEdl> = {}): MasterEdl {
  const slots: EdlSlot[] = []; let t = 0;
  for (let i = 0; i < 15; i++) { slots.push(slot(i, t, 4, i % 3 === 0 ? { kind: "stock_video", motion: "live" } : {})); t += 4; }
  return parseEdl({ edlVersion: EDL_VERSION, masterId: "m-clean", productionId: "p-test", source: { kind: "edit_timeline", ref: "synthetic" }, durationSec: 60, width: 1920, height: 1080, fps: 30, slots, speech: [{ startSec: 0.2, endSec: 59.8 }], captions: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, text: "twelve words of narration here", startSec: i * 5 + 0.3, endSec: i * 5 + 3.5, bottomY: 0.88, leftX: 0.15, rightX: 0.85 })), measured: { ...emptyMeasured(), blackIntervals: [], freezeIntervals: [], silenceIntervals: [], integratedLufs: -16, truePeakDbtp: -1.6, clippingSamples: 0, voiceOverMusicDb: 12, fadeInSec: 0.5, fadeOutSec: 0.5 }, ...o });
}

test("inspection determinism: same EDL + policy -> identical report (except timestamp), content-addressed issue ids", () => {
  const e = cleanEdl();
  const a = inspect(e, { now: NOW }), b = inspect(e, { now: "2026-10-01T00:00:00.000Z" });
  assert.equal(a.reportId, b.reportId); assert.deepEqual({ ...a, timestamp: 0 }, { ...b, timestamp: 0 });
  assert.equal(a.verdict, "PASS", a.reasons.join("; "));
  assert.equal(a.inputSha256, edlFingerprint(e));
  const shuffled = { ...e, slots: [...e.slots].reverse() };
  assert.deepEqual(inspect(shuffled, { now: NOW }).issues, a.issues, "slot order does not change findings");
});

test("black frame detection: measured black outside an intentional black slot, classified AUTO_FIX within tolerance", () => {
  const e = cleanEdl({ measured: { ...cleanEdl().measured, blackIntervals: [{ startSec: 0, endSec: 0.8 }, { startSec: 30, endSec: 33 }] } });
  const r = inspect(e, { now: NOW });
  const black = r.issues.filter((i) => i.rule === "V_BLACK_FRAMES");
  assert.equal(black.length, 2);
  assert.equal(black[0].repairClass, "AUTO_FIX"); assert.equal(black[1].repairClass, "SMART_REPAIR", "3 s exceeds the auto-trim tolerance");
  assert.ok(black[0].confidence >= 0.95);
  const intentional = cleanEdl({ slots: [{ slotId: "blk", shotId: null, startSec: 0, durationSec: 0.8, kind: "black", motion: "static", visualKey: "black", beatId: "b0" }, ...cleanEdl().slots.map((s) => ({ ...s, startSec: s.startSec + 0.8 }))], durationSec: 60.8, measured: { ...cleanEdl().measured, blackIntervals: [{ startSec: 0, endSec: 0.8 }] } });
  assert.ok(!inspect(intentional, { now: NOW }).issues.some((i) => i.rule === "V_BLACK_FRAMES"), "an intentional black slot is not a defect");
});

test("excessive still duration: a long static run and an over-long shot are found with time ranges", () => {
  const slots: EdlSlot[] = []; let t = 0;
  for (let i = 0; i < 10; i++) { slots.push(slot(i, t, i === 0 ? 4 : 6, i === 0 ? { kind: "stock_video", motion: "live" } : { motion: "static" })); t += i === 0 ? 4 : 6; }
  slots.push(slot(10, t, 25, { kind: "stock_video", motion: "live" }));
  const e = cleanEdl({ slots, durationSec: t + 25, speech: [{ startSec: 0, endSec: t + 25 }], captions: [] });
  const r = inspect(e, { now: NOW });
  const run = r.issues.find((i) => i.rule === "R_STATIC_RUN")!;
  assert.ok(run, "static run detected"); assert.equal(run.startTime, 4); assert.equal(run.repairClass, "SMART_REPAIR");
  assert.ok(r.issues.some((i) => i.rule === "V_SHOT_TOO_LONG" && i.shotId === "S10"));
  assert.ok(r.editorial.longestStaticRunSec! >= 54);
});

test("hook density and opening metrics against the configurable policy", () => {
  const e = cleanEdl({ slots: [slot(0, 0, 20, { motion: "static" }), slot(1, 20, 20, { motion: "static" }), slot(2, 40, 20, { kind: "stock_video", motion: "live" })], captions: [] });
  const r = inspect(e, { now: NOW });
  for (const rule of ["R_OPENING_MOTION", "R_HOOK_DENSITY", "O_SHOT_COUNT", "O_AVG_SHOT", "O_MOVEMENT_DENSITY", "O_STILL_STREAK"]) assert.ok(r.issues.some((i) => i.rule === rule), rule);
  assert.deepEqual({ shotCount: r.opening.shotCount, movementDensity: r.opening.movementDensity, stillStreakMaxSec: r.opening.stillStreakMaxSec }, { shotCount: 2, movementDensity: 0, stillStreakMaxSec: 30 });
  const relaxed = { ...P, opening: { ...P.opening, minShotCount: 1, maxAvgShotSec: 30, minMovementDensity: 0, maxStillStreakSec: 60 } };
  assert.ok(!inspect(e, { now: NOW, policy: relaxed }).issues.some((i) => i.category === "opening"), "opening findings come only from policy bounds");
});

test("repeated asset: visible reuse inside the window; AUTO_FIX only with a validated alternate", () => {
  const base = cleanEdl();
  const slots = base.slots.map((s, i) => (i === 4 ? { ...s, visualKey: "k1" } : i === 9 ? { ...s, visualKey: "k6", validatedAlternates: ["alt-9b", "alt-9a"] } : s));
  const r = inspect({ ...base, slots }, { now: NOW });
  const rep = r.issues.filter((i) => i.rule === "V_ASSET_REPETITION");
  assert.equal(rep.length, 2);
  assert.equal(rep.find((i) => i.shotId === "S4")!.repairClass, "SMART_REPAIR"); assert.equal(rep.find((i) => i.shotId === "S9")!.repairClass, "AUTO_FIX");
  const plan = planAutoFix({ ...base, slots }, r.issues, P);
  assert.deepEqual(plan.operations.filter((o) => o.op === "SUBSTITUTE_VALIDATED_ASSET"), [{ op: "SUBSTITUTE_VALIDATED_ASSET", issueId: rep.find((i) => i.shotId === "S9")!.issueId, slotId: "T9", assetId: "alt-9a" }]);
});

test("subtitle timing problems: overlap, outside speech, unreadable, safe area, truncated final caption", () => {
  const base = cleanEdl();
  const captions = [...base.captions];
  captions[1] = { ...captions[1], startSec: captions[0].endSec - 0.5 };
  captions[3] = { ...captions[3], text: "a".repeat(120) };
  captions[5] = { ...captions[5], bottomY: 0.97 };
  const e = { ...base, captions, speech: [{ startSec: 0.2, endSec: 50 }, { startSec: 52, endSec: 63 }], durationSec: 60 };
  const r = inspect(e, { now: NOW });
  for (const rule of ["S_OVERLAP", "S_UNREADABLE", "S_SAFE_AREA", "S_OUTSIDE_SPEECH"]) assert.ok(r.issues.some((i) => i.rule === rule), rule);
  assert.ok(r.issues.some((i) => i.rule === "A_WORD_CUT"), "master ends inside speech");
  const fixed = applyFixPlan(e, planAutoFix(e, r.issues, P));
  const again = inspect(fixed, { now: NOW });
  assert.ok(!again.issues.some((i) => i.rule === "S_OVERLAP" || i.rule === "S_SAFE_AREA"), "overlap and safe area repaired deterministically");
});

test("loudness / true peak violations are measured, classified and corrected within policy range", () => {
  const e = cleanEdl({ measured: { ...cleanEdl().measured, integratedLufs: -19, truePeakDbtp: -0.4 } });
  const r = inspect(e, { now: NOW });
  const l = r.issues.find((i) => i.rule === "A_LOUDNESS")!, tp = r.issues.find((i) => i.rule === "A_TRUE_PEAK")!;
  assert.equal(l.repairClass, "AUTO_FIX"); assert.equal(tp.repairClass, "AUTO_FIX");
  const plan = planAutoFix(e, r.issues, P);
  assert.ok(plan.operations.some((o) => o.op === "LOUDNESS_CORRECT" && o.gainLu === 3) && plan.operations.some((o) => o.op === "TRUE_PEAK_LIMIT"));
  const fixed = applyFixPlan(e, plan);
  assert.equal(fixed.measured.integratedLufs, -16); assert.ok(fixed.measured.truePeakDbtp! <= P.audio.truePeakMaxDbtp);
  assert.ok(!inspect(fixed, { now: NOW }).issues.some((i) => i.category === "audio"));
  const far = cleanEdl({ measured: { ...cleanEdl().measured, integratedLufs: -26 } });
  assert.equal(inspect(far, { now: NOW }).issues.find((i) => i.rule === "A_LOUDNESS")!.repairClass, "SMART_REPAIR", "beyond the auto-correction range");
  assert.ok(renderOps(plan).some((x) => x.includes("loudnorm")));
  const unmeasured = cleanEdl({ measured: emptyMeasured() });
  assert.ok(inspect(unmeasured, { now: NOW }).counts.notAssessable.includes("integrated loudness"), "unmeasured is reported, never assumed fine");
});

test("AUTO_FIX idempotency: applying the plan twice equals applying it once; the input EDL is untouched", () => {
  const base = cleanEdl();
  const e = { ...base, slots: [{ slotId: "card", shotId: null, startSec: 0, durationSec: 9, kind: "text_card" as const, motion: "camera" as const, visualKey: "card", beatId: "b0" }, ...base.slots.map((s) => ({ ...s, startSec: s.startSec + 9 }))], durationSec: 69, speech: [{ startSec: 9.2, endSec: 68.8 }], captions: base.captions.map((c) => ({ ...c, startSec: c.startSec + 9, endSec: c.endSec + 9 })), measured: { ...base.measured, blackIntervals: [{ startSec: 68.4, endSec: 69 }], silenceIntervals: [{ startSec: 0, endSec: 4 }] } };
  const frozen = JSON.stringify(e);
  const r = inspect(e, { now: NOW });
  const plan = planAutoFix(e, r.issues, P);
  const ops = plan.operations.map((o) => o.op);
  for (const op of ["TRIM_BLACK", "SHORTEN_TEXT_CARD", "REMOVE_CAMERA_MOTION", "TRIM_SILENCE"]) assert.ok(ops.includes(op as never), op);
  const once = applyFixPlan(e, plan), twice = applyFixPlan(once, plan);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(e), frozen);
  assert.equal(once.slots[0].durationSec, P.rhythm.maxTextCardSec);
  assert.ok(once.durationSec < e.durationSec);
  const after = inspect(once, { now: NOW });
  assert.ok(!after.issues.some((i) => i.rule === "V_BLACK_FRAMES" || i.rule === "R_TEXT_CARD_MAX" || i.rule === "R_CAMERA_MEANINGFUL"));
});

const snap = (provider: string, o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider, accountLabel: "t", unit: "usd", available: 50, reserved: 0, pending: 0, renewalDate: null, lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });
const adapters: AdapterRegistry = { openai: ({ reserved, pending }) => snap("openai", { reserved, pending }), runway: ({ reserved, pending }) => snap("runway", { reserved, pending }) };

test("SMART_REPAIR cannot spend without authorization; plans are gated by cost, capacity and policy", async () => {
  const slots: EdlSlot[] = []; let t = 0;
  for (let i = 0; i < 9; i++) { slots.push(slot(i, t, 5, i === 0 ? { kind: "stock_video", motion: "live" } : { motion: "static" })); t += 5; }
  const e = cleanEdl({ slots, durationSec: t, speech: [{ startSec: 0, endSec: t }], captions: [] });
  const r = inspect(e, { now: NOW });
  const plans = r.issues.filter((i) => i.repairClass === "SMART_REPAIR").map((i) => proposeRepair(e, i));
  assert.ok(plans.length);
  const run = plans.find((p) => p.rule === "R_STATIC_RUN")!;
  assert.equal(run.proposedRepair, "ANIMATE_STILL"); assert.equal(run.method, "STILL_PARALLAX"); assert.equal(run.estimatedIncrementalUsd, 0, "non-generative motion first");
  let executions = 0;
  const executor = async () => { executions++; return { resultRef: "x", actualUsd: 0 }; };
  await assert.rejects(executeRepair(run, executor), RepairAuthorizationError);
  assert.throws(() => authorizeRepair(run, { repairId: run.repairId, authorizedBy: "producer", reservationId: "res_1", at: NOW }), RepairAuthorizationError, "PROPOSED plans cannot be authorized before the gates");
  const gated = await gateRepairs(plans, { remainingBudgetUsd: 5, adapters, ceilings: { openai: 20, runway: 20 }, now: NOW });
  assert.ok(gated.every((p) => p.status === "GATED_OK"), gated.map((p) => p.gates.reasons.join("|")).join("\n"));
  const gRun = gated.find((p) => p.repairId === run.repairId)!;
  await assert.rejects(executeRepair(gRun, executor), RepairAuthorizationError, "gated is not authorized");
  assert.throws(() => authorizeRepair(gRun, { repairId: "other", authorizedBy: "producer", reservationId: "res_1", at: NOW }), RepairAuthorizationError);
  const authorized = authorizeRepair(gRun, { repairId: gRun.repairId, authorizedBy: "producer", reservationId: "res_1", at: NOW });
  const done = await executeRepair(authorized, executor);
  assert.equal(done.status, "EXECUTED"); assert.equal(executions, 1);
  // A regeneration is blocked by an exhausted budget and by an UNKNOWN provider.
  const regen = proposeRepair(e, { ...r.issues[0], rule: "V_DEFORMED", shotId: "S1", repairClass: "SMART_REPAIR" });
  assert.equal(regen.providerRequired, "openai"); assert.ok(regen.worstCaseUsd > 0);
  const [blocked] = await gateRepairs([regen], { remainingBudgetUsd: 0.01, adapters, ceilings: {}, now: NOW });
  assert.equal(blocked.status, "GATED_BLOCKED"); assert.equal(blocked.gates.cost, "FAIL");
  const [unknown] = await gateRepairs([regen], { remainingBudgetUsd: 5, adapters: { openai: () => snap("openai", { available: null, reliability: "none" }) }, ceilings: {}, now: NOW });
  assert.equal(unknown.status, "GATED_BLOCKED"); assert.equal(unknown.gates.capacity, "NEEDS_OPERATOR");
});

test("ESCALATE: identity/continuity evidence and low confidence stop automatic approval with clear evidence", () => {
  const base = cleanEdl();
  const e = { ...base, slots: base.slots.map((s, i) => (i === 3 ? { ...s, qaFindings: ["FACE_CHANGE"] } : s)) };
  const r = inspect(e, { now: NOW });
  const esc = r.issues.find((i) => i.rule === "V_IDENTITY")!;
  assert.equal(esc.repairClass, "ESCALATE"); assert.equal(esc.shotId, "S3"); assert.deepEqual(esc.evidence, { finding: "FACE_CHANGE", source: "production QA" });
  assert.equal(r.verdict, "HUMAN_REVIEW_REQUIRED");
  assert.equal(planAutoFix(e, r.issues, P).operations.length, 0, "nothing is auto-fixed around an escalation");
  const lowConf = inspect({ ...base, measured: { ...base.measured, blackIntervals: [{ startSec: 10, endSec: 10.5 }] } }, { now: NOW, policy: { ...P, minConfidenceForAutoFix: 0.99, minConfidenceForSmartRepair: 0.99 } });
  assert.equal(lowConf.issues.find((i) => i.rule === "V_BLACK_FRAMES")!.repairClass, "ESCALATE", "confidence below both gates escalates");
});

test("QA gate: invalid editorial transitions are refused; verdict binds the exit; human review needs a recorded decision", () => {
  assert.throws(() => newEditorialRecord("p", "m", "STILL_APPROVED"), IllegalEditorialTransitionError);
  let rec = newEditorialRecord("p", "m-clean", "RENDERED");
  assert.throws(() => editorialTransition(rec, "EDITORIAL_QA_PASS", NOW), IllegalEditorialTransitionError);
  rec = editorialTransition(rec, "EDITORIAL_INSPECTING", NOW);
  assert.throws(() => editorialTransition(rec, "EDITORIAL_QA_PASS", NOW), IllegalEditorialTransitionError, "needs a report");
  const fail = inspect(cleanEdl({ width: 1280, height: 720 }), { now: NOW });
  assert.throws(() => editorialTransition(rec, "EDITORIAL_QA_PASS", NOW, { report: fail }), /does not allow/);
  rec = editorialTransition(rec, "HUMAN_REVIEW_REQUIRED", NOW, { report: fail });
  assert.throws(() => editorialTransition(rec, "EDITORIAL_QA_PASS", NOW), /human decision/);
  rec = editorialTransition(rec, "EDITORIAL_QA_PASS", NOW, { humanOverride: { by: "producer", decision: "accept 720p preview", reason: "preview only" } });
  assert.equal(rec.history[rec.history.length - 1].humanOverride?.by, "producer");
  assert.throws(() => editorialTransition(rec, "EDITORIAL_INSPECTING", NOW), IllegalEditorialTransitionError, "QA_PASS is terminal");
});

test("reinspection: REPAIR mode auto-fixes, reinspects a NEW master id, and the round is recorded; distribution needs EDITORIAL_QA_PASS", async () => {
  const base = cleanEdl();
  const e = { ...base, measured: { ...base.measured, blackIntervals: [{ startSec: 59.5, endSec: 60 }], integratedLufs: -18 } };
  const store = memoryFinalCutStore();
  const run = await runFinalCut(e, { mode: "REPAIR", now: NOW, store, flags: { enabled: true } });
  assert.equal(run.initial.verdict, "REPAIR_REQUIRED"); assert.equal(run.autoFix.applied, true); assert.equal(run.autoFix.afterMasterId, "m-clean-fix1");
  assert.equal(run.autoFix.reinspection!.verdict, "PASS"); assert.equal(run.editorial.state, "EDITORIAL_QA_PASS"); assert.equal(run.editorial.rounds, 2);
  assert.deepEqual(run.editorial.history.map((h) => h.to), ["EDITORIAL_INSPECTING", "EDITORIAL_REPAIR_REQUIRED", "EDITORIAL_REPAIRING", "EDITORIAL_REINSPECTION", "EDITORIAL_INSPECTING", "EDITORIAL_QA_PASS"]);
  assert.equal(run.distribution.eligible, true); assert.equal(run.inputUntouched, true); assert.equal(run.networkCalls, 0);
  assert.equal(store.reports.length, 2); assert.equal(store.fixes[0].beforeMasterId, "m-clean"); assert.equal(store.fixes[0].afterMasterId, "m-clean-fix1"); assert.equal(store.decisions.length, 6); assert.equal(store.metrics.length, 1);
  // Distribution blocked without EDITORIAL_QA_PASS.
  const bad = await runFinalCut(cleanEdl({ width: 1280, height: 720 }), { mode: "REPAIR", now: NOW, flags: { enabled: true } });
  assert.equal(bad.editorial.state, "HUMAN_REVIEW_REQUIRED"); assert.equal(bad.distribution.eligible, false);
  assert.equal(distributionEligible(null, { enabled: true }).eligible, false);
  assert.equal(distributionEligible(null, { enabled: false }).eligible, true, "only an explicit disable bypasses the gate");
});

test("INSPECT_ONLY never modifies the master: EDL fingerprint and media checksum unchanged; SMART_REPAIR plans are proposed, not executed", async () => {
  const base = cleanEdl();
  const e = { ...base, measured: { ...base.measured, blackIntervals: [{ startSec: 59.5, endSec: 60 }] } };
  const frozen = JSON.stringify(e);
  const run = await runFinalCut(e, { mode: "INSPECT_ONLY", now: NOW, repairGates: { remainingBudgetUsd: 5, adapters, ceilings: {} } });
  assert.equal(run.autoFix.applied, false); assert.equal(run.autoFix.reinspection, null); assert.equal(run.editorial.state, "EDITORIAL_REPAIR_REQUIRED");
  assert.equal(run.inputUntouched, true); assert.equal(JSON.stringify(e), frozen);
  assert.ok(run.repairPlans.every((p) => p.status === "GATED_OK" || p.status === "GATED_BLOCKED"));
  // Media path: local ffmpeg only, file bytes untouched, 1 s of black + loudness measured.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-"));
  const file = path.join(dir, "synthetic.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1.0:r=30", "-f", "lavfi", "-i", "testsrc=s=320x180:d=6:r=30", "-f", "lavfi", "-i", "sine=f=440:d=7", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const m = await measureMedia(file);
  assert.deepEqual(m.blackIntervals, [{ startSec: 0, endSec: 1 }]); assert.equal(typeof m.integratedLufs, "number"); assert.equal(m.probe.width, 320);
  assert.ok(m.commands.every((c) => c.endsWith("-f null -")), "every ffmpeg command writes to null");
  const mediaEdl = edlFromMeasurement("m-media", "p-test", file, m);
  const mr = inspect(mediaEdl, { now: NOW });
  assert.ok(mr.issues.some((i) => i.rule === "V_BLACK_FRAMES" && i.startTime === 0));
  assert.ok(mr.issues.some((i) => i.rule === "V_RESOLUTION"), "320x180 is not the profile resolution");
  const merged = mergeMeasurement(cleanEdl(), m, file);
  assert.equal(merged.source.kind, "media+edit_timeline");
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("storyboard adapters map both storyboard families generically (no project-specific rule)", () => {
  const a = edlFromMotionStoryboard({ shots: [{ shotId: "x-s1", beatId: "b1", durationApprox: 5, assetType: "generated_image", motion: "ai-animation", reused: true }, { shotId: "x-s2", beatId: "b1", durationApprox: 6, assetType: "map", motion: "map-graphic" }, { shotId: "x-s3", beatId: "b2", durationApprox: 4, assetType: "documentary_image", motion: "still-push (archival)" }] }, { masterId: "m", productionId: "p", ref: "r" });
  assert.deepEqual(a.slots.map((s) => [s.kind, s.motion, s.startSec]), [["animated_generated_image", "live", 0], ["graphic", "static", 5], ["stock_image", "camera", 11]]);
  const b = edlFromSlotStoryboard({ shots: [{ id: "P-1", src: "N01", sec: 3, start: 0, beat: "p01", origin: "NEW", productionMethod: "i2v_economy" }, { id: "P-2", src: "G1", sec: 2, start: 3, beat: "p01", origin: "NEW", productionMethod: "graphic" }, { id: "P-3", src: "D01", sec: 4, start: 5, beat: "p01", origin: "V1", productionMethod: "v1_recut" }] }, { masterId: "m", productionId: "p", ref: "r" });
  assert.deepEqual(b.slots.map((s) => [s.kind, s.motion]), [["animated_generated_image", "live"], ["graphic", "static"], ["existing_clip", "live"]]);
  assert.deepEqual(b.speech, [], "an estimated narration length is never treated as speech timing");
});

test("paid API calls = 0 in this file", () => { assert.equal(networkCalls, 0); });
