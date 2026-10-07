import { test } from "node:test";
import assert from "node:assert/strict";
import type { FootageCandidate } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot } from "./stock-selection";
import { executeShot } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, type AllocatedShot, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { buildVisualReport, LongFormVisualQualityError } from "./visual-report";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";
import { validateDirection } from "../../../../remotion/long-form-direction";
import {
  cinematicQa,
  directCinematic,
  DELIVERY_POLICY,
  RENDERER_CAPABILITIES,
  tierSeconds,
  type CinematicQaScene,
  type DirectorInput,
} from "./cinematic-director";
import {
  planFor,
  produceOffline,
  curateFixture,
  gucciRequested,
  gucciVerifiedAssets,
  rehydrateFixture,
  BELLBOY,
  BUSINESSMAN,
  FEET,
  GUCCI_TOPIC,
  MAURIZIO,
  WRONG_NEWSPAPER,
  fakeImageProvider,
  gucciAdversarial,
  gucciRegistry,
  gucciBeats,
  gucciBeatsMisclassified,
  identify,
  poolProvider,
  printTable,
  simulate,
  type Pooled,
} from "./cinematic-simulation";

/**
 * Visual Excellence — RELEASE GATE (offline). Si el sistema SABE que un visual
 * es narrativamente falso, no se renderiza ni se entrega. Política congelada en
 * DELIVERY_POLICY; sin red, sin proveedores reales, sin gasto.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("release gate: red prohibida en las pruebas");
}) as typeof fetch;

function scene(over: Partial<CinematicQaScene> & { shotId: string; startSec: number; endSec: number }, input: Partial<DirectorInput> = {}): CinematicQaScene {
  const kind = over.display === "video" ? "video" : over.display === "card" ? "graphic" : "image";
  const decision = directCinematic([
    { startSec: over.startSec, endSec: over.endSec, durationSec: over.endSec - over.startSec, executedType: over.executedType ?? (kind === "graphic" ? "text" : "ken_burns_image"), kind, ...input },
  ])[0];
  return { ...decision, executedType: kind === "graphic" ? "text" : "ken_burns_image", display: "image", relevance: "keyword_match", durationSec: over.endSec - over.startSec, ...over };
}
const blockers = (scenes: CinematicQaScene[]) => cinematicQa(scenes).release.blockers;
const video = (shotId: string, startSec: number, endSec: number) => scene({ shotId, startSec, endSec, display: "video", provenance: "stock_illustrative" }, { provenance: "stock_illustrative" });
const IDENTITY_VISUAL: BeatVisual = { description: "Maurizio Gucci", motion: false, beatClass: "IDENTITY", identity: MAURIZIO };
const EVIDENCE_VISUAL: BeatVisual = { description: "debt report", motion: false, beatClass: "EVIDENCE", evidence: { sourceIds: ["web-5"] } };

// --------------------------------------------------------------------------
// MISSION 1 — política de entrega CONGELADA
// --------------------------------------------------------------------------

test("M1: la política de entrega está congelada — 9 bloqueantes, el resto diagnóstico", () => {
  const block = Object.entries(DELIVERY_POLICY).filter(([, v]) => v === "BLOCK").map(([k]) => k).sort();
  assert.deepEqual(block, [
    "CLASSIFICATION_INTEGRITY_GAP_IN_HERO",
    "FABRICATED_ACTION",
    "FAKE_ARCHIVAL",
    "FALSE_FRIEND_IN_EVIDENCE",
    "FALSE_FRIEND_IN_HERO",
    "FALSE_FRIEND_IN_IDENTITY",
    "GENERIC_HUMAN_IMPERSONATION",
    "IDENTITY_VISUAL_VIOLATION",
    "OPENING_TEXT_CARD_RUN",
  ]);
  const warn = Object.entries(DELIVERY_POLICY).filter(([, v]) => v === "WARN").map(([k]) => k).sort();
  assert.deepEqual(warn, ["CLASSIFICATION_INTEGRITY_GAP", "ERA_MISMATCH", "GENERIC_HERO_VISUAL", "LOW_MOTION_DENSITY", "LOW_VISUAL_DIVERSITY", "PLANNING_FAILURE_CARD", "RECONSTRUCTION_OVERUSE", "REPETITIVE_TREATMENT", "STATIC_RUN"]);
});

test("M1: cada bloqueante detiene la entrega", () => {
  // 1. Humano genérico ocupando la acción de la persona (fuera de HERO incluso).
  assert.ok(blockers([scene({ shotId: "a", startSec: 200, endSec: 205, substitutesPerson: true })]).includes("GENERIC_HUMAN_IMPERSONATION"));
  // 2-3. Falso amigo en identidad (y en HERO).
  const fakeIdentity = scene({ shotId: "b", startSec: 10, endSec: 15 }, { visual: IDENTITY_VISUAL, provenance: "stock_illustrative" });
  assert.deepEqual(
    ["FALSE_FRIEND_IN_HERO", "FALSE_FRIEND_IN_IDENTITY", "GENERIC_HUMAN_IMPERSONATION", "IDENTITY_VISUAL_VIOLATION"].filter((c) => blockers([fakeIdentity]).includes(c as never)),
    ["FALSE_FRIEND_IN_HERO", "FALSE_FRIEND_IN_IDENTITY", "GENERIC_HUMAN_IMPERSONATION", "IDENTITY_VISUAL_VIOLATION"],
  );
  // 4. Falso amigo en una prueba (otro hecho, mismo objeto).
  assert.ok(blockers([scene({ shotId: "c", startSec: 200, endSec: 205 }, { visual: EVIDENCE_VISUAL, provenance: "stock_illustrative" })]).includes("FALSE_FRIEND_IN_EVIDENCE"));
  // 5. Clasificación incierta en HERO bloquea; fuera de HERO es diagnóstico.
  const gap = (start: number) => scene({ shotId: "d", startSec: start, endSec: start + 4, display: "card", provenance: "text_card", classificationGap: true });
  assert.ok(blockers([gap(100)]).includes("CLASSIFICATION_INTEGRITY_GAP_IN_HERO"));
  assert.deepEqual(blockers([video("v", 0, 130), gap(130)]), []);
  // 6. Acción fabricada: animar material real o a la persona.
  assert.ok(blockers([scene({ shotId: "e", startSec: 200, endSec: 205, display: "video", executedType: "ai_video", provenance: "archival_documentary" })]).includes("FABRICATED_ACTION"));
  // 7. Falso archivo: generado presentado como archivo; archivo filmado de la antigüedad.
  assert.ok(blockers([scene({ shotId: "f", startSec: 200, endSec: 205, executedType: "generated_placeholder", provenance: "archival_documentary" })]).includes("FAKE_ARCHIVAL"));
  assert.ok(blockers([scene({ shotId: "g", startSec: 200, endSec: 205, display: "video", provenance: "archival_documentary", era: "ancient" })]).includes("FAKE_ARCHIVAL"));
  // 8. Violación de identidad (B2B).
  assert.ok(blockers([fakeIdentity]).includes("IDENTITY_VISUAL_VIOLATION"));
});

test("M1: 3 tarjetas seguidas en los primeros 30 s bloquean; 2, o después de los 30 s, no", () => {
  const card = (id: string, start: number) => scene({ shotId: id, startSec: start, endSec: start + 4, display: "card", provenance: "text_card", gap: true });
  assert.ok(blockers([card("a", 0), card("b", 4), card("c", 8), video("v", 12, 120)]).includes("OPENING_TEXT_CARD_RUN"));
  assert.ok(!blockers([card("a", 0), card("b", 4), video("v", 8, 120)]).includes("OPENING_TEXT_CARD_RUN"));
  assert.ok(!blockers([video("v", 0, 40), card("a", 40), card("b", 44), card("c", 48)]).includes("OPENING_TEXT_CARD_RUN"));
});

test("M1: los diagnósticos permitidos NO bloquean (movimiento bajo por verdad, retrato verificado quieto, PREMIUM bajo, época con procedencia verdadera)", () => {
  const portrait = scene({ shotId: "p", startSec: 0, endSec: 6 }, { visual: IDENTITY_VISUAL, provenance: "archival_documentary", entityLink: { name: "Maurizio Gucci" } });
  assert.equal(portrait.motionClass, "STATIC");
  const absent = scene({ shotId: "x", startSec: 6, endSec: 60, display: "card", provenance: "text_card", gap: true }, { visual: IDENTITY_VISUAL, gap: true });
  const premiumStill = scene({ shotId: "s", startSec: 120, endSec: 180, display: "image", camera: "still", motionClass: "STATIC" });
  const eraMiss = scene({ shotId: "e", startSec: 180, endSec: 185, display: "video", executedType: "ai_video", provenance: "ai_recreation", era: "early_photographic" });
  const qa = cinematicQa([portrait, absent, video("v", 60, 120), premiumStill, eraMiss]);
  assert.deepEqual(qa.release, { deliverable: true, blockers: [] }, JSON.stringify(qa.findings));
  assert.ok(qa.findings.some((f) => f.code === "LOW_MOTION_DENSITY"));
  assert.ok(qa.findings.some((f) => f.code === "ERA_MISMATCH" && f.severity === "FAIL"));
});

// --------------------------------------------------------------------------
// MISSION 3 — falso amigo de PRUEBA (mismo objeto ≠ misma proposición)
// --------------------------------------------------------------------------

const DEBT_VISUAL = {
  description: "financial newspaper headlines about corporate debt",
  motion: false,
  quote: "the company was deep in debt",
  subject: "newspaper",
  era: "1990s",
  beatClass: "EVIDENCE",
  evidence: { sourceIds: ["web-5"] },
};
const DEBT_EVIDENCE: Pooled = { id: "ev-debt", description: "1993 financial press report on the company debt", similarity: 0.33, media: "image", documents: ["web-5"] };

async function selectEvidence(visualInput: Record<string, unknown>, pool: Pooled[]) {
  const [visual] = normalizeDeclaredVisuals([visualInput], { identity: true });
  const fake = poolProvider(pool);
  return selectStockForShot(
    { shotId: "s", visual, preferVideo: false, minDurationSec: 4 },
    { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify, verifyEntityLink: fake.verifyEntityLink, verifyEvidenceLink: fake.verifyEvidenceLink },
  );
}

test("M3: deuda — el periódico del tiroteo (0.94) se rechaza; la prueba de la deuda (0.33) prueba la proposición y gana", async () => {
  assert.ok(WRONG_NEWSPAPER.similarity > DEBT_EVIDENCE.similarity, "el falso amigo conserva MÁS similitud");
  const out = await selectEvidence(DEBT_VISUAL, [WRONG_NEWSPAPER, DEBT_EVIDENCE]);
  assert.equal(out.status, "selected");
  if (out.status !== "selected") return;
  assert.equal(out.candidate.sourceId, DEBT_EVIDENCE.id);
  assert.deepEqual(out.evidenceLink, { sourceIds: ["web-5"] });
  const wrong = out.rejected.find((r) => r.sourceId === WRONG_NEWSPAPER.id);
  assert.match(wrong?.reason ?? "", /^FALSE_FRIEND: sin vínculo de prueba/, "comparte 'newspaper', no la proposición");
});

test("M3: sin prueba de confianza la escena queda AUSENTE — ni 'newspaper', ni la URL de la fuente, ni sourceIds verifican", async () => {
  const unverifiedDebt: Pooled = { ...DEBT_EVIDENCE, documents: undefined };
  assert.equal((await selectEvidence(DEBT_VISUAL, [WRONG_NEWSPAPER, unverifiedDebt])).status, "gap");
  // El candidato apunta a la página de la fuente: no es una verificación (autodeclaración).
  const fake = poolProvider([]);
  fake.provider.searchImageCandidates = async () => [
    { url: "https://cdn/x.jpg", sourceId: "self", description: "corporate debt report page", pageUrl: "https://source.example/web-5", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" } as FootageCandidate,
  ];
  const [visual] = normalizeDeclaredVisuals([DEBT_VISUAL], { identity: true });
  const self = await selectStockForShot({ shotId: "s", visual, preferVideo: false, minDurationSec: 4 }, { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify });
  assert.equal(self.status, "gap");
  // Un recurso verificado de OTRO hecho no prueba esta proposición.
  const otherFact: Pooled = { id: "ev-murder", description: "front page about corporate debt and a shooting", similarity: 0.9, media: "image", documents: ["web-2"] };
  const other = await selectEvidence(DEBT_VISUAL, [otherFact]);
  assert.equal(other.status, "gap");
  assert.match(other.rejected[0]?.reason ?? "", /documenta otro hecho/);
});

test("M3: EVIDENCE sin proposición declarada no busca nada (fallo del planner) y nunca se genera una prueba", async () => {
  const out = await selectEvidence({ ...DEBT_VISUAL, evidence: undefined }, [WRONG_NEWSPAPER, DEBT_EVIDENCE]);
  assert.equal(out.status, "gap");
  if (out.status === "gap") assert.match(out.reason, /^PLANNING_FAILURE/);
  const ex = await executeOne(DEBT_VISUAL, [WRONG_NEWSPAPER], "generated_placeholder");
  assert.equal(ex.prompts.length, 0, "una recreación IA no es una prueba");
  assert.equal(ex.ex.executedType, "text");
});

// --------------------------------------------------------------------------
// MISSION 4 / 10 — controles: PROCESS, identidad, PLACE con gente, ABSENT
// --------------------------------------------------------------------------

async function executeOne(visualInput: Record<string, unknown>, pool: Pooled[], type: AllocatedShot["type"] = "ken_burns_image", beatVisuals?: Record<string, unknown>[]) {
  const visuals = normalizeDeclaredVisuals(beatVisuals ?? [visualInput], { identity: true });
  const visual = visuals[beatVisuals ? beatVisuals.indexOf(visualInput) : 0];
  const fake = poolProvider(pool);
  const image = fakeImageProvider();
  const mem = memoryShotAssetStore();
  const shot = {
    id: "x-shot-1",
    beatId: "x",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type,
    source: type === "generated_placeholder" ? "generated" : "stock",
    assetId: "x",
    visualIntent: visual.description,
    motion: "ken_burns",
    captionText: visual.quote ?? visual.description,
    narrationFragment: visual.quote ?? visual.description,
    anchoredVisual: visual,
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: "x",
    status: "planned",
    validationStatus: "pending",
    plannedType: type,
  } as AllocatedShot;
  const ex = await executeShot(
    shot,
    {
      topic: "t",
      footageProvider: fake.provider,
      imageProvider: image.provider,
      store: mem.store,
      budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 2, maxAiVideoClips: 0, maxGenerativeUsd: 1 }),
      units: getGenerativeUnitCosts(),
      aiVideoCostConfig: getAiVideoCostConfig("balanced"),
      totalDurationSec: 60,
      requireReal: false,
      visualPipeline: "anchored_v1",
      registry: new DocumentAssetRegistry(),
      identify,
      verifyEntityLink: fake.verifyEntityLink,
      verifyEvidenceLink: fake.verifyEvidenceLink,
    },
    emptyAiVideoLedgerState(),
  );
  return { ex, prompts: image.prompts };
}

const WORKSHOP: Pooled = { id: "w-1", description: "weavers working at looms in a vintage textile workshop in Florence", similarity: 0.9, media: "image" };

test("M10-A/B: PROCESS con trabajadores es legal; la MISMA imagen no suplanta a la persona", async () => {
  const process = await executeOne({ description: "textile workshop in Florence in the 1950s with weavers at looms", motion: true, subject: "textile workshop", action: "weaving", place: "Florence", era: "1950s", beatClass: "PROCESS" }, [WORKSHOP]);
  assert.equal(process.ex.assetMeta?.selection?.candidateDescription, WORKSHOP.description);
  const identity = await executeOne({ description: "Maurizio Gucci walking through the textile workshop", motion: true, subject: "Maurizio Gucci", action: "walking", place: "Florence", beatClass: "IDENTITY", identity: MAURIZIO }, [WORKSHOP]);
  assert.equal(identity.ex.executedType, "text");
});

test("M10-C: PLACE puede tener gente de contexto si no se presenta como la persona; quien hace la acción de la persona no", async () => {
  const beat = [
    { description: "Maurizio Gucci entering his office building", motion: true, subject: "Maurizio Gucci", action: "entering", beatClass: "IDENTITY", identity: MAURIZIO },
    { description: "quiet street in central Milan with grey buildings", motion: false, subject: "street", place: "Milan", beatClass: "PLACE" },
  ];
  const pedestrians: Pooled = { id: "ped", description: "pedestrians on a quiet street in central Milan", similarity: 0.8, media: "image" };
  const ok = await executeOne(beat[1], [pedestrians], "ken_burns_image", beat);
  assert.equal(ok.ex.assetMeta?.selection?.candidateDescription, pedestrians.description, "gente de contexto en un lugar: legal");
  const entering: Pooled = { id: "ent", description: "man entering a building on a quiet street in Milan", similarity: 0.85, media: "image" };
  const no = await executeOne(beat[1], [entering], "ken_burns_image", beat);
  assert.equal(no.ex.executedType, "text", "muestra la acción de la persona: la sustituiría");
});

test("M10-D/E: EVIDENCE debe probar su proposición; ABSENT sigue siendo legal", async () => {
  const proven = await executeOne(DEBT_VISUAL, [WRONG_NEWSPAPER, DEBT_EVIDENCE]);
  assert.equal(proven.ex.assetMeta?.provenance?.kind, "archival_documentary");
  assert.deepEqual(proven.ex.assetMeta?.selection?.evidenceLink, { sourceIds: ["web-5"] });
  const absent = await executeOne(DEBT_VISUAL, [WRONG_NEWSPAPER]);
  assert.equal(absent.ex.executedType, "text");
  assert.ok(absent.ex.assetMeta?.gap);
});

// --------------------------------------------------------------------------
// MISSION 7 — verdad sobre lo que el renderer sabe hacer
// --------------------------------------------------------------------------

test("M7: el QA solo cuenta lo que el renderer ejecuta; lo no soportado se declara, nunca se finge", () => {
  const supported = Object.entries(RENDERER_CAPABILITIES).filter(([, v]) => v === "SUPPORTED_NOW").map(([k]) => k);
  const planned = Object.entries(RENDERER_CAPABILITIES).filter(([, v]) => v === "PLANNED_NOT_SUPPORTED").map(([k]) => k);
  assert.ok(planned.includes("parallax") && planned.includes("schematic_map") && planned.includes("grade:archival_monochrome"));
  // Cada cámara que el Director puede emitir la valida el renderer real.
  const cams = supported.filter((k) => k.startsWith("camera:")).map((k) => k.slice("camera:".length));
  assert.doesNotThrow(() => validateDirection(cams.map((c, i) => ({ id: `s${i}`, startSeconds: i, endSeconds: i + 1, direction: { camera: c as never, look: { contrast: 1.1 } } })), undefined, cams.length));
  const decisions = directCinematic([
    { startSec: 0, endSec: 5, durationSec: 5, executedType: "ken_burns_image", kind: "image", provenance: "archival_documentary", visual: { description: "x", motion: false, era: "1930s", beatClass: "PLACE" } },
    { startSec: 5, endSec: 10, durationSec: 5, executedType: "text", kind: "graphic", visual: { description: "army", motion: true, era: "480 BC", beatClass: "PROCESS" } },
  ]);
  for (const d of decisions) {
    assert.ok(d.executed.every((t) => RENDERER_CAPABILITIES[t] === "SUPPORTED_NOW"));
    assert.ok(d.unsupported.every((t) => RENDERER_CAPABILITIES[t] === "PLANNED_NOT_SUPPORTED"));
    assert.ok(!d.executed.includes("parallax" as never));
  }
  assert.deepEqual(decisions[0].unsupported, ["grade:archival_monochrome"], "B/N auténtico: pedido, no ejecutado (solo contraste)");
  assert.ok(decisions[0].executed.includes("look:contrast"));
  assert.deepEqual(decisions[1].unsupported, ["schematic_map"], "esquema pedido; se ejecuta el pasaje");
  assert.equal(decisions[1].motionClass, "STATIC");
});

// --------------------------------------------------------------------------
// MISSION 5 / 8 / 11 — Gucci por la ruta productiva y la puerta de entrega
// --------------------------------------------------------------------------

test("M8/M11: Gucci por la ruta productiva v4 PASA la puerta de entrega (verdad + identidad + prueba + entrega)", async () => {
  const sim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry: gucciRegistry() });
  printTable("GUCCI v4 — release gate", sim.rows);
  const qa = sim.report.cinematic!.qa;
  console.log("GUCCI RELEASE", JSON.stringify({ release: qa.release, status: qa.status, windows: qa.windows.map((w) => ({ tier: w.tier, density: w.density, reconstructionShare: w.reconstructionShare })), warnings: qa.findings.map((f) => `${f.code}: ${f.detail}`), cards: qa.cards, textFallbackRatio: sim.textFallbackRatio }, null, 1));
  const shown = sim.report.scenes.map((s) => s.candidateDescription);
  for (const adv of [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER]) assert.ok(!shown.includes(adv.description), `${adv.id} ausente`);
  const decisions = sim.report.cinematic!.scenes;
  for (const d of decisions.filter((x) => x.identityRequired)) assert.ok(d.provenance === "text_card" || d.verifiedIdentity, `${d.shotId}: sin humano genérico en identidad`);
  for (const d of decisions.filter((x) => x.evidenceRequired)) assert.ok(d.provenance === "text_card" || d.verifiedEvidence, `${d.shotId}: prueba verificada o ausencia`);
  assert.ok(!sim.prompts.some((p) => /maurizio/i.test(p)), "ningún Maurizio generado");
  for (const code of ["FAKE_ARCHIVAL", "FABRICATED_ACTION", "CLASSIFICATION_INTEGRITY_GAP_IN_HERO", "OPENING_TEXT_CARD_RUN", "GENERIC_HUMAN_IMPERSONATION", "FALSE_FRIEND_IN_EVIDENCE"]) {
    assert.ok(!qa.findings.some((f) => f.code === code), code);
  }
  assert.deepEqual(sim.preflightBlockers, []);
  assert.deepEqual(qa.release, { deliverable: true, blockers: [] });
  assert.equal(sim.gateError, null);
  assert.ok(sim.textFallbackRatio <= 0.25, `guarda existente de tarjetas (${sim.textFallbackRatio})`);
  // La prueba correcta de la deuda (0.33) ocupa la escena donde antes entraba el periódico del tiroteo.
  assert.ok(shown.includes("1993 financial press report on the company debt"));
  // M5: cada tarjeta con su porqué; en el Gucci que cumple, ninguna es fallo del planner.
  assert.ok(qa.cards.length > 0 && qa.cards.every((c) => c.reason === "TRUTHFUL_ABSTENTION"), JSON.stringify(qa.cards));
  assert.equal(networkCalls, 0);
});

test("M5: el planner que clasifica mal (subida de Maurizio como TRANSITION) NO es una abstención buena — y en HERO bloquea antes de gastar", async () => {
  const sim = await simulate(gucciBeatsMisclassified, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry: gucciRegistry() });
  assert.ok(sim.preflightBlockers.some((b) => b.code === "CLASSIFICATION_INTEGRITY_GAP_IN_HERO"));
  assert.ok(sim.gateError instanceof LongFormVisualQualityError);
  const reasons = sim.report.cinematic!.qa.cards.map((c) => c.reason);
  assert.ok(reasons.includes("CLASSIFICATION_INTEGRITY_GAP"));
  assert.ok(reasons.includes("TRUTHFUL_ABSTENTION"), "las negativas a mostrar al bellboy/ejecutivo siguen siendo abstenciones buenas");
  // Los falsos amigos tampoco aparecen aquí.
  for (const adv of [FEET, BELLBOY, BUSINESSMAN]) assert.ok(!sim.report.scenes.some((s) => s.candidateDescription === adv.description));
});

test("M5: una escena IDENTITY sin identidad declarada es PLANNING_FAILURE (no abstención)", () => {
  const [v] = normalizeDeclaredVisuals([{ description: "a man", motion: false, beatClass: "IDENTITY" }], { identity: true });
  const [d] = directCinematic([{ startSec: 200, endSec: 205, durationSec: 5, executedType: "text", kind: "graphic", visual: v, gap: true }]);
  assert.equal(d.cardReason, "PLANNING_FAILURE");
});

// --------------------------------------------------------------------------
// MISSION 2 / 9 — un bloqueante NO llega al render (produce.ts real, offline)
// --------------------------------------------------------------------------

/** Tres escenas de identidad seguidas al abrir: sin archivo verificado (producción hoy) → 3 tarjetas en los primeros 30 s. */
const openingIdentityBeats: ProductionPlanBeatInput[] = [
  {
    id: "o1",
    type: "hook",
    narration:
      "Maurizio Gucci arrived at his office early on that spring morning. Maurizio Gucci greeted the doorman standing at the main entrance. Maurizio Gucci climbed the stairs slowly toward the first floor office. The quiet street outside was still wet from the night rain in Milan.",
    visuals: [
      { description: "Maurizio Gucci arriving at his office", motion: true, quote: "Maurizio Gucci arrived at his office early on that spring morning", subject: "Maurizio Gucci", action: "arriving", place: "Milan", era: "1995", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "Maurizio Gucci greeting the doorman", motion: true, quote: "Maurizio Gucci greeted the doorman standing at the main entrance", subject: "Maurizio Gucci", action: "greeting", place: "Milan", era: "1995", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "Maurizio Gucci climbing the stairs", motion: true, quote: "Maurizio Gucci climbed the stairs slowly toward the first floor office", subject: "Maurizio Gucci", action: "climbing", place: "Milan", era: "1995", beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "wet quiet street in Milan at dawn", motion: false, quote: "The quiet street outside was still wet from the night rain", subject: "street", place: "Milan", era: "1990s", beatClass: "PLACE" },
    ],
  },
];

