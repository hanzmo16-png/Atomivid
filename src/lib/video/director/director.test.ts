/** Cinematic Director V1: synthetic quality and safety tests. No network, no provider, no media. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecipeCatalog } from "./recipes";
import { proposePlan, splitSpan, anchorFor } from "./propose";
import { auditPlan } from "./audit";
import { cinematicDirectorV2Enabled } from "./flag";
import { DIRECTOR_INPUT_VERSION, RecipeSchema, type DirectorInputRaw, type DirectorPlan } from "./contract";
import { compareAll } from "../../../../scripts/cinematic-director-compare";

const catalog = loadRecipeCatalog();
const TEXT = "Era de noche en la carretera del bosque cuando los testigos vieron una luz detrás de los árboles. Nadie supo explicar el resplandor.";

function input(over: Partial<DirectorInputRaw> = {}): DirectorInputRaw {
  return {
    version: DIRECTOR_INPUT_VERSION, genre: "misterio", aspect: "16:9", totalSeconds: 30,
    segments: [
      { id: "s1", start: 0, end: 20, text: TEXT },
      { id: "s2", start: 20, end: 30, text: "Hans presenta el caso.", locked: { reason: "avatar", assetId: "avatar-1" } },
    ],
    inventory: [
      { id: "road", kind: "video", provenance: "stock_illustrative", motion: "real", tags: ["carretera", "noche"], dhash: "ffffffff00000000" },
      { id: "road-copy", kind: "video", provenance: "stock_illustrative", motion: "real", tags: ["carretera", "noche"], dhash: "ffffffff00000001" },
      { id: "trees", kind: "image", provenance: "stock_illustrative", motion: "still", tags: ["arboles", "bosque", "luz"] },
      { id: "avatar-1", kind: "avatar", provenance: "stock_illustrative", motion: "real", tags: [] },
    ],
    budget: { remainingUsd: 5, unitCostsUsd: { ai_image: 0.04, ai_video: 0.5 } },
    ...over,
  };
}

test("catalog: 30 versioned recipes (12 mystery, 10 documentary, 8 reel), unique, no universal 8K look", () => {
  assert.equal(catalog.recipes.length, 30);
  const by = (g: string) => catalog.recipes.filter(r => r.genre === g).length;
  assert.deepEqual([by("misterio"), by("documental"), by("reel")], [12, 10, 8]);
  for (const r of catalog.recipes) assert.ok(r.negatives.length && r.version === 1, r.id);
  const bad = { ...catalog.recipes[0], lighting: "8K anamorphic 35mm" };
  assert.equal(RecipeSchema.safeParse(bad).success, false);
  assert.equal(RecipeSchema.safeParse({ ...catalog.recipes[3], label: "recreacion_ia" }).success, false, "authentic_only can never be labelled AI recreation");
});

test("flag is off by default and only accepts the same truthy values as feature-flags.ts", () => {
  assert.equal(cinematicDirectorV2Enabled({}), false);
  assert.equal(cinematicDirectorV2Enabled({ CINEMATIC_DIRECTOR_V2_ENABLED: "no" }), false);
  assert.equal(cinematicDirectorV2Enabled({ CINEMATIC_DIRECTOR_V2_ENABLED: "TRUE" }), true);
});

test("proposal is deterministic, covers 100% of the script, sums to the programme, anchors are exact substrings", () => {
  const a = proposePlan(input(), catalog), b = proposePlan(input(), catalog);
  assert.deepEqual(a, b);
  const { ok, issues, metrics } = auditPlan(a, input(), catalog);
  assert.deepEqual(issues, []);
  assert.ok(ok && metrics!.coveragePct === 100 && metrics!.durationOk && metrics!.paidCalls === 0);
  for (const s of a.shots.filter(s => s.segmentId === "s1")) assert.ok(TEXT.includes(s.anchorText) && s.anchorText.length > 0);
  assert.equal(a.executable, false);
  assert.equal(a.qualityNote, "semántica y calidad visual: estimado/no validado sin anotación humana");
  assert.deepEqual(splitSpan(0, 20, 3, 8).map(([x, y]) => +(y - x).toFixed(3)), [6.667, 6.666, 6.667]);
  assert.equal(anchorFor("uno dos tres cuatro", 1, 2), "tres cuatro");
});

test("locked avatar segment is passed through untouched; altering it is caught", () => {
  const plan = proposePlan(input(), catalog);
  const locked = plan.shots.find(s => s.segmentId === "s2")!;
  assert.deepEqual([locked.asset.status, locked.asset.assetId, locked.start, locked.end], ["locked", "avatar-1", 20, 30]);
  const altered: DirectorPlan = { ...plan, shots: plan.shots.map(s => s.segmentId === "s2" ? { ...s, asset: { ...s.asset, status: "chosen", assetId: "road" } } : s) };
  assert.ok(auditPlan(altered, input(), catalog).issues.some(i => i.code === "LOCKED_SEGMENT_ALTERED"));
});

test("perceptual near-duplicates are never both chosen; a forced repeat is caught", () => {
  const plan = proposePlan(input(), catalog);
  const chosen = plan.shots.map(s => s.asset.assetId).filter(Boolean);
  assert.ok(!(chosen.includes("road") && chosen.includes("road-copy")), "dhash distance 1 = same picture");
  const firstTwo = plan.shots.slice(0, 2);
  const forced: DirectorPlan = { ...plan, shots: plan.shots.map(s => firstTwo.includes(s) ? { ...s, asset: { ...s.asset, status: "chosen", assetId: "road", provenance: "stock_illustrative", label: "ilustrativa" } } : s) };
  assert.ok(auditPlan(forced, input(), catalog).issues.some(i => i.code === "DUPLICATE_ASSET"));
});

test("fake motion: a still is downgraded to a zoom and never presented as real motion; forcing it is caught", () => {
  const onlyStill = input({ inventory: [{ id: "trees", kind: "image", provenance: "stock_illustrative", motion: "still", tags: ["carretera", "noche", "bosque", "luz", "arboles", "testigos"] }],
    segments: [{ id: "s1", start: 0, end: 6, text: TEXT }], totalSeconds: 6 });
  const plan = proposePlan(onlyStill, catalog);
  const shot = plan.shots[0];
  if (shot.asset.assetId === "trees") assert.equal(shot.movement.realMotion, false);
  const forced: DirectorPlan = { ...plan, shots: [{ ...shot, asset: { ...shot.asset, status: "chosen", assetId: "trees", provenance: "stock_illustrative", label: "ilustrativa" }, movement: { kind: "real_motion", realMotion: true } }] };
  assert.ok(auditPlan(forced, onlyStill, catalog).issues.some(i => i.code === "FAKE_MOTION"));
});

test("a big title that stays on screen is caught (> 3 s)", () => {
  const one = input({ segments: [{ id: "s1", start: 0, end: 6, text: TEXT }], totalSeconds: 6 });
  const plan = proposePlan(one, catalog);
  const titled: DirectorPlan = { ...plan, shots: plan.shots.map(s => ({ ...s, recipeId: "mys-question-title-card", recipeVersion: 1 })) };
  assert.ok(auditPlan(titled, one, catalog).issues.some(i => i.code === "TITLE_TOO_LONG"));
});

test("continuity: an asset contradicting the established era or wardrobe is caught", () => {
  const inp = input({ continuity: { era: "1975" }, inventory: [
    { id: "modern", kind: "video", provenance: "stock_illustrative", motion: "real", tags: ["carretera", "noche", "era:2020"] },
    { id: "avatar-1", kind: "avatar", provenance: "stock_illustrative", motion: "real", tags: [] }] });
  const plan = proposePlan(inp, catalog);
  if (plan.shots.some(s => s.asset.assetId === "modern")) assert.ok(auditPlan(plan, inp, catalog).issues.some(i => i.code === "CONTINUITY_CONFLICT"));
  const forced: DirectorPlan = { ...plan, shots: plan.shots.map((s, i) => i === 0 ? { ...s, asset: { ...s.asset, status: "chosen", assetId: "modern", provenance: "stock_illustrative", label: "ilustrativa" } } : s) };
  assert.ok(auditPlan(forced, inp, catalog).issues.some(i => i.code === "CONTINUITY_CONFLICT"));
});

test("authentic evidence never gets the recreation look; authentic-only shots are never generated", () => {
  const inp = input({ genre: "documental", segments: [{ id: "s1", start: 0, end: 6, text: "El informe de 1975 lo confirma.", evidenceAssetId: "doc" }], totalSeconds: 6,
    inventory: [{ id: "doc", kind: "image", provenance: "archival_documentary", motion: "still", license: "CLEARED", tags: [] }] });
  const plan = proposePlan(inp, catalog);
  assert.equal(plan.shots[0].asset.assetId, "doc");
  assert.notEqual(plan.shots[0].asset.label, "recreacion_ia");
  assert.deepEqual(auditPlan(plan, inp, catalog).issues, []);
  const look: DirectorPlan = { ...plan, shots: [{ ...plan.shots[0], recipeId: "doc-reconstruction-wide", recipeVersion: 1, asset: { ...plan.shots[0].asset, label: "recreacion_ia" } }] };
  assert.ok(auditPlan(look, inp, catalog).issues.some(i => i.code === "AUTHENTIC_WITH_RECREATION_LOOK"));
});

test("AI recreation without its label is caught; the plan can never become executable or paid", () => {
  const plan = proposePlan(input(), catalog);
  const unlabelled: DirectorPlan = { ...plan, shots: plan.shots.map((s, i) => i === 0 ? { ...s, asset: { ...s.asset, provenance: "ai_recreation", label: null } } : s) };
  assert.ok(auditPlan(unlabelled, input(), catalog).issues.some(i => i.code === "RECREATION_WITHOUT_LABEL"));
  for (const bad of [{ ...plan, executable: true }, { ...plan, paidCalls: 1 }]) {
    const r = auditPlan(bad, input(), catalog);
    assert.ok(!r.ok && r.issues.some(i => i.code === "PAID_EXECUTION") && r.issues.some(i => i.code === "CONTRACT_INVALID"));
  }
});

test("budget: estimated cost above the remaining budget is reported, never spent", () => {
  const poor = input({ inventory: [{ id: "avatar-1", kind: "avatar", provenance: "stock_illustrative", motion: "real", tags: [] }], budget: { remainingUsd: 0, unitCostsUsd: { ai_image: 0.04, ai_video: 0.5 } } });
  const plan = proposePlan(poor, catalog);
  assert.ok(plan.estimatedMaxUsd > 0 && plan.paidCalls === 0);
  assert.ok(auditPlan(plan, poor, catalog).issues.some(i => i.code === "BUDGET_EXCEEDED"));
});

test("reproducible comparison on three approved storyboards: same result twice, 100% coverage, 0 calls", () => {
  const a = compareAll(), b = compareAll();
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  for (const r of a) {
    assert.equal(r.proposal!.coveragePct, 100);
    assert.equal(r.proposal!.durationOk, true);
    assert.equal(r.proposal!.duplicates, 0);
    assert.equal(r.proposal!.paidCalls, 0);
    assert.equal(r.proposal!.semanticQuality, "estimado/no validado");
  }
});
