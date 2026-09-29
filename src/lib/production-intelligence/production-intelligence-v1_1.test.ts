/**
 * PI V1.1 CANDIDATE tests (T1-T12). The V1 suite (production-intelligence.test.ts) is untouched
 * and keeps proving V1 behavior; every V1.1 behavior here is reached only through POLICY_V1_1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseShotContract, CONTRACT_VERSION_1_1, isProtectedExistingAsset, type ShotContractInput } from "./contract";
import { PROFILES, PROFILES_V1_1, type ProductionProfile } from "./profiles";
import { POLICY_V1, POLICY_V1_1, type Policy } from "./policy";
import { RATE_CARD_V1 } from "./rate-card";
import { decide, upgradeReasonInvalidity, UPGRADE_REASONS, type DecideInput } from "./decide";
import { planMix, type MixInput, type TimelineSlot } from "./mix";
import { pinProject } from "./pin";
import { isGenerativeVideo } from "./ladder";
import { sb, oceanContract } from "../../../scripts/pi-exam/lib";

const NOW = "2026-09-29T00:00:00.000Z";
const L = PROFILES_V1_1.LONGFORM_16X9;
const pinFor = (policy: Policy = POLICY_V1_1, profile: ProductionProfile = L, contractVersion = "shot-contract/1") =>
  pinProject({ projectId: "proj-v11", policyVersion: policy.policyVersion, profileVersion: profile.profileVersion, contractVersion, rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId: "mem_empty" }, NOW);

const contract = (o: Partial<ShotContractInput> = {}) => parseShotContract({
  shotId: "S1", shotClass: "creature", narrationIntent: "n", visualIntent: "v", motionRequirement: "complex", motionLeverage: "HIGH",
  riskClass: "LOW", desiredDuration: 5, maxGeneratedDuration: 10, qualityTier: "economy", ...o,
});
const input = (o: Partial<DecideInput> = {}): DecideInput => ({
  contract: contract(), profile: L, policy: POLICY_V1_1, rateCard: RATE_CARD_V1, memorySnapshotId: "mem_empty", pin: pinFor(),
  requestedMethod: "I2V_ECONOMY", upgradeReason: "MOTION_ESSENTIAL", attempt: 1, failure: null, stillQa: "PASS",
  budget: { remainingReservedUsd: 10, generativeSecondsRemaining: 60, heroRemaining: 1 }, ...o,
});
const mix = (o: Partial<MixInput> & Pick<MixInput, "contracts">): MixInput => ({
  finishedSeconds: 600, profile: L, policy: POLICY_V1_1, rateCard: RATE_CARD_V1, pin: pinFor(o.policy ?? POLICY_V1_1, o.profile ?? L), memorySnapshotId: "mem_empty", projectBudgetUsd: 40, ...o,
});
const existing = contract({ shotId: "E1", existingApprovedAssetId: "asset-approved-1" });

// ---------- T1-T3: R12 reuse / no repurchase ----------
test("T1: existing + approved + usable -> EXISTING_APPROVED_ASSET even when the mix requests I2V with a valid reason", () => {
  for (const requestedMethod of ["I2V_ECONOMY", "I2V_HERO", "STILL_PARALLAX"] as const) {
    const d = decide(input({ contract: existing, requestedMethod, upgradeReason: requestedMethod === "I2V_HERO" ? "HERO_VALUE" : "MOTION_ESSENTIAL" }));
    assert.equal(d.method, "EXISTING_APPROVED_ASSET", requestedMethod);
    assert.ok(d.reasons.some((r) => r.startsWith("R12")));
  }
  // V1 keeps its (failed) behavior: the baseline stays reproducible.
  const v1 = decide(input({ contract: existing, policy: POLICY_V1, profile: PROFILES.LONGFORM_16X9, pin: pinFor(POLICY_V1, PROFILES.LONGFORM_16X9), upgradeReason: undefined }));
  assert.equal(v1.method, "I2V_ECONOMY");
});

test("T2: reusing an existing approved asset costs zero new generation", () => {
  const d = decide(input({ contract: existing }));
  assert.equal(d.expectedCostUsd, 0); assert.equal(d.maxCostUsd, 0); assert.equal(d.generativeSeconds, 0);
  assert.equal(d.upgradeReason, undefined);
});

test("T3: existing approved assets are excluded from the upgrade pool; only an authorized 1.1 replacement re-enters it", () => {
  const other = contract({ shotId: "H1" });
  const p = planMix(mix({ contracts: [existing, other] }));
  const e = p.shots.find((s) => s.shotId === "E1")!;
  assert.equal(e.method, "EXISTING_APPROVED_ASSET"); assert.equal(e.upgradeRank, null); assert.equal(e.decision.maxCostUsd, 0);
  assert.equal(p.upgradeCandidates, 1);
  // Unusable asset: not protected.
  assert.equal(isProtectedExistingAsset(contract({ existingApprovedAssetId: "a", existingAssetUsable: false })), false);
  // A replacement request without authorization stays protected; with reason + authorization it is a candidate.
  assert.equal(isProtectedExistingAsset(contract({ contractVersion: CONTRACT_VERSION_1_1, existingApprovedAssetId: "a", replacementRequested: true, replacementReason: "wrong location" })), true);
  assert.throws(() => contract({ existingApprovedAssetId: "a", replacementRequested: true, replacementReason: "x", replacementAuthorization: "y" }), /shot-contract\/1.1/);
  const repl = contract({ shotId: "R1", contractVersion: CONTRACT_VERSION_1_1, existingApprovedAssetId: "a", replacementRequested: true, replacementReason: "wrong location", replacementAuthorization: "human:producer" });
  const pr = planMix(mix({ contracts: [repl], pin: pinFor(POLICY_V1_1, L, CONTRACT_VERSION_1_1) }));
  assert.equal(pr.upgradeCandidates, 1);
  assert.equal(pr.shots[0].method, "I2V_ECONOMY");
});

// ---------- T4-T5: budget is a ceiling ----------
const medium = (n: number) => Array.from({ length: n }, (_, k) => contract({ shotId: `M${String(k).padStart(2, "0")}`, shotClass: "object", motionRequirement: "simple", motionLeverage: "MEDIUM", desiredDuration: 3 }));

test("T4: unused generative budget alone never upgrades a shot", () => {
  // No reason -> floor.
  const d = decide(input({ upgradeReason: undefined }));
  assert.equal(d.method, "STILL_KEN_BURNS"); assert.ok(d.reasons.some((r) => r.includes("no upgradeReason")));
  // MEDIUM with MOTION_ESSENTIAL is rejected; LOW is never animated whatever the reason.
  assert.ok(!isGenerativeVideo(decide(input({ contract: contract({ motionLeverage: "MEDIUM" }) })).method));
  assert.ok(!isGenerativeVideo(decide(input({ contract: contract({ motionLeverage: "LOW" }), upgradeReason: "TIMELINE_RHYTHM_NEED" })).method));
  // A MEDIUM-only project with a generous budget and no rhythm problem stays at zero generation.
  const p = planMix(mix({ contracts: medium(4), finishedSeconds: 900 }));
  assert.equal(p.generativeShots, 0); assert.equal(p.upgradeCandidates, 0);
  assert.equal(p.unusedGenerativeSeconds, p.generativeSecondsBudget);
});

const dm = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-mix-contracts.json", "utf8"));
const dt = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-timeline.json", "utf8"));
const dContracts = dm.contracts.map((c: ShotContractInput) => parseShotContract(c));
const dulce = (contracts = dContracts) => planMix(mix({ contracts, finishedSeconds: dm.finishedSeconds, timeline: dt.slots as TimelineSlot[] }));

test("T5: every I2V selection carries a valid upgradeReason, also in reasons[]", () => {
  const p = dulce();
  const gen = p.shots.filter((s) => isGenerativeVideo(s.method));
  assert.ok(gen.length > 0);
  for (const s of gen) {
    const c = dContracts.find((x: { shotId: string }) => x.shotId === s.shotId)!;
    assert.ok(s.decision.upgradeReason && UPGRADE_REASONS.includes(s.decision.upgradeReason), s.shotId);
    assert.equal(upgradeReasonInvalidity(c, s.method, s.decision.upgradeReason), null, s.shotId);
    assert.ok(s.decision.reasons.includes(`upgradeReason: ${s.decision.upgradeReason}`), s.shotId);
  }
});

// ---------- T6-T8, T12: timeline rhythm ----------
const flat = (n: number, secs: number, o: Partial<ShotContractInput> = {}) => Array.from({ length: n }, (_, k) => contract({ shotId: `F${String(k).padStart(2, "0")}`, shotClass: "object", motionRequirement: "camera_only", motionLeverage: "LOW", desiredDuration: secs, ...o }));

test("T6: the static-run detector is deterministic and counts runs exactly", () => {
  // 8 flat stills x 5 s = 40 s > 30 s and 8 > 6 shots: one violating run; a live slot in the middle splits it.
  const cs = flat(8, 5);
  const a = planMix(mix({ contracts: cs })), b = planMix(mix({ contracts: cs }));
  assert.deepEqual(a.rhythm, b.rhythm);
  assert.equal(a.rhythm!.violationsBefore, 1);
  const split: TimelineSlot[] = [...cs.slice(0, 4).map((c) => ({ slotId: c.shotId, shotId: c.shotId, seconds: 5 })), { slotId: "LIVE", shotId: null, seconds: 5, fixed: "live" }, ...cs.slice(4).map((c) => ({ slotId: c.shotId, shotId: c.shotId, seconds: 5 }))];
  const s = planMix(mix({ contracts: cs, timeline: split }));
  assert.equal(s.rhythm!.violationsBefore, 0); assert.equal(s.rhythm!.treatments.length, 0);
});

test("T7: anti-slideshow tries non-generative motion (STILL_PARALLAX) before any I2V", () => {
  const cs = flat(10, 5, { motionLeverage: "MEDIUM", motionRequirement: "simple" });
  const p = planMix(mix({ contracts: cs }));
  assert.ok(p.rhythm!.violationsBefore > 0);
  assert.equal(p.rhythm!.violationsAfter, 0);
  assert.ok(p.rhythm!.treatments.every((t) => !t.generative && t.treatment === "STILL_PARALLAX"));
  assert.equal(p.generativeShots, 0); assert.equal(p.generativeSecondsUsed, 0);
  const treated = p.shots.filter((s) => s.method === "STILL_PARALLAX");
  assert.equal(treated.length, p.rhythm!.treatments.length);
  assert.ok(treated.every((s) => s.decision.maxCostUsd === p.shots.find((x) => x.method === "STILL_KEN_BURNS")!.decision.maxCostUsd), "parallax costs the same as Ken Burns");
});

test("T8: rhythm upgrades respect the global ceiling (profile without parallax)", () => {
  const S = PROFILES_V1_1.SHORT_9X16; // forbids STILL_PARALLAX: rhythm may only use I2V, within the ceiling
  const cs = [...flat(6, 2, { motionLeverage: "MEDIUM", motionRequirement: "simple" }), ...flat(6, 2).map((c, k) => ({ ...c, shotId: `L${k}` }))];
  const p = planMix(mix({ contracts: cs, profile: S, finishedSeconds: 15 }));
  assert.equal(p.generativeSecondsBudget, 5);
  assert.ok(p.generativeSecondsUsed <= p.generativeSecondsBudget);
  const gen = p.shots.filter((s) => isGenerativeVideo(s.method));
  assert.equal(gen.length, 1);
  assert.ok(gen.every((s) => s.decision.upgradeReason === "TIMELINE_RHYTHM_NEED"));
  assert.ok(p.shots.filter((s) => s.shotId.startsWith("L")).every((s) => !isGenerativeVideo(s.method)), "LOW is never generated for rhythm");
  assert.ok(p.rhythm!.unresolved.length > 0, "what the ceiling cannot pay for is reported, not bought");
});

test("T12: same timeline + same snapshot -> same rhythm decisions, independent of contract order", () => {
  const a = dulce(), b = dulce();
  assert.deepEqual(a, b);
  const r = dulce([...dContracts].reverse());
  assert.deepEqual(r.rhythm, a.rhythm);
  const methods = (p: typeof a) => Object.fromEntries(p.shots.map((s) => [s.shotId, s.method]));
  assert.deepEqual(methods(r), methods(a));
});

// ---------- T9-T10: Ocean regressions (same normalization as the V1 exam) ----------
for (const [t, id] of [["T9", "b1-s1"], ["T10", "b1-s4"]] as const) {
  test(`${t}: Ocean ${id} (approved, already paid) is EXISTING_APPROVED_ASSET, USD 0, never a candidate`, () => {
    for (const lev of ["MEDIUM", "HIGH", "LOW"] as const) {
      const contracts = sb.shots.map((s) => oceanContract(s, lev));
      const p = planMix(mix({ contracts, finishedSeconds: 659.343, projectBudgetUsd: 17.65 }));
      const s = p.shots.find((x) => x.shotId === id)!;
      assert.equal(s.method, "EXISTING_APPROVED_ASSET", `${id} ${lev}`);
      assert.equal(s.decision.expectedCostUsd, 0); assert.equal(s.decision.maxCostUsd, 0);
      assert.equal(s.upgradeRank, null);
    }
  });
}

// ---------- T11 ----------
test("T11: DULCE produces 0 unjustified generative upgrades", () => {
  const p = dulce();
  const unjustified = p.shots.filter((s) => isGenerativeVideo(s.method) && upgradeReasonInvalidity(dContracts.find((c: { shotId: string }) => c.shotId === s.shotId)!, s.method, s.decision.upgradeReason) !== null);
  assert.deepEqual(unjustified.map((s) => s.shotId), []);
  assert.ok(p.generativeSecondsUsed <= p.generativeSecondsBudget);
});

test("V1 plans carry no V1.1 fields (baseline shape unchanged)", () => {
  const p = planMix(mix({ contracts: dContracts, finishedSeconds: dm.finishedSeconds, policy: POLICY_V1, profile: PROFILES.LONGFORM_16X9 }));
  assert.equal("rhythm" in p, false); assert.equal("unusedGenerativeSeconds" in p, false);
});
