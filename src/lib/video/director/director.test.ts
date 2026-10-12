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
      { id: "road", kind: "video", provenance: "stock_illustrative", motion: "real", license: "CLEARED", tags: ["carretera", "noche"], dhash: "ffffffff00000000" },
      { id: "road-copy", kind: "video", provenance: "stock_illustrative", motion: "real", license: "CLEARED", tags: ["carretera", "noche"], dhash: "ffffffff00000001" },
      { id: "trees", kind: "image", provenance: "stock_illustrative", motion: "still", license: "CLEARED", tags: ["arboles", "bosque", "luz"] },
      { id: "avatar-1", kind: "avatar", provenance: "ai_recreation", motion: "real", license: "CLEARED", tags: [] },
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
  const target = plan.shots.find(s => s.asset.status === "needs_new")!;
  const unlabelled: DirectorPlan = { ...plan, shots: plan.shots.map(s => s === target ? { ...s, asset: { ...s.asset, label: null } } : s) };
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

// ---- Correction 1 (Codex audit of PR #105): one negative regression per bypass. ----

const base = () => proposePlan(input(), catalog);
const codes = (plan: unknown, inp: DirectorInputRaw = input()) => auditPlan(plan, inp, catalog).issues.map(i => i.code);
const free = (p: DirectorPlan) => p.shots.find(s => s.segmentId === "s1")!;
const mapShot = (p: DirectorPlan, target: { id: string }, f: (s: DirectorPlan["shots"][number]) => DirectorPlan["shots"][number]): DirectorPlan =>
  ({ ...p, shots: p.shots.map(s => s.id === target.id ? f(s) : s) });

test("the AI avatar locked segment keeps its provenance and the recreation label", () => {
  const locked = base().shots.find(s => s.segmentId === "s2")!;
  assert.deepEqual([locked.asset.provenance, locked.asset.label], ["ai_recreation", "recreacion_ia"]);
  const stripped = mapShot(base(), locked, s => ({ ...s, asset: { ...s.asset, label: null } }));
  assert.ok(codes(stripped).includes("RECREATION_WITHOUT_LABEL"));
});

test("integrity: unknown asset, chosen without id, none without material, unknown segment and duplicate ids are rejected", () => {
  const p = base(), s = free(p);
  assert.ok(codes(mapShot(p, s, x => ({ ...x, asset: { ...x.asset, status: "chosen", assetId: "ghost", provenance: undefined, label: null }, newMaterial: undefined }))).includes("UNKNOWN_ASSET"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, asset: { status: "chosen", alternatives: [], label: null }, newMaterial: undefined }))).includes("INCONSISTENT_ASSET_STATUS"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, asset: { status: "none", alternatives: [], label: null }, newMaterial: undefined }))).includes("NO_MATERIAL"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, segmentId: "s9" }))).includes("UNKNOWN_SEGMENT"));
  assert.ok(codes({ ...p, shots: [...p.shots, p.shots[0]] }).includes("DUPLICATE_ID"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, recipeVersion: 99 }))).includes("RECIPE_VERSION_MISMATCH"));
  assert.ok(codes({ ...p, catalogVersion: "0.0.1" }).includes("CATALOG_MISMATCH"));
});

test("rights: NOT_CLEARED evidence is never used; NEEDS_REVIEW stays pending (never approved); locked assets too", () => {
  const ev = input({ genre: "documental", totalSeconds: 6, segments: [{ id: "s1", start: 0, end: 6, text: "El informe lo confirma.", evidenceAssetId: "doc" }],
    inventory: [{ id: "doc", kind: "image", provenance: "archival_documentary", motion: "still", license: "NOT_CLEARED", tags: [] }] });
  const plan = proposePlan(ev, catalog);
  assert.notEqual(plan.shots[0].asset.assetId, "doc");
  assert.ok(plan.shots[0].uncertainty.some(u => u.includes("NOT_CLEARED")));
  const forced = mapShot(plan, plan.shots[0], s => ({ ...s, asset: { status: "chosen", assetId: "doc", provenance: "archival_documentary", alternatives: [], label: null }, newMaterial: undefined }));
  assert.ok(codes(forced, ev).includes("LICENSE_NOT_CLEARED"));
  const pending = input({ inventory: input().inventory!.map(a => a.id === "road" ? { ...a, license: "NEEDS_REVIEW" as const } : a) });
  const pp = proposePlan(pending, catalog);
  if (pp.shots.some(s => s.asset.assetId === "road")) {
    const r = auditPlan(pp, pending, catalog);
    assert.ok(!r.ok && r.issues.some(i => i.code === "LICENSE_PENDING"));
  }
  const lockedPending = input({ inventory: input().inventory!.map(a => a.id === "avatar-1" ? { ...a, license: "NEEDS_REVIEW" as const } : a) });
  assert.ok(codes(proposePlan(lockedPending, catalog), lockedPending).includes("LICENSE_PENDING"));
});

