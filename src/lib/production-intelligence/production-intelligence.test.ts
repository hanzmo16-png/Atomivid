import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseShotContract, type ShotContractInput } from "./contract";
import { PROFILES } from "./profiles";
import { POLICY_V1, promotePolicy, activePolicy, PolicyRegistryError, type Policy, type PolicyRegistry } from "./policy";
import { RATE_CARD_V1 } from "./rate-card";
import { RUNWAY_COST_USD_PER_SECOND } from "../providers/video-gen/runway";
import { decide, type DecideInput } from "./decide";
import { planMix } from "./mix";
import { pinProject, SnapshotMismatchError } from "./pin";
import { reserveProject, settleProject, assertWithinReservation, HardCapError } from "./budget";
import { newAsset, transition, IllegalTransitionError, wouldSpend } from "./state-machine";
import { executePaidOperation, idempotencyKey, memoryLedgerStore, ReconciliationRequiredError } from "./ledger";
import { assessCapacity, admit, forecastDepletion, type CapacitySnapshot } from "./capacity/capacity";
import { elevenLabsSnapshot, openAiSnapshot, runwaySnapshot } from "./capacity/adapters";
import { PROVIDER_ACCOUNTS, containsSecretValue } from "./capacity/accounts";
import { memorySink, assertNoSecrets, TelemetrySecretError, type AttemptEvent } from "./telemetry";
import { buildMemorySnapshot, promotionGate } from "./memory";
import { runShadow } from "./shadow";
import { auditUnusedPaidAssets, gateFinding, gateMaster, type QaFinding } from "./qa-gate";

const NOW = "2026-09-29T00:00:00.000Z";
const P = PROFILES.LONGFORM_16X9;
const pinFor = (policy: Policy = POLICY_V1, memorySnapshotId = "mem_empty", profile = P) =>
  pinProject({ projectId: "proj-1", policyVersion: policy.policyVersion, profileVersion: profile.profileVersion, contractVersion: "shot-contract/1", rateCardVersion: RATE_CARD_V1.rateCardVersion, memorySnapshotId }, NOW);

const contract = (o: Partial<ShotContractInput> = {}) => parseShotContract({
  shotId: "S1", shotClass: "creature", narrationIntent: "n", visualIntent: "v", motionRequirement: "complex", motionLeverage: "HIGH",
  riskClass: "LOW", desiredDuration: 5, maxGeneratedDuration: 10, qualityTier: "economy", ...o,
});
const input = (o: Partial<DecideInput> = {}): DecideInput => ({
  contract: contract(), profile: P, policy: POLICY_V1, rateCard: RATE_CARD_V1, memorySnapshotId: "mem_empty", pin: pinFor(),
  requestedMethod: "I2V_ECONOMY", attempt: 1, failure: null, stillQa: "PASS",
  budget: { remainingReservedUsd: 10, generativeSecondsRemaining: 60, heroRemaining: 1 }, ...o,
});

// ---------- 1. worst case never exceeds reserved budget ----------
test("1: reservation holds the worst case; a plan whose worst case exceeds the budget is rejected", () => {
  const r = reserveProject("p", { expectedCostUsd: 2.8, worstCaseUsd: 4.1 }, 5);
  assert.equal(r.status, "RESERVED"); assert.equal(r.reservedUsd, 4.1);
  assert.equal(settleProject(r, 2.8).releasedUsd, 1.3);
  assert.equal(reserveProject("p", { expectedCostUsd: 2.8, worstCaseUsd: 4.1 }, 4).status, "REJECTED");
  assert.throws(() => assertWithinReservation(r, 4.0, 0.25), HardCapError);
  const d = decide(input({ budget: { remainingReservedUsd: 0.2, generativeSecondsRemaining: 60, heroRemaining: 1 } }));
  assert.ok(d.maxCostUsd <= 0.2, "decide never authorizes more than the remaining reservation");
});