test("M9: v4 + bloqueante conocido en el PLAN (clasificación incierta en HERO) → se detiene ANTES de cualquier llamada pagada: 0 voz, 0 stock, 0 imagen, 0 música, 0 render", async () => {
  const run = await produceOffline(gucciBeatsMisclassified, planFor(gucciBeatsMisclassified));
  assert.ok(run.error instanceof LongFormVisualQualityError, String(run.error));
  assert.match((run.error as Error).message, /CLASSIFICATION_INTEGRITY_GAP_IN_HERO/);
  assert.deepEqual(run.events, [], "ningún proveedor ni render");
});

test("M9: v4 + bloqueante conocido tras resolver los recursos (3 tarjetas en los primeros 30 s) → el render NO empieza y nada se llama después", async () => {
  // El registro cubre a la persona (el plan parece entregable), pero el archivo no se puede descargar al ejecutar:
  // el bloqueante solo aparece tras resolver los recursos.
  const registry = rehydrateFixture(curateFixture([gucciVerifiedAssets[0]], gucciRequested()));
  const run = await produceOffline(openingIdentityBeats, planFor(openingIdentityBeats), { verifiedAssets: registry, failDownloads: /archive\.example/ });
  assert.ok(run.error instanceof LongFormVisualQualityError, String(run.error));
  assert.match((run.error as Error).message, /OPENING_TEXT_CARD_RUN/);
  const known = run.events.indexOf("visual-report");
  assert.ok(known >= 0, "el informe (y el bloqueante) quedan registrados");
  assert.ok(run.events.slice(0, known).includes("voice"), "este bloqueante solo se conoce tras resolver voz y recursos (no lo revela el plan)");
  assert.deepEqual(run.events.slice(known + 1), [], "después del bloqueante: 0 música, 0 subidas, 0 render, 0 proveedores");
  assert.ok(!run.events.includes("render"));
});

test("V3: las reglas nuevas son solo v4 — el mismo guion mal clasificado con un plan v3 se ejecuta como antes y llega al render", async () => {
  const v3 = { ...planFor(gucciBeatsMisclassified), version: 3 } as ProductionPlan;
  const run = await produceOffline(gucciBeatsMisclassified, v3);
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.events.includes("render"));
  const report = buildVisualReport({ requestId: "r", planVersion: 3, topic: "t", shots: [], executions: [], now: () => 0 });
  assert.equal("cinematic" in report, false);
  const [v] = normalizeDeclaredVisuals([DEBT_VISUAL]);
  assert.equal(v.evidence, undefined, "v3 no lee la proposición de prueba");
  assert.equal(tierSeconds(0, 1).HERO, 1);
});
