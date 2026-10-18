/** Cinematic Director V1: synthetic quality and safety tests. No network, no provider, no media. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecipeCatalog } from "./recipes";
import { readFileSync } from "node:fs";
import { proposePlan, splitSpan, anchorFor, unitsFor, compatibleRecipes, hasKeyword } from "./propose";
import { assetVisualType, claimFor, hasTextCompanionFor, reelPlannedStockCorresponds, topicsOf } from "./policy";
import { editorialReport } from "./report";
import { inputFromStoryboard } from "./from-storyboard";
import { auditPlan } from "./audit";
import { cinematicDirectorV2Enabled } from "./flag";
import { DIRECTOR_INPUT_VERSION, DirectorInputSchema, InventoryAssetSchema, RecipeSchema, type DirectorInputRaw, type DirectorPlan } from "./contract";
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

test("catalog: 45 versioned recipes (12 mystery, 13 documentary, 12 reel incl. the T42 data card + 8 reel fiction), unique, operable rules, no universal 8K look", () => {
  assert.equal(catalog.recipes.length, 45);
  const by = (g: string) => catalog.recipes.filter(r => r.genre === g && !r.select.style).length;
  assert.deepEqual([by("misterio"), by("documental"), by("reel")], [12, 13, 12]);
  // T42: the data card is the only reel recipe that dresses a deterministic diagram, so no title recipe (3 s limit) can take it.
  const card = catalog.recipes.find(r => r.id === "reel-data-card")!;
  assert.deepEqual([card.select.visual, card.select.provenance, card.movement.kind, card.label, card.evidence_policy], [["diagram"], ["data_graphic"], "static", null, "authentic_only"]);
  assert.equal(catalog.recipes.filter(r => r.genre === "reel" && r.select.visual.includes("diagram")).length, 1);
  // The fiction set is isolated: generated material only, always labelled, sound from the clip.
  const fiction = catalog.recipes.filter(r => r.select.style === "fiction");
  assert.equal(fiction.length, 8);
  for (const r of fiction) assert.ok(r.genre === "reel" && r.label === "recreacion_ia" && r.clip_audio === true && r.select.provenance.join() === "ai_recreation", r.id);
  for (const r of catalog.recipes) assert.ok(r.negatives.length && r.version >= 1 && r.select.visual.length, r.id);
  // Graphics are animated deterministically; they are never "a clip with real motion".
  for (const id of ["doc-map-route", "doc-timeline-graphic"]) assert.equal(catalog.recipes.find(r => r.id === id)!.movement.kind, "graphic_animation");
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

// ---- Correction 2 (Codex editorial audit, T-20261012-0555-chatgpt-20): policy, compatibility, anchoring, reasons. ----

const DOC_DIR = "content/long-form/gobekli-tepe-001";
const fixture = (sbFile: string, scFile: string) => {
  const sb = JSON.parse(readFileSync(`${DOC_DIR}/${sbFile}`, "utf8")), sc = JSON.parse(readFileSync(`${DOC_DIR}/${scFile}`, "utf8"));
  const inp = inputFromStoryboard(sb.shots, sc.beats, { ai_image: 0.05, ai_video: 0.96 });
  return { inp, plan: proposePlan(inp, catalog) };
};
const SB003 = fixture("gobekli-storyboard-003.json", "gobekli-script-003-current.json");
const SB002H = fixture("gobekli-storyboard-002-hybrid.json", "gobekli-script-002-final.json");
const SB001 = fixture("gobekli-storyboard-001.json", "gobekli-script-002-final.json");
const at = (p: DirectorPlan, segmentId: string, needle: string) => p.shots.find(s => s.segmentId === segmentId && s.anchorText.includes(needle))!;
const docInput = (text: string, inventory: DirectorInputRaw["inventory"] = [], claims: { id: string; text: string; support: "sourced" | "inference" | "unverified" }[] = []): DirectorInputRaw => ({
  version: DIRECTOR_INPUT_VERSION, genre: "documental", aspect: "16:9", totalSeconds: 6,
  segments: [{ id: "s1", start: 0, end: 6, text, claims }], inventory, budget: { remainingUsd: 5, unitCostsUsd: { ai_image: 0.04, ai_video: 0.5 } } });

test("policy regressions sb003: units about human remains never get fabricated or illustrative material", () => {
  const { plan, inp } = SB003;
  const remains = plan.shots.filter(s => s.policy.class === "human_remains");
  assert.ok(remains.length >= 4, "the beat-10 units about remains are classified as such");
  for (const s of remains) {
    assert.notEqual(s.asset.status, "needs_new", `${s.id} must not generate`);
    assert.ok(!s.asset.provenance || s.asset.provenance === "data_graphic" || s.asset.provenance === "archival_documentary", `${s.id} ${s.asset.provenance}`);
  }
  // The 2017 study of skull fragments: schematic diagram or text, never AI; the rumour unit: text card only.
  const skulls = at(plan, "beat-10", "fragmentos de cráneos");
  assert.ok(skulls.asset.provenance === "data_graphic" || skulls.asset.status === "none");
  const rumour = at(plan, "beat-10", "restos humanos y posibles enterramientos");
  assert.ok(rumour.policy.unconfirmed && rumour.policy.class === "human_remains");
  assert.ok(rumour.asset.status === "none" || inp.inventory!.find(a => a.id === rumour.asset.assetId)!.kind === "text");
  const neg = at(plan, "beat-10", "no fue posible confirmarla");
  assert.ok(neg.policy.unconfirmed && neg.asset.status !== "chosen" || neg.asset.provenance === "data_graphic");
  if (neg.asset.status === "needs_new") assert.ok(neg.decision.neutral && neg.recipeId === "doc-neutral-atmosphere");
  for (const p of [SB003, SB002H, SB001]) assert.ok(!codes(p.plan, p.inp).includes("POLICY_VIOLATION"));
});

test("lexicon: singular and plural forms are recognised (monumental/es, cereal/es, precerámico)", () => {
  assert.ok(topicsOf("la arquitectura monumental").includes("structure") && topicsOf("estructuras monumentales").includes("structure"));
  assert.ok(topicsOf("un cereal silvestre").includes("food") && topicsOf("procesar cereales").includes("food"));
  assert.ok(topicsOf("el Neolítico Precerámico").includes("chrono"));
});

test("policy: «restos de plantas» and a bare «hueso» are not human remains; negations keep their nuance", () => {
  const plants = proposePlan(docInput("Análisis de fitolitos, diminutos restos de plantas, respaldan esa idea."), catalog).shots[0];
  assert.notEqual(plants.policy.class, "human_remains");
  assert.ok(plants.policy.signals.some(x => x.includes("restos de plantas")));
  const bone = proposePlan(docInput("Encontraron un hueso de gacela junto al muro."), catalog).shots[0];
  assert.notEqual(bone.policy.class, "human_remains");
  assert.ok(bone.policy.signals.some(x => x.includes("hueso")));
  const neg = proposePlan(docInput("No pudimos confirmar esa publicación sobre el sitio."), catalog).shots[0];
  assert.equal(neg.policy.class, "hypothesis");
  assert.ok(neg.policy.unconfirmed);
  // Without a text card in the segment, a hypothesis/negation gets no generated image at all: honest pending.
  assert.equal(neg.asset.status, "none");
  assert.equal(neg.decision.status, "pending");
  assert.ok(codes(proposePlan(docInput("No pudimos confirmar esa publicación sobre el sitio."), catalog), docInput("No pudimos confirmar esa publicación sobre el sitio.")).includes("DECISION_PENDING"));
});

test("policy: a neutral landscape next to sensitive narration is possible only declared, with a text card, and under review", () => {
  const card = { id: "card", kind: "text" as const, provenance: "data_graphic" as const, motion: "still" as const, license: "CLEARED" as const, tags: ["segment:s2"],
    content: { visualType: "text" as const, topics: ["research"], window: { segmentId: "s2", from: 0, to: 0.5 } } };
  // Eight ordinary landscape segments make the plan large enough (11 shots) for one neutral pause under the 10% cap.
  const filler = Array.from({ length: 8 }, (_, k) => ({ id: `f${k}`, start: 18 + k * 6, end: 24 + k * 6, text: "Una colina al amanecer en la región." }));
  const fillerAssets = filler.map(f => ({ id: `land-${f.id}`, kind: "image" as const, provenance: "stock_illustrative" as const, motion: "still" as const, license: "CLEARED" as const,
    tags: [`segment:${f.id}`, "colina", "amanecer"], content: { visualType: "landscape" as const, topics: ["landscape"] } }));
  const inp = { ...docInput("x"), totalSeconds: 66, segments: [
    { id: "s1", start: 0, end: 6, text: "Se habría publicado un estudio que nadie pudo confirmar." },
    { id: "s2", start: 6, end: 18, text: "No pudimos confirmar esa publicación. No hay otra fuente que lo respalde." }, ...filler], inventory: [card, ...fillerAssets] };
  const plan = proposePlan(inp, catalog);
  // Without a text card (s1) nothing is generated; with one (s2) the card leads and a declared neutral shot may follow.
  assert.ok(plan.shots.filter(s => s.segmentId === "s1").every(s => s.asset.status === "none" && s.decision.status === "pending"));
  const withCard = plan.shots.filter(s => s.segmentId === "s2");
  assert.equal(withCard[0].asset.assetId, "card");
  const neutral = withCard.find(s => s.decision.neutral)!;
  assert.ok(neutral && neutral.asset.status === "needs_new" && neutral.recipeId === "doc-neutral-atmosphere" && neutral.policy.status === "review_required");
  assert.ok(neutral.visualTheme.includes("no representa el hallazgo"));
  assert.ok(codes(plan, inp).includes("POLICY_REVIEW") && !codes(plan, inp).includes("POLICY_VIOLATION"));
  // Pretending a neutral shot is a normal recreation, or a normal recreation is neutral, is caught.
  {
    assert.ok(codes(mapShot(plan, neutral, s => ({ ...s, decision: { ...s.decision, neutral: false } })), inp).some(c => c === "RECIPE_INCOMPATIBLE" || c === "POLICY_VIOLATION"));
    assert.ok(codes(mapShot(plan, neutral, s => ({ ...s, recipeId: "doc-reconstruction-wide", recipeVersion: 1, decision: { ...s.decision, neutral: false } })), inp).includes("POLICY_VIOLATION"));
  }
});

test("gate: forcing a fabricated image, a stock photo or a remains diagram onto the wrong unit is a POLICY_VIOLATION", () => {
  const { plan, inp } = SB003;
  const skulls = at(plan, "beat-10", "fragmentos de cráneos");
  const asNew = mapShot(plan, skulls, s => ({ ...s, recipeId: "doc-reconstruction-wide", recipeVersion: 1, asset: { status: "needs_new", provenance: "ai_recreation", alternatives: [], label: "recreacion_ia" },
    newMaterial: { reason: "x", kind: "ai_image", estimatedMaxUsd: 0.05 } }));
  assert.ok(codes(asNew, inp).includes("POLICY_VIOLATION"));
  const stock = inp.inventory!.find(a => a.provenance === "stock_illustrative")!;
  assert.ok(codes(mapShot(plan, skulls, s => ({ ...s, asset: { status: "chosen", assetId: stock.id, provenance: "stock_illustrative", alternatives: [], label: "ilustrativa" } })), inp).includes("POLICY_VIOLATION"));
  const rumour = at(plan, "beat-10", "restos humanos y posibles enterramientos");
  assert.ok(codes(mapShot(plan, rumour, s => ({ ...s, recipeId: "doc-schematic-diagram", recipeVersion: 1, asset: { status: "chosen", assetId: "b10-s2", provenance: "data_graphic", alternatives: [], label: null } })), inp).includes("POLICY_VIOLATION"));
  assert.ok(codes(mapShot(plan, rumour, s => ({ ...s, policy: { ...s.policy, class: "atmosphere" } })), inp).includes("POLICY_MISMATCH"));
});

test("compatibility: the three audited mismatches are gone and every recipe accepts its asset's visual type", () => {
  const p3 = at(SB003.plan, "beat-3", "Lo primero que impresiona son los pilares");
  assert.notEqual(p3.recipeId, "doc-map-route");
  const p2 = at(SB002H.plan, "beat-3", "Lo primero que impresiona son los pilares");
  assert.notEqual(p2.recipeId, "doc-hands-at-work");
  const s1 = SB001.plan.shots.find(s => s.segmentId === "beat-1" && s.id.endsWith("-s2"))!;
  const s1Asset = SB001.inp.inventory!.find(a => a.id === s1.asset.assetId);
  assert.ok(!(s1.recipeId === "doc-hands-at-work" && s1Asset && assetVisualType(InventoryAssetSchema.parse(s1Asset)) === "landscape"));
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    assert.ok(!codes(plan, inp).includes("RECIPE_INCOMPATIBLE"));
    for (const s of plan.shots.filter(x => x.recipeId && x.asset.assetId && x.asset.status === "chosen")) {
      const r = catalog.recipes.find(x => x.id === s.recipeId)!, a = InventoryAssetSchema.parse(inp.inventory!.find(x => x.id === s.asset.assetId));
      assert.ok(r.select.visual.includes("*") || r.select.visual.includes(assetVisualType(a)), `${s.id}: ${r.id} vs ${assetVisualType(a)}`);
    }
  }
  // Negative: the old pairs are rejected by the gate.
  assert.ok(codes(mapShot(SB003.plan, p3, s => ({ ...s, recipeId: "doc-map-route", recipeVersion: 2, movement: { kind: "graphic_animation", realMotion: false } })), SB003.inp).includes("RECIPE_INCOMPATIBLE"));
  const landscape = SB001.inp.inventory!.find(a => InventoryAssetSchema.parse(a).content?.visualType === "landscape" && a.provenance !== "data_graphic")!;
  const forced = mapShot(SB001.plan, s1, s => ({ ...s, recipeId: "doc-hands-at-work", recipeVersion: 1, asset: { status: "chosen", assetId: landscape.id, provenance: landscape.provenance, alternatives: [], label: landscape.provenance === "ai_recreation" ? "recreacion_ia" : "ilustrativa" } }));
  assert.ok(codes(forced, SB001.inp).includes("RECIPE_INCOMPATIBLE"));
});

test("rotation only breaks ties: the chosen recipe always has the best rule score among compatible recipes", () => {
  for (const { plan } of [SB003, SB002H, SB001]) for (const s of plan.shots.filter(x => x.recipeId && x.decision.status !== "pending")) {
    assert.ok(s.decision.recipeBasis.length > 0 && s.decision.sources.includes("catalog_rule"), s.id);
    if (s.decision.sources.includes("rotation")) assert.ok(s.decision.recipeBasis.some(b => b.includes("desempate")), s.id);
  }
  const pool = catalog.recipes.filter(r => r.genre === "documental");
  const m = compatibleRecipes(pool, "structure", "stock_illustrative", "Lo primero que impresiona son los pilares.", ["pillar"], "middle", false);
  assert.ok(m.length && !m.some(x => x.recipe.id === "doc-map-route" || x.recipe.id === "doc-hands-at-work"));
});

test("anchoring: units follow sentence/clause boundaries, cover the text, respect lengths; word timestamps are used when present", () => {
  const text = "Primera idea completa aquí. Segunda idea, con una cláusula, que sigue. Tercera idea breve y final.";
  const u = unitsFor({ start: 0, end: 18, text }, 3, 8);
  assert.equal(u.map(x => x.text).join(" "), text);
  for (const x of u) assert.ok(x.end - x.start >= 3 - 1e-6 && x.end - x.start <= 8 + 1e-6 && x.timing === "estimated_proportional");
  assert.ok(u.every(x => x.boundary !== "word"));
  const tokens = text.split(/\s+/);
  const wordTimes = tokens.map((_, i) => ({ start: i * 1.1, end: i * 1.1 + 1 }));
  const timed = unitsFor({ start: 0, end: 18, text, wordTimes }, 3, 8);
  assert.ok(timed.every(x => x.timing === "word_timestamps"));
  for (const x of timed.slice(0, -1)) assert.ok(wordTimes.some(w => Math.abs(w.end - x.end) < 1e-3), "cuts land on real word ends");
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    for (const seg of inp.segments) {
      const own = plan.shots.filter(s => s.segmentId === seg.id);
      assert.equal(own.map(s => s.anchorText).join(" "), seg.text.trim().split(/\s+/).join(" "));
    }
    const m = auditPlan(plan, inp, catalog).metrics!;
    assert.ok(m.coveragePct === 100 && m.durationOk && m.shortShots === 0 && m.paidCalls === 0);
    assert.ok(plan.shots.every(s => s.unit.timing === "estimated_proportional" && s.uncertainty.some(x => x.includes("estimada"))));
  }
});

test("movement is honest: no real motion from stills, graphic animation only on deterministic graphics", () => {
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    for (const s of plan.shots) {
      const a = inp.inventory!.find(x => x.id === s.asset.assetId);
      if (s.movement.realMotion) assert.ok(a?.motion === "real" || s.newMaterial?.kind === "ai_video", s.id);
      if (s.movement.kind === "graphic_animation") assert.equal(s.asset.provenance, "data_graphic");
    }
    assert.ok(!codes(plan, inp).some(c => c === "FAKE_MOTION" || c === "MOVEMENT_INCOMPATIBLE"));
  }
  const { plan, inp } = SB003;
  const stockShot = plan.shots.find(s => s.asset.provenance === "stock_illustrative" && s.asset.status === "chosen")!;
  assert.ok(codes(mapShot(plan, stockShot, s => ({ ...s, movement: { kind: "graphic_animation", realMotion: false } })), inp).includes("MOVEMENT_INCOMPATIBLE"));
});

test("continuation: a deterministic graphic may be held only right after itself, in its segment and within its planned time", () => {
  const { plan, inp } = SB003;
  for (const s of plan.shots.filter(x => x.asset.continuation)) {
    const prev = plan.shots[plan.shots.indexOf(s) - 1];
    assert.ok(prev.segmentId === s.segmentId && prev.asset.assetId === s.asset.assetId && s.asset.provenance === "data_graphic");
  }
  assert.ok(!codes(plan, inp).includes("DUPLICATE_ASSET"));
  const stockShot = plan.shots.find(s => s.asset.provenance === "stock_illustrative" && s.asset.status === "chosen")!;
  const next = plan.shots[plan.shots.indexOf(stockShot) + 1];
  const forced = mapShot(plan, next, s => ({ ...s, recipeId: stockShot.recipeId, recipeVersion: stockShot.recipeVersion, asset: { ...stockShot.asset, continuation: true } }));
  assert.ok(codes(forced, inp).includes("DUPLICATE_ASSET"));
  // No storyboard text card or diagram is ever used outside its own beat.
  for (const s of plan.shots) {
    const a = InventoryAssetSchema.parse(inp.inventory!.find(x => x.id === s.asset.assetId) ?? { id: "-", kind: "image", provenance: "stock_illustrative", motion: "still" });
    if (a.provenance === "data_graphic" && a.content?.window) assert.equal(a.content.window.segmentId, s.segmentId);
  }
});

test("the module emits its own decision record; pending is explicit and never filled by rotation", () => {
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    for (const s of plan.shots.filter(x => x.asset.status !== "locked")) {
      assert.ok(s.visualTheme.length > 0 && s.decision.unitTopics && s.suggestions.status === "sugerencia_revisable", s.id);
      if (s.decision.status === "pending") {
        assert.ok(s.decision.pendingReason && !s.newMaterial, s.id);
        assert.ok(codes(plan, inp).includes("DECISION_PENDING"));
      }
      if (s.recipeId) assert.ok(s.suggestions.transitionIn && s.suggestions.composition, s.id);
      if (s.suggestions.sound) assert.ok(s.suggestions.sound.includes("sugerencia"), "no sound asset is invented");
    }
    const rep = editorialReport(plan, DirectorInputSchema.parse(inp));
    assert.equal(rep.sequences.length, inp.segments.length);
    assert.equal(rep.totals.shots, plan.shots.length);
    assert.ok(rep.sequences.every(q => q.movement.note.includes("no verificado")));
  }
});

// ---- Correction 3 (T-20261012-0712-chatgpt-21): factual correspondence by window/claim; neutral atmosphere caps. ----

test("sb003 beat-10-s3 (unconfirmed 2026 rumour) never uses the 2017 quote b10-s3; the quote stays with the 2017 claim", () => {
  const { plan, inp } = SB003;
  const rumour = plan.shots.find(s => s.id === "beat-10-s3")!;
  assert.ok(rumour.anchorText.includes("restos humanos y posibles enterramientos"));
  assert.notEqual(rumour.asset.assetId, "b10-s3");
  assert.ok(rumour.asset.assetId === "b10-s1" || rumour.decision.status === "pending", `${rumour.asset.assetId}`);
  if (rumour.asset.assetId === "b10-s1") assert.ok(rumour.decision.assetBasis.some(b => b.includes("correspondencia factual")));
  const seg = DirectorInputSchema.parse(inp).segments.find(s => s.id === "beat-10")!;
  for (const s of plan.shots.filter(x => x.asset.assetId === "b10-s3")) {
    assert.equal(claimFor(seg, s.anchorText)?.id ?? "b10-c2", "b10-c2", `${s.id} «${s.anchorText}»`);
    assert.ok(s.start >= 469 + 32 - 8, `${s.id} starts at ${s.start}, the quote is planned for 501–517 s`);
  }
});

test("gate: a factual card, quote or diagram forced outside its window or onto another claim is FACTUAL_MISMATCH", () => {
  const { plan, inp } = SB003;
  const rumour = plan.shots.find(s => s.id === "beat-10-s3")!;
  const quote = mapShot(plan, rumour, s => ({ ...s, recipeId: "doc-expert-quote-text", recipeVersion: 2,
    asset: { status: "chosen", assetId: "b10-s3", provenance: "data_graphic", alternatives: [], label: null, continuation: false }, newMaterial: undefined }));
  assert.ok(codes(quote, inp).includes("FACTUAL_MISMATCH"));
  // The pillar diagram b3-s1 (planned for the first window of beat-3) moved onto the last shot of beat-3.
  const lastBeat3 = [...plan.shots].reverse().find(s => s.segmentId === "beat-3")!;
  const moved = mapShot(plan, lastBeat3, s => ({ ...s, recipeId: "doc-schematic-diagram", recipeVersion: 1, movement: { kind: "graphic_animation", realMotion: false },
    asset: { status: "chosen", assetId: "b3-s1", provenance: "data_graphic", alternatives: [], label: null, continuation: false }, newMaterial: undefined }));
  assert.ok(codes(moved, inp).includes("FACTUAL_MISMATCH"));
  // A "continuation" held longer than the storyboard planned is also caught.
  const held = plan.shots.filter(s => s.segmentId === "beat-10");
  const forcedHold: DirectorPlan = { ...plan, shots: plan.shots.map(s => held.includes(s) && s !== held[0]
    ? { ...s, recipeId: held[0].recipeId, recipeVersion: held[0].recipeVersion, movement: { kind: "static", realMotion: false },
        asset: { ...held[0].asset, continuation: true }, newMaterial: undefined } : s) };
  assert.ok(codes(forcedHold, inp).includes("FACTUAL_MISMATCH"));
});

test("neutral atmosphere is capped: ≤10% of the plan and ≤1 per sequence; beyond that the shot stays pending", () => {
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    const m = auditPlan(plan, inp, catalog).metrics!;
    assert.ok(m.neutralPct <= 10 && m.maxNeutralPerSequence <= 1, `${m.neutralPct}% / ${m.maxNeutralPerSequence}`);
    assert.ok(!codes(plan, inp).includes("NEUTRAL_EXCESS"));
    for (const s of plan.shots.filter(x => x.decision.pendingReason?.includes("tope de atmósfera neutral"))) assert.ok(!s.newMaterial && s.asset.status === "none");
  }
  const { plan, inp } = SB003;
  const asNeutral = (s: DirectorPlan["shots"][number]): DirectorPlan["shots"][number] => ({ ...s, recipeId: "doc-neutral-atmosphere", recipeVersion: 1, movement: { kind: "static", realMotion: false },
    asset: { status: "needs_new", provenance: "ai_recreation", alternatives: [], label: "recreacion_ia" }, newMaterial: { reason: "x", kind: "ai_image", estimatedMaxUsd: 0.05 },
    decision: { ...s.decision, neutral: true, status: "proposed" } });
  // Over 10%: one extra neutral pause in each of 12 sequences (no explicit justification exists).
  const firstPerSeq = [...new Map(plan.shots.filter(s => s.asset.status !== "locked" && !s.decision.neutral).map(s => [s.segmentId, s])).values()].slice(0, 12);
  const many: DirectorPlan = { ...plan, shots: plan.shots.map(s => firstPerSeq.includes(s) ? asNeutral(s) : s) };
  assert.ok(codes(many, inp).includes("NEUTRAL_EXCESS"));
  // Two pauses in one sequence, even separated by other shots.
  const seq = plan.shots.filter(s => s.segmentId === "beat-4");
  const two: DirectorPlan = { ...plan, shots: plan.shots.map(s => s === seq[0] || s === seq[seq.length - 1] ? asNeutral(s) : s) };
  assert.ok(codes(two, inp).some(c => c === "NEUTRAL_EXCESS"));
  assert.ok(auditPlan(two, inp, catalog).issues.some(i => i.code === "NEUTRAL_EXCESS" && i.detail.includes("sequence beat-4")));
});

test("all earlier controls stay green on the three plans after correction 3", () => {
  for (const { plan, inp } of [SB003, SB002H, SB001]) {
    const c = codes(plan, inp), m = auditPlan(plan, inp, catalog).metrics!;
    for (const bad of ["POLICY_VIOLATION", "POLICY_MISMATCH", "FACTUAL_MISMATCH", "NEUTRAL_EXCESS", "FAKE_MOTION", "MOVEMENT_INCOMPATIBLE", "DUPLICATE_ASSET",
      "RECIPE_INCOMPATIBLE", "COST_INCONSISTENT", "AI_VIDEO_NOT_ALLOWED", "LOCKED_SEGMENT_ALTERED", "PROVENANCE_MISMATCH", "LABEL_MISMATCH", "RECREATION_WITHOUT_LABEL",
      "UNKNOWN_ASSET", "INCONSISTENT_ASSET_STATUS", "GAP_OR_OVERLAP", "SEGMENT_NOT_COVERED", "ANCHOR_NOT_IN_TEXT", "CONTRACT_INVALID", "PAID_EXECUTION"])
      assert.ok(!c.includes(bad as never), bad);
    assert.ok(m.coveragePct === 100 && m.durationOk && m.paidCalls === 0 && m.factualMismatches === 0);
    assert.ok(plan.executable === false && plan.paidCalls === 0);
    assert.ok(plan.shots.filter(s => s.policy.class === "human_remains").every(s => s.asset.provenance !== "ai_recreation" && s.asset.provenance !== "stock_illustrative"));
  }
  assert.equal(cinematicDirectorV2Enabled({}), false);
});

test("recipe keywords tolerate the simple Spanish plural; slot recipes (first/last) win their own slot", () => {
  const w = new Set(["mira", "algunos", "resultados", "apps"]);
  assert.ok(hasKeyword(w, "resultado") && hasKeyword(w, "app") && !hasKeyword(w, "pantalla"));
  assert.ok(hasKeyword(new Set(["resultado"]), "resultados"));
  const reel = catalog.recipes.filter(r => r.genre === "reel");
  const first = compatibleRecipes(reel, "people", "stock_illustrative", "¿Hacer un video te toma demasiado tiempo?", [], "first", false);
  assert.equal(first[0].recipe.id, "reel-hook-visual", "without an approved presenter the safe visual hook owns the first slot");
  const last = compatibleRecipes(reel, "people", "stock_illustrative", "Síguenos para enterarte del lanzamiento.", [], "last", false);
  assert.equal(last[0].recipe.id, "reel-cta-follow");
  // Authentic-only recipes (real UI capture, real results) never dress stock material, whatever the words say.
  assert.ok(!compatibleRecipes(reel, "concept", "stock_illustrative", "Mira algunos resultados", [], "middle", false).some(m => m.recipe.id === "reel-result-montage"));
});

test("reel-only policy rules: subtitles are the text companion; planned illustrative stock corresponds to its own sentence", () => {
  const stock = InventoryAssetSchema.parse({ id: "s1", kind: "video", provenance: "stock_illustrative", motion: "real", license: "CLEARED", tags: ["segment:seg-1"],
    content: { visualType: "concept", topics: [], window: { segmentId: "seg-1", from: 0, to: 1 } } });
  const seg = { id: "seg-1", start: 0, end: 4 };
  assert.equal(reelPlannedStockCorresponds("reel", stock, seg, 0, 2), true);
  assert.equal(reelPlannedStockCorresponds("documental", stock, seg, 0, 2), false, "documentaries keep the topic-match requirement");
  assert.equal(reelPlannedStockCorresponds("reel", { ...stock, provenance: "ai_recreation" }, seg, 0, 2), false, "AI recreations never qualify");
  assert.equal(reelPlannedStockCorresponds("reel", { ...stock, tags: ["segment:seg-2"] }, seg, 0, 2), false, "only the asset planned for this segment");
  assert.equal(reelPlannedStockCorresponds("reel", { ...stock, content: { ...stock.content!, window: { segmentId: "seg-1", from: 0, to: 0.4 } } }, seg, 3, 4), false, "outside its window");
  assert.equal(hasTextCompanionFor({ genre: "reel", inventory: [] }, "seg-1"), true);
  assert.equal(hasTextCompanionFor({ genre: "documental", inventory: [] }, "seg-1"), false);
  // The documentary plans of PR105 are unchanged by these rules (same issue codes as before; checked above too).
  for (const { plan, inp } of [SB003, SB002H, SB001]) assert.ok(!codes(plan, inp).includes("POLICY_VIOLATION" as never));
});

// ---- Correction 3/3 (chatgpt-26 continuation, Codex): the presenter hook only with an approved presenter/avatar. ----

test("presenter hook: never selected without an approved presenter/avatar; allowed (and audited) only with one", () => {
  const reel = catalog.recipes.filter(r => r.genre === "reel");
  for (const visual of ["people", "concept", "landscape"] as const) for (const prov of ["stock_illustrative", "ai_recreation"] as const) {
    const ids = compatibleRecipes(reel, visual, prov, "¿Cuántas ideas has dejado sin publicar?", [], "first", false).map(m => m.recipe.id);
    assert.ok(!ids.includes("reel-hook-face-or-avatar"), `${visual}/${prov}: ${ids.join(",")}`);
  }
  assert.equal(compatibleRecipes(reel, "people", "stock_illustrative", "¿Cuántas ideas has dejado sin publicar?", [], "first", false, true)[0].recipe.id, "reel-hook-face-or-avatar",
    "an approved presenter may open with the presenter hook");
  // The audit rejects the presenter hook on anything that is not an approved presenter/avatar (no silent relabelling).
  const inp: DirectorInputRaw = { version: DIRECTOR_INPUT_VERSION, genre: "reel", aspect: "9:16", totalSeconds: 3,
    segments: [{ id: "s1", start: 0, end: 3, text: "¿Cuántas ideas has dejado sin publicar?" }],
    inventory: [{ id: "stk", kind: "image", provenance: "stock_illustrative", motion: "still", license: "CLEARED", tags: ["segment:s1"],
      content: { visualType: "people", topics: [], window: { segmentId: "s1", from: 0, to: 1 } } }],
    constraints: { minShotSeconds: 1.5, maxShotSeconds: 6, maxTitleSeconds: 3, subtitleLines: 2 }, budget: { remainingUsd: 0, unitCostsUsd: { ai_image: 0.04, ai_video: 0.5 } } };
  const plan = proposePlan(inp, catalog);
  assert.equal(plan.shots[0].recipeId, "reel-hook-visual");
  assert.equal(plan.shots[0].asset.label, "ilustrativa", "stock keeps its illustrative label");
  const forced = { ...plan, shots: plan.shots.map(s => ({ ...s, recipeId: "reel-hook-face-or-avatar", recipeVersion: 1 })) };
  assert.ok(auditPlan(forced, inp, catalog).issues.some(i => i.code === "RECIPE_INCOMPATIBLE" && /approved presenter/.test(i.detail)));
});

test("documentary plans are unchanged by the presenter rule (same shots as with the previous reel catalog)", () => {
  const previous = { ...catalog, recipes: catalog.recipes.filter(r => r.id !== "reel-hook-visual").map(r => ({ ...r, select: { ...r.select, requires: undefined } })) };
  for (const { inp, plan } of [SB003, SB002H, SB001]) assert.deepEqual(plan.shots, proposePlan(inp, previous).shots);
});