// ---------- 2. failed still cannot reach motion ----------
test("2: a still that fails QA has no legal path to motion (decide + state machine)", () => {
  const d = decide(input({ stillQa: "FAIL" }));
  assert.equal(d.method, "AI_STILL"); assert.ok(d.reasons.some((r) => r.startsWith("R03")));
  let a = newAsset("S1");
  for (const s of ["STILL_PENDING", "STILL_READY", "STILL_QA"] as const) a = transition(a, s, NOW);
  assert.throws(() => transition(a, "STILL_APPROVED", NOW, { qa: [{ executor: "faces", pass: false, findings: ["EXTRA_LIMB"] }] }), IllegalTransitionError);
  a = transition(a, "STILL_FAILED", NOW, { qa: [{ executor: "faces", pass: false, findings: ["EXTRA_LIMB"] }] });
  assert.throws(() => transition(a, "MOTION_AUTHORIZED", NOW, { decisionHash: "x" }), IllegalTransitionError);
  assert.throws(() => transition(a, "MOTION_PENDING", NOW), IllegalTransitionError);
  const c = transition(a, "CANCELLED", NOW);
  assert.equal(wouldSpend(c, "STILL_PENDING"), false, "cancelled assets can never create new spend");
});

// ---------- 3. multi_human + economy ----------
test("3: multi_human + economy never selects generative video", () => {
  const d = decide(input({ contract: contract({ shotClass: "multi_human", motionLeverage: "HIGH" }) }));
  assert.ok(!d.method.startsWith("I2V")); assert.ok(d.reasons.some((r) => r.includes("R01")));
});

// ---------- 4/5. global mix on the real DULCE candidates ----------
const mixFixture = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-mix-contracts.json", "utf8"));
const dulceContracts = mixFixture.contracts.map((c: ShotContractInput) => parseShotContract(c));
const dulcePlan = () => planMix({ contracts: dulceContracts, finishedSeconds: mixFixture.finishedSeconds, profile: P, policy: POLICY_V1, rateCard: RATE_CARD_V1, pin: pinFor(), memorySnapshotId: "mem_empty", projectBudgetUsd: 40 });

test("4: the Mix Engine respects the global generative-seconds budget", () => {
  const plan = dulcePlan();
  assert.ok(plan.generativeSecondsUsed <= plan.generativeSecondsBudget, `${plan.generativeSecondsUsed} <= ${plan.generativeSecondsBudget}`);
  assert.ok(plan.heroShots <= P.heroQuota);
});

test("5: DULCE-like timeline does not regress to 'animate every shot that could move'", () => {
  const plan = dulcePlan();
  assert.equal(dulceContracts.length, 44);
  assert.ok(plan.upgradeCandidates > plan.generativeShots, "some animatable candidates stay economical");
  assert.ok(plan.generativeShots <= 16 && plan.generativeShots >= 4, `generative shots ${plan.generativeShots} is near Smart Mix B+ (13), far from 44`);
  for (const s of plan.shots) {
    const c = dulceContracts.find((x: { shotId: string }) => x.shotId === s.shotId);
    if (c.motionLeverage === "LOW") assert.ok(!s.method.startsWith("I2V"), `${s.shotId} LOW leverage stays still-motion`);
    if (c.shotClass === "multi_human") assert.ok(!s.method.startsWith("I2V"), `${s.shotId} multi_human protected`);
    assert.ok(s.reasons.length > 0);
  }
  // Essential motion (HIGH + complex) is served first unless a general risk rule protects it.
  const ranked = plan.shots.filter((s) => s.upgradeRank !== null).sort((a, b) => a.upgradeRank! - b.upgradeRank!);
  assert.equal(dulceContracts.find((x: { shotId: string }) => x.shotId === ranked[0].shotId).motionLeverage, "HIGH");
  assert.ok(plan.worstCaseUsd <= 40);
});

// ---------- 6. determinism ----------
test("6: same inputs + same snapshot + same policy -> identical decision", () => {
  const a = decide(input()), b = decide(input());
  assert.deepEqual(a, b); assert.equal(a.decisionHash, b.decisionHash);
  assert.deepEqual(dulcePlan(), dulcePlan());
});