test("provenance is derived from the inventory: a plan cannot hide an AI recreation", () => {
  const inp = input({ inventory: [...input().inventory!.filter(a => a.id !== "road" && a.id !== "road-copy"),
    { id: "gen", kind: "image", provenance: "ai_recreation", motion: "still", license: "CLEARED", tags: ["carretera", "noche", "bosque"] }] });
  const plan = proposePlan(inp, catalog);
  const s = plan.shots.find(x => x.asset.assetId === "gen")!;
  assert.equal(s.asset.label, "recreacion_ia");
  const hidden = mapShot(plan, s, x => ({ ...x, asset: { ...x.asset, provenance: "stock_illustrative", label: "ilustrativa" } }));
  const c = codes(hidden, inp);
  assert.ok(c.includes("PROVENANCE_MISMATCH") && c.includes("RECREATION_WITHOUT_LABEL"));
});

test("budget is recomputed: forged total, forged shot cost and disallowed AI video are rejected", () => {
  const p = base(), s = p.shots.find(x => x.newMaterial)!;
  assert.ok(codes({ ...p, estimatedMaxUsd: 0 }).includes("COST_INCONSISTENT"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, newMaterial: { ...x.newMaterial!, estimatedMaxUsd: 0 } }))).includes("COST_INCONSISTENT"));
  const video = mapShot(p, s, x => ({ ...x, newMaterial: { ...x.newMaterial!, kind: "ai_video", estimatedMaxUsd: 0.5 } }));
  const fixedTotal = { ...video, estimatedMaxUsd: Math.round((p.estimatedMaxUsd - 0.04 + 0.5) * 100) / 100 };
  assert.ok(codes(fixedTotal).includes("AI_VIDEO_NOT_ALLOWED"));
  const poor = input({ budget: { remainingUsd: 0, unitCostsUsd: { ai_image: 0.04, ai_video: 0.5 } } });
  assert.ok(codes({ ...proposePlan(poor, catalog), estimatedMaxUsd: 0 }, poor).includes("BUDGET_EXCEEDED"), "a forged zero total cannot hide the real cost");
});

test("timeline: end<=start, shot outside its segment, empty anchor, split or moved avatar are rejected", () => {
  const p = base(), s = free(p), locked = p.shots.find(x => x.segmentId === "s2")!;
  assert.ok(codes(mapShot(p, s, x => ({ ...x, end: x.start }))).includes("CONTRACT_INVALID"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, segmentId: "s2" }))).includes("SHOT_OUTSIDE_SEGMENT"));
  assert.ok(codes(mapShot(p, s, x => ({ ...x, anchorText: "" }))).includes("EMPTY_ANCHOR"));
  const split: DirectorPlan = { ...p, shots: [...p.shots.filter(x => x !== locked),
    { ...locked, id: "s2-a", end: 25 }, { ...locked, id: "s2-b", start: 25 }] };
  assert.ok(codes(split).includes("LOCKED_SEGMENT_ALTERED"));
  const moved = { ...p, shots: p.shots.map(x => x === locked ? { ...x, start: 21 } : x.id === p.shots[p.shots.indexOf(locked) - 1]?.id ? { ...x, end: 21 } : x) };
  assert.ok(codes(moved).includes("LOCKED_SEGMENT_ALTERED"));
});
