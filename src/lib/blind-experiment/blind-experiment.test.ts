/**
 * Blind Project #001 harness tests (T1-T12). All data here is SYNTHETIC: no Iron Annals
 * material exists yet (EPISODE_TOPIC = PENDING) and PI V1.1 never sees a real project here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HumanBaselineSchema, ANSWER_FIELDS, type HumanBaselineInput, type HumanShot } from "./schema";
import { sha256, sealBaseline, verifySeal, amend, verifyAmendments, effectiveBaseline, BaselineTamperedError, SealError, type SealedBaseline } from "./seal";
import { runShadowGated, buildShadowInput, projectInputs, toPiContract, assertNoLeak, ShadowGateError, ShadowLeakError, ShadowNetworkError, type Protocol } from "./shadow-gate";
import { checkConstitution } from "./constitution";
import { evaluate, overlap } from "./evaluate";
import { floorMethod } from "../production-intelligence/decide";
import { parseShotContract } from "../production-intelligence/contract";
import { planMix, type MixInput } from "../production-intelligence/mix";
import { PROFILES_V1_1 } from "../production-intelligence/profiles";

const protocol = JSON.parse(fs.readFileSync("content/blind-projects/iron-annals-001/protocol.json", "utf8")) as Protocol;
const NOW = "2026-09-29T00:00:00.000Z";
const SHA = "29c185c0000000000000000000000000000000aa";
const H = (n: number) => n.toString(16).padStart(64, "0");
const REASON = "SENTINEL-HUMAN-REASON-";

function shot(k: number, o: Partial<HumanShot> = {}): HumanShot {
  return {
    shotId: `S${String(k).padStart(3, "0")}`, timelineOrder: k, duration: 5, narrationIntent: `line ${k}`, visualIntent: `visual ${k}`,
    shotClass: "object", sourceType: "AI_STILL", characters: [], identityCritical: false, multiHuman: false, complexHands: false,
    motionRequirement: "camera_only", motionLeverage: "LOW", riskClass: "LOW", qualityTier: "economy",
    existingAsset: null, existingAssetApproved: false, existingAssetKind: null, continuityGroup: null, previousState: null, nextState: null,
    motionJudgment: "MOTION_UNNECESSARY", humanPreferredMethod: "STILL_KEN_BURNS", humanWouldGenerateVideo: false, humanReason: `${REASON}${k} camera push carries it`,
    adequateMethods: ["STILL_KEN_BURNS", "STILL_PARALLAX"], cheaperMethodSufficient: true, generationRiskUnacceptable: false, i2vPlan: null, ...o,
  };
}
const i2v = (k: number, o: Partial<HumanShot> = {}) => shot(k, { shotClass: "creature", motionRequirement: "complex", motionLeverage: "HIGH", motionJudgment: "MOTION_ESSENTIAL", humanPreferredMethod: "I2V_ECONOMY", humanWouldGenerateVideo: true, adequateMethods: ["I2V_ECONOMY", "I2V_HERO"], cheaperMethodSufficient: false, i2vPlan: { why: `WHY-SENTINEL-${k} the charge must move`, durationSeconds: 5, expectedProvider: "runway:gen4_turbo", estimatedCostUsd: 0.35 }, ...o });

function baseline(shots: HumanShot[] = [...Array.from({ length: 28 }, (_, k) => shot(k + 3)), i2v(0), i2v(1), i2v(2), shot(31, { sourceType: "STOCK_VIDEO", motionRequirement: "simple" })]): HumanBaselineInput {
  return { projectId: "iron-annals-001-synthetic", protocolVersion: protocol.protocolVersion, episodeTopic: "SYNTHETIC_TEST_TOPIC", finishedSeconds: 600, productionBudgetUsd: 40,
    documents: { research: { path: "r.md", sha256: H(1) }, script: { path: "s.md", sha256: H(2) }, storyboard: { path: "b.json", sha256: H(3) } }, shots };
}
const seal = (b = baseline()) => sealBaseline(b, { protocol, commitSha: SHA, sealedAt: NOW });
const spyPlanner = () => { const calls: MixInput[] = []; return { calls, planner: (i: MixInput) => { calls.push(i); return planMix(i); } }; };

test("T1: PI cannot run before HUMAN_BASELINE_SEALED", () => {
  const spy = spyPlanner();
  for (const sealed of [null, undefined, { ...seal(), HUMAN_BASELINE_SEALED: false } as unknown as SealedBaseline]) {
    assert.throws(() => runShadowGated({ sealed, protocol, ranAt: NOW, planner: spy.planner }), ShadowGateError);
  }
  // Unsealed raw baseline data is not a sealed baseline either.
  assert.throws(() => runShadowGated({ sealed: baseline() as unknown as SealedBaseline, protocol, ranAt: NOW, planner: spy.planner }), ShadowGateError);
  // A protocol edited after the seal (moving goalposts) or a different engine tree is refused.
  assert.throws(() => runShadowGated({ sealed: seal(), protocol: { ...protocol, verdict: {} }, ranAt: NOW, planner: spy.planner }), /protocol changed/);
  assert.throws(() => runShadowGated({ sealed: seal(), protocol, ranAt: NOW, engineTreeSha256: "f".repeat(64), planner: spy.planner }), /engine tree/);
  assert.equal(spy.calls.length, 0, "PI was never invoked");
  // The real episode is PENDING: no baseline can even be sealed for it.
  assert.equal(HumanBaselineSchema.safeParse({ ...baseline(), episodeTopic: "PENDING" }).success, false);
  assert.throws(() => sealBaseline({ ...baseline(), shots: [shot(0, { motionJudgment: "UNKNOWN" as never })] }, { protocol, commitSha: SHA, sealedAt: NOW }), SealError);
});

test("T2: the seal produces deterministic content hashes (order- and key-order-independent)", () => {
  const a = seal(), b = seal();
  assert.deepEqual(a, b);
  const shuffled = baseline(); shuffled.shots = [...shuffled.shots].reverse().map((s) => Object.fromEntries(Object.entries(s).reverse()) as HumanShot);
  const c = seal(shuffled);
  assert.equal(c.sealHash, a.sealHash); assert.deepEqual(c.contentHashes, a.contentHashes);
  assert.equal(a.summary.plannedGenerativeClips, 3); assert.equal(a.summary.plannedGenerativeSeconds, 15); assert.equal(a.summary.plannedGenerativeSecondsPerMinute, 1.5); assert.equal(a.summary.expectedCostUsd, 1.05);
  assert.match(a.contentHashes.humanAnswers, /^[0-9a-f]{64}$/);
});

test("T3: human answers cannot be modified silently after the seal", () => {
  const s = seal();
  assert.throws(() => { (s.baseline.shots[0] as { humanReason: string }).humanReason = "changed"; }, TypeError, "sealed object is frozen");
  for (const field of ["humanReason", "humanPreferredMethod", "motionJudgment", "adequateMethods"] as const) {
    const edited = JSON.parse(JSON.stringify(s)) as SealedBaseline;
    (edited.baseline.shots[5] as Record<string, unknown>)[field] = field === "adequateMethods" ? ["I2V_HERO"] : field === "humanPreferredMethod" ? "I2V_HERO" : field === "motionJudgment" ? "MOTION_ESSENTIAL" : "closer to PI";
    assert.throws(() => verifySeal(edited), BaselineTamperedError, field);
    assert.throws(() => runShadowGated({ sealed: edited, protocol, ranAt: NOW }), BaselineTamperedError);
  }
});

test("T4: an amendment preserves the original baseline", () => {
  const s = seal();
  const log = amend(s, [], { shotId: "S010", field: "visualIntent", to: "corrected: bronze, not iron, helmets", reason: "factual correction (source X)", author: "producer", at: NOW });
  const log2 = amend(s, log, { shotId: "S010", field: "humanReason", to: "rewritten", reason: "typo", author: "producer", at: NOW });
  verifySeal(s); verifyAmendments(s, log2);
  assert.equal(s.baseline.shots.find((x) => x.shotId === "S010")!.visualIntent, "visual 10");
  assert.equal(effectiveBaseline(s, log2).shots.find((x) => x.shotId === "S010")!.visualIntent, "corrected: bronze, not iron, helmets");
  assert.equal(log2[0].from, "visual 10"); assert.equal(log2[1].prevHash, log2[0].hash);
  const broken = JSON.parse(JSON.stringify(log2)); broken[0].to = "something else";
  assert.throws(() => verifyAmendments(s, broken), BaselineTamperedError);
  const shadow = runShadowGated({ sealed: s, protocol, ranAt: NOW });
  const r = evaluate({ sealed: s, protocol, shadow, constitutionViolations: [], amendments: log2 });
  assert.equal(r.scoredAgainst, "original sealed baseline"); assert.equal(r.amendments.length, 2);
});

test("T5: STOCK_PHOTO is a still, STOCK_VIDEO is motion", () => {
  const P = PROFILES_V1_1.LONGFORM_16X9;
  const photo = parseShotContract(toPiContract(projectInputs(shot(1, { sourceType: "STOCK_PHOTO" })), 10));
  const video = parseShotContract(toPiContract(projectInputs(shot(1, { sourceType: "STOCK_VIDEO" })), 10));
  const archival = parseShotContract(toPiContract(projectInputs(shot(1, { sourceType: "ARCHIVAL_PHOTO" })), 10));
  assert.equal(photo.stockAvailable, false); assert.equal(archival.stockAvailable, false); assert.equal(video.stockAvailable, true);
  assert.equal(floorMethod(video, P).method, "STOCK");
  assert.equal(floorMethod(photo, P).method, "STILL_KEN_BURNS");
});

for (const [t, field] of [["T6", "humanPreferredMethod"], ["T7", "humanWouldGenerateVideo"], ["T8", "humanReason"]] as const) {
  test(`${t}: PI shadow input excludes ${field}`, () => {
    const s = seal();
    const spy = spyPlanner();
    runShadowGated({ sealed: s, protocol, ranAt: NOW, planner: spy.planner });
    assert.equal(spy.calls.length, 2);
    const seen = new Set<string>();
    const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { seen.add(k); walk(x); } };
    walk(spy.calls[0]);
    assert.equal(seen.has(field), false);
    for (const k of ANSWER_FIELDS) assert.equal(seen.has(k), false, k);
    const text = JSON.stringify(spy.calls[0]);
    assert.ok(!text.includes(REASON) && !text.includes("WHY-SENTINEL"), "no human free-text answer reached PI");
    // The detector itself works: a leaked answer is refused.
    const leaky = buildShadowInput(s, protocol, "p", NOW);
    (leaky.contracts[0] as Record<string, unknown>)[field] = s.baseline.shots[0][field];
    assert.throws(() => assertNoLeak(leaky, s), ShadowLeakError);
  });
}

test("T9: comparison metrics calculate correctly", () => {
  const o = overlap(["a", "b", "c"], ["b", "c", "d", "e"]);
  assert.deepEqual(o, { intersection: ["b", "c"], piOnly: ["a"], humanOnly: ["d", "e"], precision: 0.6667, recall: 0.5, jaccard: 0.4 });
  assert.deepEqual(overlap([], []), { intersection: [], piOnly: [], humanOnly: [], precision: 1, recall: 1, jaccard: 1 });
  const s = seal();
  const shadow = runShadowGated({ sealed: s, protocol, ranAt: NOW });
  const r = evaluate({ sealed: s, protocol, shadow, constitutionViolations: [] });
  assert.deepEqual(r.metrics.HUMAN_SELECTED, ["S000", "S001", "S002"]);
  assert.equal(r.metrics.human.generatedSeconds, 15); assert.equal(r.metrics.human.perMinute, 1.5); assert.equal(r.metrics.human.expectedCostUsd, 1.05);
  assert.equal(r.metrics.pi.generatedSeconds, shadow.plan.generativeSecondsUsed);
  assert.equal(r.metrics.pi.perMinute, Math.round((shadow.plan.generativeSecondsUsed / 10) * 1e4) / 1e4);
  assert.equal(r.metrics.pi.worstCaseReservedUsd, shadow.plan.worstCaseUsd);
  assert.equal(r.metrics.precision, overlap(r.metrics.PI_SELECTED, r.metrics.HUMAN_SELECTED).precision);
});

test("T10: a cheaper valid alternative is not automatically a false negative", () => {
  // Human would generate; PI reaches the same claim with parallax (landscape floor) at lower cost.
  const alt = i2v(0, { shotClass: "landscape", motionRequirement: "simple", motionLeverage: "MEDIUM", adequateMethods: ["I2V_ECONOMY", "STILL_PARALLAX"] });
  const s = seal(baseline([...Array.from({ length: 28 }, (_, k) => shot(k + 3)), alt, i2v(1), i2v(2), shot(31)]));
  const shadow = runShadowGated({ sealed: s, protocol, ranAt: NOW });
  const r = evaluate({ sealed: s, protocol, shadow, constitutionViolations: [] });
  const row = r.perShot.find((x) => x.shotId === "S000")!;
  assert.equal(row.piMethod, "STILL_PARALLAX");
  assert.deepEqual(row.labels, ["ALTERNATIVE_GOOD_DECISION"]);
  assert.equal(r.metrics.QUALITY_FALSE_NEGATIVE, 0);
  // Without parallax in adequateMethods the same PI choice IS a quality false negative.
  const s2 = seal(baseline([...Array.from({ length: 28 }, (_, k) => shot(k + 3)), { ...alt, adequateMethods: ["I2V_ECONOMY"] }, i2v(1), i2v(2), shot(31)]));
  const r2 = evaluate({ sealed: s2, protocol, shadow: runShadowGated({ sealed: s2, protocol, ranAt: NOW }), constitutionViolations: [] });
  assert.deepEqual(r2.perShot.find((x) => x.shotId === "S000")!.labels, ["QUALITY_FALSE_NEGATIVE"]);
});

test("T11: a constitutional violation forces FAIL", () => {
  const s = seal();
  const shadow = runShadowGated({ sealed: s, protocol, ranAt: NOW });
  const clean = evaluate({ sealed: s, protocol, shadow, constitutionViolations: checkConstitution(buildShadowInput(s, protocol, s.baseline.projectId, NOW), shadow.plan, shadow.networkCalls, NOW) });
  assert.notEqual(clean.verdict, "FAIL", clean.fail.join("; "));
  const bad = evaluate({ sealed: s, protocol, shadow, constitutionViolations: ["C7 90 > 80"] });
  assert.equal(bad.verdict, "FAIL"); assert.match(bad.fail[0], /constitutional/);
});

test("T12: shadow cannot call a provider", async () => {
  const s = seal();
  const before = globalThis.fetch;
  const caller = (i: MixInput) => { void fetch("https://api.dev.runwayml.com/v1/image_to_video").catch(() => undefined); return planMix(i); };
  const r = runShadowGated({ sealed: s, protocol, ranAt: NOW, planner: caller });
  assert.equal(r.networkCalls, 2);
  assert.equal(evaluate({ sealed: s, protocol, shadow: r, constitutionViolations: [] }).verdict, "FAIL");
  const thrower = () => { throw new Error("provider down"); };
  const throwing = (i: MixInput) => { void fetch("https://api.openai.com").catch(() => undefined); thrower(); return planMix(i); };
  assert.throws(() => runShadowGated({ sealed: s, protocol, ranAt: NOW, planner: throwing }), ShadowNetworkError);
  assert.equal(globalThis.fetch, before, "fetch restored after the shadow run");
  assert.equal(runShadowGated({ sealed: s, protocol, ranAt: NOW }).networkCalls, 0, "PI V1.1 itself makes no calls");
});

test("harness end-to-end on synthetic data: deterministic, constitution clean, pre-registered verdict", () => {
  const s = seal();
  const shadow = runShadowGated({ sealed: s, protocol, ranAt: NOW });
  assert.equal(shadow.deterministic, true); assert.equal(shadow.networkCalls, 0);
  const v = checkConstitution(buildShadowInput(s, protocol, s.baseline.projectId, NOW), shadow.plan, 0, NOW);
  assert.deepEqual(v, []);
  const r = evaluate({ sealed: s, protocol, shadow, constitutionViolations: v, finalTruth: s.baseline.shots.map((x) => ({ shotId: x.shotId, finalUsedMethod: x.shotId === "S031" ? "UNKNOWN" : x.humanPreferredMethod, userKept: true })) });
  assert.equal(r.stage, "FINAL"); assert.ok(["PASS", "INCONCLUSIVE"].includes(r.verdict), r.fail.join("; "));
  assert.equal((r.final as { unknownShots: string[] }).unknownShots.length, 1);
});

test("pre-registration lock: protocol.json matches PROTOCOL-LOCK.json and the episode stays PENDING", () => {
  const lock = JSON.parse(fs.readFileSync("content/blind-projects/iron-annals-001/PROTOCOL-LOCK.json", "utf8"));
  const state = JSON.parse(fs.readFileSync("content/blind-projects/iron-annals-001/state.json", "utf8"));
  assert.equal(sha256(protocol), lock.protocolSha256, "protocol.json was edited after pre-registration");
  assert.equal(protocol.subject.engineTreeSha256, "fb24a4026e29815b9c8a2071e2db474d3d399adb50c933e276f1480f05a2cbef");
  assert.equal(state.episodeTopic, "PENDING"); assert.equal(state.HUMAN_BASELINE_SEALED, false); assert.equal(state.piShadowRuns, 0);
});