// ---------- 7. semantic failure ----------
test("7: a semantic failure never repeats the identical paid attempt", () => {
  const first = decide(input({ contract: contract({ motionLeverage: "HIGH" }), failure: { kind: "semantic", method: "I2V_ECONOMY", variant: "standard" } }));
  assert.ok(first.method !== "I2V_ECONOMY" || first.variant !== "standard");
  assert.equal(first.variant, "simplified", "HIGH leverage gets one materially different attempt");
  const second = decide(input({ failure: { kind: "semantic", method: "I2V_ECONOMY", variant: "simplified" } }));
  assert.ok(!second.method.startsWith("I2V"), "second semantic failure downgrades to still-motion");
  const medium = decide(input({ contract: contract({ motionLeverage: "MEDIUM", motionRequirement: "simple" }), failure: { kind: "semantic", method: "I2V_ECONOMY", variant: "standard" } }));
  assert.ok(!medium.method.startsWith("I2V")); assert.ok(medium.reasons.some((r) => r.startsWith("R08")));
  const noOutput = decide(input({ failure: { kind: "provider_no_output", method: "I2V_ECONOMY", variant: "standard" } }));
  assert.ok(!noOutput.method.startsWith("I2V"), "provider returned no video: not repeated (DULCE N20)");
});

// ---------- 8. transport retry keeps idempotency ----------
test("8: transport retry keeps the idempotency key and never double charges", async () => {
  const d = decide(input({ failure: { kind: "transport", method: "I2V_ECONOMY", variant: "standard", infrastructureRetriesUsed: 0 } }));
  assert.equal(d.attemptKind, "infrastructure_retry"); assert.equal(d.method, "I2V_ECONOMY");
  const d2 = decide(input({ failure: { kind: "transport", method: "I2V_ECONOMY", variant: "standard", infrastructureRetriesUsed: 1 } }));
  assert.ok(!d2.method.startsWith("I2V"));
  const store = memoryLedgerStore();
  const key = idempotencyKey({ projectId: "p", shotId: "S1", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", inputFingerprint: "img-sha", attemptOrdinal: 1 });
  assert.equal(key, idempotencyKey({ attemptOrdinal: 1, inputFingerprint: "img-sha", method: "I2V_ECONOMY", model: "gen4_turbo", provider: "runway", shotId: "S1", projectId: "p" }));
  let submits = 0, polls = 0;
  const op = { idempotencyKey: key, projectId: "p", shotId: "S1", provider: "runway", model: "gen4_turbo", method: "I2V_ECONOMY", attemptKind: "initial", reservedUsd: 0.25 };
  // Worker dies after the provider accepted the job (poll throws once).
  const crashing = { submit: async () => { submits++; return { providerJobId: "job-1" }; }, poll: async () => { polls++; throw new Error("worker died"); } };
  await assert.rejects(executePaidOperation(store, op, crashing, () => NOW));
  const retry = { submit: async () => { submits++; return { providerJobId: "job-2" }; }, poll: async (id: string) => { polls++; assert.equal(id, "job-1"); return { resultRef: "clip.mp4", actualUsd: 0.25 }; } };
  const done = await executePaidOperation(store, op, retry, () => NOW);
  assert.equal(submits, 1, "resumed the accepted job instead of submitting again");
  assert.equal(polls, 2, "the accepted job was polled again after the crash");
  assert.equal(done.status, "COMMITTED");
  const again = await executePaidOperation(store, op, retry, () => NOW);
  assert.equal(submits, 1); assert.equal(again.status, "COMMITTED");
  // A submission without a recorded job id is never resubmitted automatically.
  const s2 = memoryLedgerStore();
  const k2 = { ...op, idempotencyKey: "op_x" };
  await assert.rejects(executePaidOperation(s2, k2, { submit: async () => { throw new Error("socket closed"); }, poll: async () => ({ resultRef: "", actualUsd: 0 }) }, () => NOW));
  await assert.rejects(executePaidOperation(s2, k2, retry, () => NOW), ReconciliationRequiredError);
  await assert.rejects(executePaidOperation(s2, k2, retry, () => NOW), ReconciliationRequiredError);
});

// ---------- 9. shadow never spends ----------
test("9: Shadow Mode never calls providers nor writes a ledger", () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network forbidden in shadow"); }) as typeof fetch;
  try {
    const shadow: Policy = { ...POLICY_V1, policyVersion: "policy/1.1.0-shadow", status: "SHADOW", params: { ...POLICY_V1.params, minUpgradeLeverage: "HIGH" } };
    const cmp = runShadow(input(), shadow);
    assert.equal(calls, 0);
    assert.ok(cmp.activeDecision.versions.policyVersion !== cmp.shadowDecision.versions.policyVersion);
    assert.equal(typeof cmp.estimatedDelta.maxCostUsd, "number");
    assert.throws(() => runShadow(input(), POLICY_V1), /not SHADOW/);
  } finally { globalThis.fetch = origFetch; }
});

// ---------- 10. model versions never mix ----------
const attempt = (o: Partial<AttemptEvent>): AttemptEvent => ({
  type: "attempt", eventId: "e" + Math.random().toString(36).slice(2), attemptId: "a1", projectId: "p", shotId: "S1", contractVersion: "shot-contract/1", profileVersion: P.profileVersion,
  policyVersion: POLICY_V1.policyVersion, memorySnapshotId: "mem_empty", rateCardVersion: RATE_CARD_V1.rateCardVersion, provider: "runway", model: "gen4_turbo", modelVersion: "2026-01",
  productionMethod: "I2V_ECONOMY", shotClass: "creature", generatedSeconds: 5, acceptedSeconds: 5, costUsd: 0.25, latencySeconds: 60, attempt: 1, technicalPass: true, visualQaPass: true,
  failureReason: null, fallback: null, humanIntervention: "none", checksum: "a".repeat(64), timestamp: "2026-09-20T00:00:00.000Z", ...o,
});
test("10: a new model version never inherits another version's statistics", () => {
  const snap = buildMemorySnapshot([attempt({ modelVersion: "2026-01" }), attempt({ modelVersion: "2026-01" }), attempt({ modelVersion: "2026-09", visualQaPass: false })], NOW);
  const cells = Object.values(snap.cells);
  assert.equal(cells.length, 2);
  const newer = cells.find((c) => c.modelVersion === "2026-09")!;
  assert.equal(newer.n, 1); assert.equal(newer.visualPassRate, 0);
  const unknown = buildMemorySnapshot([attempt({ modelVersion: "unknown" })], NOW);
  assert.equal(Object.values(unknown.cells)[0].modelVersionKnown, false);
  assert.equal(promotionGate(newer, 5, { costPerAcceptedSecondDelta: -0.5, keepRateDelta: 0 }).eligible, false);
});

// ---------- 11. a project cannot modify global policy ----------
test("11: a project or tenant cannot change global policy; promotion is explicit", () => {
  const reg: PolicyRegistry = { policies: [POLICY_V1, { ...POLICY_V1, policyVersion: "policy/1.1.0", status: "CANDIDATE" }], history: [] };
  assert.throws(() => promotePolicy(reg, "policy/1.1.0", "SHADOW", { scope: "project", id: "proj-1" }, "cheaper", NOW), PolicyRegistryError);
  assert.throws(() => promotePolicy(reg, "policy/1.1.0", "ACTIVE", { scope: "global-operator", id: "ops" }, "skip", NOW), /Illegal/);
  const s = promotePolicy(reg, "policy/1.1.0", "SHADOW", { scope: "global-operator", id: "ops" }, "shadow first", NOW);
  const a = promotePolicy(s, "policy/1.1.0", "ACTIVE", { scope: "global-operator", id: "ops" }, "gate met", NOW);
  assert.equal(activePolicy(a).policyVersion, "policy/1.1.0");
  assert.equal(a.policies.find((p) => p.policyVersion === POLICY_V1.policyVersion)!.status, "RETIRED");
  assert.equal(POLICY_V1.status, "ACTIVE", "the registry is immutable data; nothing mutated in place");
});

// ---------- 12. R11 unused paid approved asset ----------
test("12: a paid, approved, intended asset missing from the master fails QA (R11)", () => {
  const intended = [{ assetId: "N01", paid: true, approved: true, intendedForMaster: true, kind: "clip" as const }, { assetId: "N43", paid: true, approved: false, intendedForMaster: true, kind: "clip" as const }];
  const findings = auditUnusedPaidAssets(intended, [{ slotId: "P1-001", assetId: "N01", kind: "still" }]);
  assert.equal(findings.length, 1);
  assert.equal(gateMaster(findings).pass, false);
  assert.equal(auditUnusedPaidAssets(intended, [{ slotId: "P1-001", assetId: "N01", kind: "clip" }]).length, 0);
});

// ---------- 13/14/15. capacity ----------
const snap = (o: Partial<CapacitySnapshot> = {}): CapacitySnapshot => ({ provider: "elevenlabs", accountLabel: "x", unit: "character", available: 30000, reserved: 24000, pending: 0, renewalDate: "2026-10-15", lastCheckedAt: NOW, health: "OK", reliability: "provider_api", ...o });
test("13: reserved capacity reduces free capacity (balance != free)", () => {
  assert.equal(assessCapacity(snap()).free, 6000);
  assert.equal(admit(snap(), 8000).covered, false);
  assert.equal(admit(snap({ reserved: 7369, available: 29504 }), 8000).covered, true);
});
test("14: insufficient capacity is RED / BLOCKED", () => {
  assert.equal(assessCapacity(snap({ available: 20000 })).status, "RED");
  const a = admit(snap(), 8000);
  assert.equal(a.status, "RED"); assert.ok(a.reasons.some((r) => r.includes("BLOCKED")));
  assert.equal(assessCapacity(snap({ available: 29504, reserved: 7369, pending: 20000 })).status, "YELLOW");
  const d = decide(input({ capacity: { runway: "RED" } }));
  assert.ok(!d.method.startsWith("I2V"));
});
test("15: UNKNOWN balance never becomes GREEN", async () => {
  const o = await openAiSnapshot(async () => ({ ok: true, status: 200, json: async () => ({}) }), { OPENAI_API_KEY: "x" }, 1, 0, NOW, { topupsUsd: 10, consumedUsd: 3.79 });
  assert.equal(o.health, "OK"); assert.equal(assessCapacity(o).status, "UNKNOWN"); assert.equal(o.derivedEstimate, 6.21);
  assert.equal(admit(o, 1).covered, false);
  assert.equal(assessCapacity(runwaySnapshot(1, 0, NOW)).status, "UNKNOWN");
  const x = await elevenLabsSnapshot(async () => ({ ok: true, status: 200, json: async () => ({ character_count: 36484, character_limit: 63002, next_character_count_reset_unix: 1791936000 }) }), { ELEVENLABS_API_KEY: "k" }, 7369, 0, NOW);
  assert.equal(x.available, 26518); assert.equal(x.reliability, "provider_api"); assert.equal(assessCapacity(x).status, "GREEN");
  assert.equal(assessCapacity(await elevenLabsSnapshot(async () => ({ ok: true, status: 200, json: async () => ({}) }), {}, 0, 0, NOW)).status, "UNKNOWN");
  const f = forecastDepletion(x, [{ at: "2026-09-20T00:00:00Z", used: 3000 }, { at: "2026-09-28T00:00:00Z", used: 5000 }]);
  assert.ok(f.dailyUse! > 0 && f.depletionDate);
});

// ---------- 18. no secrets ----------
test("18: no secret reaches telemetry, logs or the account registry", async () => {
  assert.equal(containsSecretValue(PROVIDER_ACCOUNTS), false);
  for (const a of PROVIDER_ACCOUNTS) assert.match(a.secretReferenceName, /^[A-Z0-9_]+$/);
  const sink = memorySink();
  await sink.append(attempt({}));
  await assert.rejects(sink.append({ ...attempt({}), failureReason: "401 for key sk-abcdefghijklmnopqrstuvwxyz123456" }), TelemetrySecretError);
  assert.throws(() => assertNoSecrets({ meta: { authorization: "x" } }), TelemetrySecretError);
  const logs: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try { await elevenLabsSnapshot(async () => ({ ok: false, status: 401, json: async () => ({}) }), { ELEVENLABS_API_KEY: "sk-secret-value-should-not-leak-000" }, 0, 0, NOW); } finally { console.log = orig; }
  assert.ok(!logs.join("").includes("sk-secret"));
});

// ---------- 19. human intervention ----------
test("19: human-intervened results are identified and do not vote", () => {
  const s = buildMemorySnapshot([attempt({}), attempt({ humanIntervention: "human", visualQaPass: false })], NOW);
  const c = Object.values(s.cells)[0];
  assert.equal(c.n, 1); assert.equal(c.nHuman, 1); assert.equal(c.visualPassRate, 1);
});

// ---------- 20. pinned snapshot ----------
test("20: a quoted project keeps its policy/memory snapshot for its whole production", () => {
  const pin = pinFor(POLICY_V1, "mem_A");
  assert.throws(() => decide(input({ pin, memorySnapshotId: "mem_B" })), SnapshotMismatchError);
  assert.throws(() => decide(input({ pin, policy: { ...POLICY_V1, policyVersion: "policy/2" } })), SnapshotMismatchError);
  assert.throws(() => { (pin as { memorySnapshotId: string }).memorySnapshotId = "mem_B"; }, TypeError);
});

// ---------- rules, rate card, telemetry separation ----------
test("rules R02/R04/R05/R06/R10 and LOW leverage", () => {
  const m = (o: Partial<ShotContractInput>) => decide(input({ contract: contract(o) })).method;
  assert.ok(!m({ shotClass: "human_creature", motionLeverage: "MEDIUM", motionRequirement: "simple" }).startsWith("I2V"));
  assert.equal(m({ shotClass: "human_creature", motionLeverage: "HIGH" }), "I2V_ECONOMY");
  assert.ok(!m({ shotClass: "single_human", riskFlags: ["identity_critical"], motionLeverage: "MEDIUM", motionRequirement: "simple" }).startsWith("I2V"));
  assert.ok(!m({ riskFlags: ["complex_hands"], motionLeverage: "MEDIUM", motionRequirement: "simple" }).startsWith("I2V"));
  assert.ok(!m({ riskFlags: ["enter_exit_frame"], motionLeverage: "MEDIUM", motionRequirement: "simple" }).startsWith("I2V"));
  assert.ok(!m({ motionLeverage: "LOW", motionRequirement: "camera_only" }).startsWith("I2V"));
  const hero = decide(input({ requestedMethod: "I2V_HERO", budget: { remainingReservedUsd: 10, generativeSecondsRemaining: 60, heroRemaining: 0 } }));
  assert.equal(hero.method, "I2V_ECONOMY"); assert.ok(hero.reasons.some((r) => r.startsWith("R10")));
  assert.equal(decide(input({ profile: PROFILES.AVATAR, pin: pinFor(POLICY_V1, "mem_empty", PROFILES.AVATAR) })).method, "STILL_KEN_BURNS", "profiles do not contaminate each other");
});

test("rate card mirrors the adapters' real prices", () => {
  assert.equal(RATE_CARD_V1.entries["runway:gen4_turbo"].price, RUNWAY_COST_USD_PER_SECOND);
  assert.equal(decide(input()).maxCostUsd, 0.25, "5 s economy clip with an approved still");
});

test("QA gate keeps technical pass, visual pass, kept and exported separate; fixtures gate like reviewers", () => {
  const fx = JSON.parse(fs.readFileSync("src/lib/production-intelligence/fixtures/dulce-regression.json", "utf8")).fixtures as (QaFinding & { humanVerdict?: string; needSeconds?: number; id: string })[];
  const cats = new Set(fx.map((f) => f.category));
  for (const c of ["GOOD", "DUPLICATION", "IDENTITY_DRIFT", "DEFORMATION", "EXTRA_LIMB", "CHARACTER_APPEARANCE", "NARRATIVE_MISMATCH", "PHYSICS_INCONSISTENCY", "UNUSED_PAID_APPROVED_ASSET", "TEXT_SUBTITLE_OVERLAP", "HELD_FRAME"]) assert.ok(cats.has(c as never), c);
  for (const f of fx) {
    const g = gateFinding(f, f.needSeconds);
    if (f.category === "GOOD") assert.equal(g.outcome, "PASS", f.id);
    else if (f.category === "PHYSICS_INCONSISTENCY") assert.equal(g.outcome, "PASS_WITH_NOTE", f.id);
    else assert.notEqual(g.outcome, "PASS", `${f.id} ${f.category} never auto-passes`);
    if (f.humanVerdict === "RECUT" && f.category !== "GOOD") assert.equal(gateFinding(f, f.usableUntilSeconds ?? 0).outcome, "TRIM", `${f.id}: reviewers recut, the gate can trim`);
  }
  const flashlight = fx.find((f) => f.category === "PHYSICS_INCONSISTENCY")!;
  assert.equal(flashlight.humanDetected, true); assert.equal(flashlight.userKept, true); assert.equal(flashlight.severity, "LOW");
  assert.ok(!("timestamp" in flashlight), "no invented timestamp");
  const keys = Object.keys(attempt({}));
  for (const k of ["technicalPass", "visualQaPass"]) assert.ok(keys.includes(k));
});
