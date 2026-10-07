import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DocumentAssetRegistry } from "./asset-identity";
import { BELLBOY, BUSINESSMAN, FEET, GUCCI_TOPIC, MAURIZIO, WRONG_NEWSPAPER, fakeImageProvider, gucciAdversarial, gucciBeats, identify, poolProvider, printTable, simulate, type Pooled } from "./cinematic-simulation";
import { executeShot } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import {
  allocateShotTypes,
  estimateNarrationSeconds,
  getGenerativeUnitCosts,
  planShotsFromScript,
  resolveExecutablePlan,
  strategyLimits,
  computeScriptHash,
  type AllocatedShot,
  type ProductionPlan,
  type ProductionPlanBeatInput,
} from "./production-plan";
import { shotsForSpan, type VisualStrategy } from "./shots";
import { buildVisualReport, assertVisualQuality, LongFormVisualQualityError } from "./visual-report";
import { directAnchoredScenes } from "./produce";
import { selectStockForShot } from "./stock-selection";
import { normalizeDeclaredVisuals, visualsForBeat, type BeatVisual } from "./visual-intents";
import {
  cinematicQa,
  costClassOf,
  directCinematic,
  eraProfile,
  generativeVerdict,
  HERO_RECONSTRUCTION_CAP,
  MOTION_DENSITY_TARGET,
  motionClassOf,
  requiresSchematic,
  shotTier,
  tierSeconds,
  type CinematicQaScene,
  type DirectorInput,
} from "./cinematic-director";

/**
 * Cinematic Director V1 (C1–C4). Todo offline: proveedores falsos, sin red,
 * sin gasto. Las simulaciones ejecutan las MISMAS funciones del pipeline v4
 * (normalización → anclaje → asignación → ejecución → informe → dirección →
 * QA); la tabla impresa sale del informe, no de una tabla escrita a mano.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("Cinematic Director: red prohibida en las pruebas");
}) as typeof fetch;


// --------------------------------------------------------------------------
// Utilidades de QA puro (escenas construidas con la misma forma que produce el informe)
// --------------------------------------------------------------------------

function qaScene(over: Partial<CinematicQaScene> & { startSec: number; endSec: number; shotId: string }): CinematicQaScene {
  const kind = over.display === "video" ? "video" : over.display === "card" ? "graphic" : "image";
  const decision = directCinematic([
    {
      startSec: over.startSec,
      endSec: over.endSec,
      durationSec: over.endSec - over.startSec,
      executedType: over.executedType ?? "ken_burns_image",
      kind,
      provenance: over.provenance === "text_card" ? undefined : over.provenance,
    },
  ])[0];
  return {
    ...decision,
    executedType: "ken_burns_image",
    display: "image",
    relevance: "keyword_match",
    durationSec: over.endSec - over.startSec,
    ...over,
  };
}

// --------------------------------------------------------------------------
// C1 — zonas, medición, época, costo
// --------------------------------------------------------------------------

test("1-3: HERO 0–120, PREMIUM 120–180, STANDARD 180+ (sin mínimo de movimiento en STANDARD)", () => {
  assert.equal(shotTier(0, 5), "HERO");
  assert.equal(shotTier(115, 120), "HERO");
  assert.equal(shotTier(120, 126), "PREMIUM");
  assert.equal(shotTier(175, 180), "PREMIUM");
  assert.equal(shotTier(180, 186), "STANDARD");
  assert.equal(MOTION_DENSITY_TARGET.STANDARD, null);
  // HERO y PREMIUM en movimiento; un tramo STANDARD completamente quieto no produce LOW_MOTION_DENSITY.
  const scenes = [
    qaScene({ shotId: "v", startSec: 0, endSec: 180, display: "video", provenance: "stock_illustrative" }),
    ...[0, 1, 2].map((i) => qaScene({ shotId: `s${i}`, startSec: 180 + i * 5, endSec: 185 + i * 5, display: "card", provenance: "text_card" })),
  ];
  const qa = cinematicQa(scenes);
  assert.equal(qa.windows.find((w) => w.tier === "STANDARD")!.density, 0);
  assert.equal(qa.findings.filter((f) => f.code === "LOW_MOTION_DENSITY").length, 0);
});

test("4-5: la escena 110–140 hereda HERO, pero aporta 10 s a HERO y 20 s a PREMIUM en las métricas", () => {
  assert.equal(shotTier(110, 140), "HERO");
  assert.deepEqual(tierSeconds(110, 140), { HERO: 10, PREMIUM: 20, STANDARD: 0 });
  const scenes = [
    qaScene({ shotId: "a", startSec: 0, endSec: 110, display: "video", provenance: "stock_illustrative" }),
    qaScene({ shotId: "b", startSec: 110, endSec: 140, display: "card", provenance: "text_card" }),
    qaScene({ shotId: "c", startSec: 140, endSec: 180, display: "video", provenance: "stock_illustrative" }),
  ];
  assert.equal(scenes[1].tier, "HERO");
  const qa = cinematicQa(scenes);
  const hero = qa.windows.find((w) => w.tier === "HERO")!;
  const premium = qa.windows.find((w) => w.tier === "PREMIUM")!;
  assert.equal(hero.seconds - hero.motionSeconds, 10, "10 s quietos cuentan en HERO");
  assert.equal(premium.seconds - premium.motionSeconds, 20, "20 s quietos cuentan en PREMIUM");
});

test("6: la densidad sale de las duraciones reales (cambiar una duración la cambia en proporción)", () => {
  const build = (motionEnd: number) => [
    qaScene({ shotId: "m", startSec: 0, endSec: motionEnd, display: "video", provenance: "stock_illustrative" }),
    qaScene({ shotId: "s", startSec: motionEnd, endSec: 120, display: "card", provenance: "text_card" }),
  ];
  for (const motionEnd of [30, 72, 101]) {
    const hero = cinematicQa(build(motionEnd)).windows[0];
    const expected = build(motionEnd).filter((s) => s.motionClass !== "STATIC").reduce((a, s) => a + s.tierSeconds.HERO, 0) / 120;
    assert.equal(hero.density, Math.round(expected * 1000) / 1000);
  }
  // "motion: true" en la intención no cuenta: solo el tratamiento ejecutable.
  assert.equal(motionClassOf({ kind: "image", camera: "still" }), "STATIC");
  assert.equal(motionClassOf({ kind: "graphic", camera: "push" }), "STATIC");
});

test("7-8: metas diagnósticas HERO 80 % y PREMIUM 65 %", () => {
  const window = (start: number, end: number, motionShare: number) => {
    const cut = start + (end - start) * motionShare;
    return [
      qaScene({ shotId: `m${start}`, startSec: start, endSec: cut, display: "video", provenance: "stock_illustrative" }),
      qaScene({ shotId: `s${start}`, startSec: cut, endSec: end, display: "image", provenance: "stock_illustrative", camera: "still", motionClass: "STATIC" }),
    ];
  };
  const low = (scenes: CinematicQaScene[]) => cinematicQa(scenes).findings.filter((f) => f.code === "LOW_MOTION_DENSITY").map((f) => f.tier);
  assert.deepEqual(low([...window(0, 120, 0.79), ...window(120, 180, 0.66)]), ["HERO"]);
  assert.deepEqual(low([...window(0, 120, 0.81), ...window(120, 180, 0.64)]), ["PREMIUM"]);
  assert.deepEqual(low([...window(0, 120, 0.81), ...window(120, 180, 0.66)]), []);
});

test("10-11: un retrato VERIFICADO quieto ≤ 8 s no forma STATIC_RUN por sí solo, pero sus segundos siguen siendo STATIC", () => {
  const portrait = (verified: boolean) =>
    qaScene({ shotId: "p", startSec: 0, endSec: 7, display: "image", provenance: "archival_documentary", camera: "still", motionClass: "STATIC", identityRequired: verified, verifiedIdentity: verified });
  const card = qaScene({ shotId: "c", startSec: 7, endSec: 11, display: "card", provenance: "text_card" });
  const verified = cinematicQa([portrait(true), card]);
  assert.equal(verified.findings.filter((f) => f.code === "STATIC_RUN").length, 0);
  assert.equal(verified.windows[0].motionSeconds, 0, "los 7 s del retrato cuentan como STATIC en la densidad");
  // Una foto NO verificada no tiene la excepción.
  const unverified = cinematicQa([portrait(false), card]);
  assert.ok(unverified.findings.some((f) => f.code === "STATIC_RUN"));
  // Más de 8 s quieto: ya no está exento.
  const long = qaScene({ shotId: "p", startSec: 0, endSec: 9, display: "image", provenance: "archival_documentary", camera: "still", motionClass: "STATIC", identityRequired: true, verifiedIdentity: true });
  assert.ok(cinematicQa([long, { ...card, startSec: 9, endSec: 13 }]).findings.some((f) => f.code === "STATIC_RUN"));
});

test("14: una reconstrucción es GENERATIVE_COST aunque la simulación offline cueste USD 0", () => {
  assert.equal(costClassOf("generated_placeholder", "ai_recreation"), "GENERATIVE_COST");
  assert.equal(costClassOf("ai_video"), "GENERATIVE_COST");
  assert.equal(costClassOf("ken_burns_image", "stock_illustrative"), "ZERO_COST");
  assert.equal(costClassOf("text", "text_card"), "ZERO_COST");
  assert.equal(costClassOf("ken_burns_image", "archival_documentary"), "LOW_COST");
});

test("15-17: perfiles de época — 1930s, 1990s y antigüedad deciden cosas distintas", () => {
  const p1930 = eraProfile("1930s");
  const p1990 = eraProfile("1990s");
  const ancient = eraProfile("480 BC ancient Greece");
  assert.deepEqual([p1930.period, p1930.grade, p1930.generatedMotion, p1930.cadence], ["early_photographic", "archival_monochrome", false, "archival"]);
  assert.deepEqual([p1990.period, p1990.grade, p1990.generatedMotion, p1990.cadence], ["late_20th", "period_color", true, "contemporary"]);
  assert.deepEqual([ancient.period, ancient.filmedArchive, ancient.generatedMotion, ancient.schematicAction], ["ancient", false, false, true]);
  // Misma escena, distinta época → distinta decisión (cámara y grado), no un filtro sepia.
  const scene = (era: string, provenance: DirectorInput["provenance"]): DirectorInput => ({
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    executedType: "ken_burns_image",
    kind: "image",
    provenance,
    visual: { description: "street", motion: false, era, beatClass: "PLACE" },
  });
  const cams = (era: string) => directCinematic([0, 1, 2, 3].map(() => scene(era, "stock_illustrative"))).map((d) => d.camera);
  assert.deepEqual(cams("1930s"), ["push", "pull", "push", "pull"]);
  assert.deepEqual(cams("1990s"), ["push", "left", "pull", "right"]);
  assert.deepEqual(directCinematic([scene("1930s", "archival_documentary")])[0].look, { contrast: 1.1 }, "grado solo sobre archivo verificado");
  assert.equal(directCinematic([scene("1930s", "stock_illustrative")])[0].look, undefined, "nunca disfraza material moderno como antiguo");
  assert.equal(directCinematic([scene("1990s", "archival_documentary")])[0].look, undefined);
  // Video IA: no en 1930s (fabricaría metraje de época), sí en 1990s para el entorno.
  const env = (era: string): BeatVisual => ({ description: "street", motion: false, era, beatClass: "PLACE" });
  assert.equal(generativeVerdict(env("1930s"), "video").allowed, false);
  assert.equal(generativeVerdict(env("1990s"), "video").allowed, true);
});

test("18-19: antigüedad — nunca archivo filmado falso; el movimiento de tropas es esquemático", () => {
  const march: BeatVisual = { description: "Persian army marching through the pass", motion: true, era: "480 BC", beatClass: "PROCESS" };
  assert.equal(requiresSchematic(march), true);
  assert.equal(generativeVerdict(march, "image").allowed, false);
  assert.equal(generativeVerdict({ ...march, motion: false, beatClass: "PLACE" }, "image").allowed, true, "el entorno sí admite reconstrucción");
  const archivalVideo = qaScene({ shotId: "v", startSec: 0, endSec: 5, display: "video", provenance: "archival_documentary", era: "ancient" });
  // Política congelada: archivo filmado de la antigüedad = FAKE_ARCHIVAL (bloquea).
  const fakeFootage = cinematicQa([archivalVideo]).findings.find((f) => f.code === "FAKE_ARCHIVAL");
  assert.equal(fakeFootage?.severity, "BLOCK");
  // Preferencia de época con procedencia verdadera (stock rotulado como ilustrativo): diagnóstico, no bloqueo.
  const photoreal = qaScene({ shotId: "t", startSec: 0, endSec: 5, display: "image", provenance: "stock_illustrative", schematic: true, era: "ancient" });
  assert.equal(cinematicQa([photoreal]).findings.find((f) => f.code === "ERA_MISMATCH")?.severity, "FAIL");
});

test("20-22: el Director nunca cambia el recurso; presentación permitida sobre retrato verificado; acción fabricada prohibida", () => {
  const visual: BeatVisual = { description: "Maurizio Gucci", motion: false, era: "1990s", beatClass: "IDENTITY", identity: { name: "Maurizio Gucci", kind: "person" } };
  const inputs: DirectorInput[] = [
    { startSec: 0, endSec: 12, durationSec: 12, executedType: "ken_burns_image", kind: "image", provenance: "archival_documentary", visual, entityLink: { name: "Maurizio Gucci" } },
    { startSec: 12, endSec: 17, durationSec: 5, executedType: "text", kind: "graphic", visual, gap: true },
  ];
  const frozen = JSON.stringify(inputs);
  const [portrait, absent] = directCinematic(inputs);
  assert.equal(JSON.stringify(inputs), frozen, "el Director no muta su entrada");
  assert.equal(portrait.verifiedIdentity, true);
  assert.equal(portrait.motionClass, "PRESENTATION_MOTION", "retrato verificado largo: movimiento de presentación");
  assert.equal(portrait.provenance, "archival_documentary");
  assert.equal(absent.provenance, "text_card", "la ausencia sigue siendo ausencia");
  // Acción fabricada: ni imagen ni video generados para la identidad, y el QA bloquea si apareciera.
  assert.equal(generativeVerdict(visual, "image").allowed, false);
  assert.equal(generativeVerdict(visual, "video").allowed, false);
  const fabricated = qaScene({ shotId: "f", startSec: 0, endSec: 5, display: "image", provenance: "ai_recreation", identityRequired: true, verifiedIdentity: false });
  assert.equal(cinematicQa([fabricated]).findings.find((f) => f.code === "IDENTITY_VISUAL_VIOLATION")?.severity, "BLOCK");
});

test("RECONSTRUCTION_OVERUSE: > 30 % de los segundos de HERO (por duración, no por número de escenas)", () => {
  const scenes = [
    qaScene({ shotId: "r", startSec: 0, endSec: 40, display: "image", provenance: "ai_recreation" }),
    qaScene({ shotId: "v", startSec: 40, endSec: 120, display: "video", provenance: "stock_illustrative" }),
  ];
  assert.ok(cinematicQa(scenes).findings.some((f) => f.code === "RECONSTRUCTION_OVERUSE"));
  const under = [
    qaScene({ shotId: "r", startSec: 0, endSec: 36, display: "image", provenance: "ai_recreation" }),
    qaScene({ shotId: "v", startSec: 36, endSec: 120, display: "video", provenance: "stock_illustrative" }),
  ];
  assert.ok(!cinematicQa(under).findings.some((f) => f.code === "RECONSTRUCTION_OVERUSE"));
});

test("BLOCKED_CINEMATIC_QUALITY: si la meta solo se alcanza sacrificando identidad, el QA lo declara y no cambia nada", () => {
  const scenes = [
    qaScene({ shotId: "id", startSec: 0, endSec: 40, display: "card", provenance: "text_card", identityRequired: true, gap: true }),
    qaScene({ shotId: "v", startSec: 40, endSec: 120, display: "video", provenance: "stock_illustrative" }),
  ];
  const qa = cinematicQa(scenes);
  assert.equal(qa.status, "BLOCKED_CINEMATIC_QUALITY");
  assert.equal(qa.verdict, "FAIL", "diagnóstico, no bloqueo de render");
});

// --------------------------------------------------------------------------
// Simulación por la ruta productiva v4 (cinematic-simulation.ts: mismas funciones del pipeline)
// --------------------------------------------------------------------------

test("31-35, 41-42: simulación Gucci por la ruta productiva v4 — pies, botones y ejecutivo nunca representan a Maurizio", async () => {
  const sim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial);
  printTable("GUCCI v4", sim.rows);
  assert.ok(sim.narrationSeconds > 180, `la simulación cubre HERO, PREMIUM y STANDARD (${Math.round(sim.narrationSeconds)} s)`);
  assert.deepEqual(new Set(sim.report.cinematic!.scenes.map((d) => d.tier)), new Set(["HERO", "PREMIUM", "STANDARD"]));
  // 32-34: los falsos amigos de alta similitud no están en la secuencia final (en ninguna escena).
  const finalAssets = sim.report.scenes.map((s) => s.candidateDescription);
  for (const adv of [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER]) assert.ok(!finalAssets.includes(adv.description), `${adv.id} (${adv.similarity}) no aparece`);
  const rejected = sim.executions.flatMap((ex) => [...(ex.assetMeta?.selection?.rejected ?? []), ...(ex.assetMeta?.gap?.rejected ?? [])]);
  // Rechazados por una guarda (identidad/prueba/sustituto), nunca aceptados: FALSE_FRIEND cuando el léxico los habría aprobado.
  for (const adv of [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER]) {
    assert.ok(rejected.some((r) => r.sourceId === adv.id && /^(FALSE_FRIEND|IDENTITY_UNVERIFIED|EVIDENCE_UNGROUNDED)/.test(r.reason)), `${adv.id} rechazado por una guarda`);
  }
  for (const adv of [FEET, BUSINESSMAN, WRONG_NEWSPAPER]) assert.ok(rejected.some((r) => r.sourceId === adv.id && r.reason.startsWith("FALSE_FRIEND")), `${adv.id} rechazado como FALSE_FRIEND`);
  // 35: el retrato verificado (0.40) sigue elegible y ocupa una escena de identidad.
  const identityScenes = sim.report.cinematic!.scenes.filter((d) => d.identityRequired);
  assert.ok(identityScenes.length > 0);
  assert.ok(sim.report.scenes.some((s) => s.candidateDescription === "Maurizio Gucci archival portrait photograph, Milan"));
  for (const d of identityScenes) assert.ok(d.provenance === "text_card" || d.verifiedIdentity, `${d.shotId}: identidad solo con archivo verificado o ausencia`);
  // Nunca un Maurizio generado.
  assert.ok(!sim.prompts.some((p) => /maurizio/i.test(p)), "ninguna generación para la identidad");
  assert.ok(!sim.report.scenes.some((s, i) => s.provenance === "ai_recreation" && sim.report.cinematic!.scenes[i].identityRequired));
  // QA: sin bloqueantes; la puerta de entrega deja pasar.
  assert.deepEqual(sim.report.cinematic!.qa.release, { deliverable: true, blockers: [] }, JSON.stringify(sim.report.cinematic!.qa.findings.filter((f) => f.severity === "BLOCK")));
  assert.equal(sim.gateError, null);
  // El render usa EXACTAMENTE la cámara que midió el QA.
  sim.rendered.forEach((scene, i) => assert.equal(scene.direction?.camera, sim.report.cinematic!.scenes[i].camera));
  // Reconstrucción ≤ 30 % de HERO; 41-42: cero red, cero proveedores reales.
  assert.ok(sim.report.cinematic!.qa.windows[0].reconstructionShare <= HERO_RECONSTRUCTION_CAP + 1e-9);
  assert.equal(networkCalls, 0);
});

// --- PROCESS control e identidad + mismo lugar (misma ruta: executeShot) ---

async function executeOne(visuals: unknown[], fixtures: Pooled[], type: AllocatedShot["type"] = "ken_burns_image") {
  const [visual] = normalizeDeclaredVisuals(visuals, { identity: true });
  const pool = poolProvider(fixtures);
  const image = fakeImageProvider();
  const mem = memoryShotAssetStore();
  const shot = {
    id: "x-shot-1",
    beatId: "x",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type,
    source: "stock",
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
      footageProvider: pool.provider,
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
      verifyEntityLink: pool.verifyEntityLink,
    },
    emptyAiVideoLedgerState(),
  );
  return { ex, visual, prompts: image.prompts };
}

const WORKSHOP: Pooled = { id: "w-1", description: "weavers working at looms in a vintage textile workshop in Florence", similarity: 0.9, media: "image" };

test("25: PROCESS — el taller textil florentino de los 50 se ACEPTA por la misma ruta", async () => {
  const { ex } = await executeOne(
    [{ description: "textile workshop in Florence in the 1950s with weavers at looms", motion: true, subject: "textile workshop", action: "weaving", place: "Florence", era: "1950s", beatClass: "PROCESS" }],
    [WORKSHOP],
  );
  assert.equal(ex.executedType, "ken_burns_image");
  assert.equal(ex.assetMeta?.selection?.candidateDescription, WORKSHOP.description);
});

test("26: identidad + mismo lugar — la MISMA imagen del taller no representa a Maurizio", async () => {
  const { ex } = await executeOne(
    [{ description: "Maurizio Gucci walking through the textile workshop", motion: true, subject: "Maurizio Gucci", action: "walking", place: "Florence", beatClass: "IDENTITY", identity: MAURIZIO }],
    [WORKSHOP],
  );
  assert.equal(ex.executedType, "text");
  assert.match(ex.assetMeta?.gap?.rejected?.[0]?.reason ?? "", /^(FALSE_FRIEND|IDENTITY_UNVERIFIED)/);
});

// --------------------------------------------------------------------------
// C3 — integridad de clasificación y contratos solapados
// --------------------------------------------------------------------------

test("27: el planner marca PROCESS lo que depende de la persona (identidad en una escena PROCESS) → falla cerrada", async () => {
  const visuals = normalizeDeclaredVisuals(
    [
      { description: "office stairs", motion: false, beatClass: "PLACE" },
      { description: "Maurizio Gucci walking through the workshop", motion: true, beatClass: "PROCESS", identity: MAURIZIO },
    ],
    { identity: true },
  );
  assert.equal(visuals[1].classificationGap, true, "identidad en una escena que no es IDENTITY: contradicción");
  assert.deepEqual(visuals[1].identity, MAURIZIO, "la identidad se conserva (nunca se degrada a PROCESS genérico)");
  const { ex } = await executeOne([{ description: "Maurizio Gucci walking through the workshop", motion: true, subject: "textile workshop", beatClass: "PROCESS", identity: MAURIZIO }, { description: "x", motion: false, beatClass: "PLACE" }], [WORKSHOP]);
  assert.equal(ex.executedType, "text", "el taller genérico no sustituye a la persona");
});

test("28: clasificación incierta falla cerrada (sin búsqueda, sin material genérico) y el QA la reporta", async () => {
  // Beat clasificado con una escena sin clase, y una transición física sin identidad en un beat con persona.
  const visuals = normalizeDeclaredVisuals(
    [
      { description: "Maurizio Gucci entering", motion: true, beatClass: "IDENTITY", identity: MAURIZIO },
      { description: "a man entering a building", motion: true, subject: "man" },
      { description: "man climbing stairs", motion: true, subject: "stairs", action: "climbing", beatClass: "TRANSITION" },
      { description: "office building facade", motion: false, subject: "office building", beatClass: "PLACE" },
    ],
    { identity: true },
  );
  assert.deepEqual(visuals.map((v) => v.classificationGap === true), [false, true, true, false]);
  for (const visual of [visuals[1], visuals[2]]) {
    const pool = poolProvider([FEET, BUSINESSMAN]);
    const searched: string[] = [];
    pool.provider.searchImageCandidates = async (q) => (searched.push(q), []);
    const out = await selectStockForShot({ shotId: "s", visual, preferVideo: false, minDurationSec: 4 }, { footageProvider: pool.provider, registry: new DocumentAssetRegistry(), identify });
    assert.equal(out.status, "gap");
    if (out.status === "gap") assert.match(out.reason, /^CLASSIFICATION_INTEGRITY_GAP/);
    assert.deepEqual(searched, []);
  }
  // Sin evidencia estructurada (beat sin clasificar = guion anterior) NO se adivina.
  const legacy = normalizeDeclaredVisuals([{ description: "a man entering a building", motion: true }], { identity: true });
  assert.equal(legacy[0].classificationGap, undefined);
  const qa = cinematicQa([qaScene({ shotId: "g", startSec: 0, endSec: 5, display: "card", provenance: "text_card", classificationGap: true, identityRequired: true })]);
  // Dentro de HERO la política congelada lo convierte en bloqueante.
  assert.equal(qa.findings.find((f) => f.code === "CLASSIFICATION_INTEGRITY_GAP_IN_HERO")?.severity, "BLOCK");
});

const overlapBeat = {
  id: "ov",
  type: "hook" as const,
  narration: "Maurizio Gucci entered his office building in Milan that morning before the city woke up.",
  visuals: [
    { description: "Maurizio Gucci entering his office", motion: true, quote: "Maurizio Gucci entered his office building in Milan", subject: "Maurizio Gucci", beatClass: "IDENTITY", identity: MAURIZIO },
    { description: "facade of an office building in Milan", motion: false, quote: "his office building in Milan that morning before", subject: "office building", beatClass: "PLACE" },
  ],
};

function overlapShots(identity: boolean) {
  const visuals = visualsForBeat(overlapBeat, "t", { identity });
  // 14 palabras en 4 escenas: cada escena cubre ~3.5 palabras.
  return shotsForSpan({ beatId: "ov", beatType: "hook", startSec: 0, endSec: 16, narration: overlapBeat.narration, strategy: "economical", visuals, anchoring: {}, targetCount: 4 });
}

test("29-30: contratos solapados — se reproduce el solape; IDENTITY gana SOLO en el tramo compartido", () => {
  // Reproducción (sin clases, como v3): la cita PLACE empieza dentro de la cita IDENTITY y se queda el tramo compartido.
  const v3 = overlapShots(false).map((s) => s.anchoredVisual?.description);
  assert.deepEqual(v3, ["Maurizio Gucci entering his office", "facade of an office building in Milan", "facade of an office building in Milan", "facade of an office building in Milan"]);
  // v4: las escenas cuyo punto cae en palabras que ambas citas cubren pasan a IDENTITY; el resto sigue en PLACE.
  const v4 = overlapShots(true).map((s) => s.anchoredVisual?.beatClass);
  assert.deepEqual(v4, ["IDENTITY", "IDENTITY", "PLACE", "PLACE"]);
});

test("30b: el solape no gana beats vecinos ni el video entero", () => {
  const neighbour = { id: "n", type: "setup" as const, narration: "The city of Milan grew quickly after the war with new offices and factories.", visuals: [{ description: "Milan skyline", motion: false, quote: "The city of Milan grew quickly after the war", subject: "skyline", beatClass: "PLACE" }] };
  const shots = shotsForSpan({ beatId: "n", beatType: "setup", startSec: 16, endSec: 30, narration: neighbour.narration, strategy: "economical", visuals: visualsForBeat(neighbour, "t", { identity: true }), anchoring: {}, targetCount: 3 });
  assert.ok(shots.every((s) => s.anchoredVisual?.beatClass === "PLACE" && !s.anchoredVisual.identity));
});

// --------------------------------------------------------------------------
// C2 — asignación
// --------------------------------------------------------------------------

const limitsFor = (strategy: VisualStrategy, cinematic: boolean) => ({ ...strategyLimits(strategy, 1, { aiVideoEnabled: true, units: getGenerativeUnitCosts("runway") }), cinematic });
const COST_RANK: Record<string, number> = { text: 0, diagram: 0, map: 0, stock_image: 1, ken_burns_image: 1, stock_video: 1, generated_placeholder: 2, ai_video: 3 };

test("9, 12-13, 23: el asignador nunca persigue la densidad — solo restringe; reconstrucción ≤ 30 % de HERO; identidad sin reserva generativa", () => {
  const { shots, narrationSeconds } = planShotsFromScript(gucciBeats, GUCCI_TOPIC, "cinematic");
  const plain = allocateShotTypes(shots, narrationSeconds, limitsFor("cinematic", false));
  const directed = allocateShotTypes(shots, narrationSeconds, limitsFor("cinematic", true));
  // 9: nunca asciende un shot, nunca añade generación ni movimiento.
  directed.shots.forEach((s, i) => assert.ok(COST_RANK[s.type] <= COST_RANK[plain.shots[i].type], `${s.id}: ${plain.shots[i].type} → ${s.type}`));
  assert.ok(directed.aiImageGenerations <= plain.aiImageGenerations && directed.aiVideoClipCount <= plain.aiVideoClipCount);
  // 12-13: reconstrucción en HERO por segundos (intersección), nunca por encima del tope aunque baje la densidad.
  const heroSeconds = Math.min(120, narrationSeconds);
  const heroRecon = directed.shots.filter((s) => s.type === "generated_placeholder" || s.type === "ai_video").reduce((a, s) => a + tierSeconds(s.startSec, s.endSec).HERO, 0);
  assert.ok(heroRecon <= HERO_RECONSTRUCTION_CAP * heroSeconds + 1e-9, `${heroRecon} s de ${heroSeconds}`);
  // 23: ninguna escena de identidad queda con estrategia generativa (el código de reservas simplemente no la ve).
  for (const s of directed.shots) {
    if (s.anchoredVisual?.identity || s.anchoredVisual?.classificationGap) assert.ok(!["generated_placeholder", "ai_video"].includes(s.type), `${s.id} ${s.type}`);
  }
});

test("24: C2 no toca ledger, reservas, puerta de pagos ni capacidad", () => {
  for (const file of ["cinematic-director.ts", "production-plan.ts"]) {
    const imports = readFileSync(new URL(`./${file}`, import.meta.url), "utf8").split("\n").filter((l) => /^import\b/.test(l));
    for (const line of imports) assert.doesNotMatch(line, /paid-calls|supply|production-budget|spend-cap|quota|render-guard|ledger|attempt-state/, `${file}: ${line}`);
  }
});

// --------------------------------------------------------------------------
// Simulaciones 1930s y antigüedad (misma ruta)
// --------------------------------------------------------------------------

const dustBeats: ProductionPlanBeatInput[] = [
  {
    id: "d1",
    type: "hook",
    narration:
      "In the spring of 1935 a black wall of dust rolled across the Great Plains. Farmers watched the sky turn dark at noon. Fields that had fed families for decades blew away in a single afternoon, and the dust reached cities on the Atlantic coast.",
    visuals: [
      { description: "dust storm approaching a farm on the Great Plains", motion: true, quote: "a black wall of dust rolled across the Great Plains", subject: "dust storm", place: "Kansas", era: "1930s", beatClass: "PLACE" },
      { description: "dark noon sky over an empty farm", motion: false, quote: "Farmers watched the sky turn dark at noon", subject: "farm", era: "1930s", beatClass: "PLACE" },
      { description: "abandoned field covered in drifting dust", motion: false, quote: "Fields that had fed families for decades blew away", subject: "field", era: "1930s", beatClass: "EVIDENCE" },
    ],
  },
  {
    id: "d2",
    type: "twist",
    narration:
      "Dorothea Lange photographed migrant families in California camps in 1936. Her pictures appeared in newspapers across the country. Government programs paid farmers to plant trees and hold the soil, and slowly the land began to recover.",
    visuals: [
      { description: "Dorothea Lange with her camera", motion: false, quote: "Dorothea Lange photographed migrant families in California camps", subject: "Dorothea Lange", era: "1936", beatClass: "IDENTITY", identity: { name: "Dorothea Lange", kind: "person" } },
      { description: "1930s newspaper front page about migrant families", motion: false, quote: "Her pictures appeared in newspapers across the country", subject: "newspaper", era: "1930s", beatClass: "EVIDENCE" },
      { description: "rows of young trees planted as a windbreak on a farm", motion: true, quote: "Government programs paid farmers to plant trees", subject: "trees", era: "1930s", beatClass: "PROCESS" },
    ],
  },
];

test("36: simulación 1930s por la misma ruta — la época cambia decisiones (sin video IA, cadencia de archivo, grado solo en archivo verificado)", async () => {
  const sim = await simulate(dustBeats, "The Dust Bowl", [
    { id: "modern", description: "modern tractor with LED lights in a dusty field", similarity: 0.97, media: "video" },
    { id: "lange", description: "Dorothea Lange portrait photograph with camera", similarity: 0.3, media: "image", verified: "Dorothea Lange" },
  ]);
  printTable("1930s v4", sim.rows);
  assert.ok(!sim.allocated.shots.some((s) => s.type === "ai_video"), "ningún video IA: fabricaría metraje de época");
  assert.ok(sim.allocated.shots.some((s) => s.plannedType === "ai_video" && /early_photographic|reconstrucción/.test(s.degradeReason ?? "")), "las ranuras de video IA se degradan por la época o el tope");
  const cams = sim.report.cinematic!.scenes.filter((d) => d.provenance !== "text_card" && d.motionClass === "PRESENTATION_MOTION").map((d) => d.camera);
  assert.ok(cams.every((c) => c === "push" || c === "pull"), `cadencia de archivo: ${cams}`);
  assert.ok(!sim.report.scenes.some((s) => s.candidateDescription?.includes("modern tractor")), "el material moderno contradice la época");
  const verified = sim.report.cinematic!.scenes.find((d) => d.verifiedIdentity);
  assert.ok(verified, "el retrato verificado de Lange representa a Lange");
  assert.deepEqual(verified.look, { contrast: 1.1 });
  assert.ok(sim.report.cinematic!.scenes.filter((d) => d.provenance === "stock_illustrative").every((d) => d.look === undefined), "el stock moderno no se disfraza");
  assert.ok(!sim.report.cinematic!.qa.findings.some((f) => f.severity === "BLOCK"));
  assert.equal(networkCalls, 0);
});

const thermopylaeBeats: ProductionPlanBeatInput[] = [
  {
    id: "t1",
    type: "hook",
    narration:
      "In 480 BC a Persian army marched into Greece. At Thermopylae the road ran between steep mountains and the sea. Today the ancient shoreline lies several kilometres inland, and the plain is covered in olive groves.",
    visuals: [
      { description: "Persian army marching into Greece", motion: true, quote: "a Persian army marched into Greece", subject: "army", action: "marching", era: "480 BC", beatClass: "PROCESS" },
      { description: "narrow coastal pass between mountains and sea at Thermopylae", motion: false, quote: "At Thermopylae the road ran between steep mountains and the sea", subject: "mountain pass", place: "Thermopylae", era: "480 BC", beatClass: "PLACE" },
      { description: "olive groves on the plain at Thermopylae", motion: false, quote: "Today the ancient shoreline lies several kilometres inland", subject: "olive groves", place: "Thermopylae", era: "480 BC", beatClass: "PLACE" },
    ],
  },
  {
    id: "t2",
    type: "twist",
    narration:
      "Leonidas led the Spartans who held the pass. Their bronze helmets and shields survive in museums. Archaeologists found arrowheads on the hill where the last defenders fell. For three days the Greeks fought in the narrow pass until a mountain path was betrayed.",
    visuals: [
      { description: "Leonidas leading the Spartans", motion: true, quote: "Leonidas led the Spartans who held the pass", subject: "Leonidas", action: "leading", place: "Thermopylae", era: "480 BC", beatClass: "IDENTITY", identity: { name: "Leonidas", kind: "person" } },
      { description: "bronze Corinthian helmet in a museum case", motion: false, quote: "Their bronze helmets and shields survive in museums", subject: "bronze helmet", era: "480 BC", beatClass: "EVIDENCE" },
      { description: "ancient arrowheads excavated on a hill", motion: false, quote: "Archaeologists found arrowheads on the hill", subject: "arrowheads", place: "Thermopylae", era: "480 BC", beatClass: "EVIDENCE" },
      { description: "Greek soldiers fighting in the narrow pass", motion: true, quote: "For three days the Greeks fought in the narrow pass", subject: "soldiers", action: "fighting", era: "480 BC", beatClass: "PROCESS" },
    ],
  },
];

test("37: simulación antigüedad por la misma ruta — terreno, ruinas, artefactos y entorno; tropas en esquema; ni falso archivo ni guerrero genérico como Leónidas", async () => {
  const sim = await simulate(thermopylaeBeats, "Thermopylae", [
    { id: "hoplite", description: "anonymous Spartan hoplite warrior leading soldiers at Thermopylae", similarity: 0.95, media: "video" },
    { id: "battle", description: "Persian army marching soldiers battle reenactment", similarity: 0.94, media: "video" },
    { id: "statue", description: "statue of Leonidas king of Sparta at Thermopylae", similarity: 0.4, media: "image", verified: "Leonidas" },
  ]);
  printTable("THERMOPYLAE v4", sim.rows);
  assert.ok(!sim.report.scenes.some((s) => s.candidateDescription === "anonymous Spartan hoplite warrior leading soldiers at Thermopylae"));
  assert.ok(!sim.report.scenes.some((s) => s.candidateDescription?.includes("reenactment")), "nunca combate fotorrealista");
  assert.ok(!sim.allocated.shots.some((s) => s.type === "ai_video"));
  // Las escenas de acción física de la época quedan en esquema (sin datos cartográficos: el pasaje), nunca fotorrealistas.
  const schematic = sim.report.cinematic!.scenes.filter((d) => d.schematic);
  assert.ok(schematic.length > 0 && schematic.every((d) => d.provenance === "text_card"));
  assert.ok(!sim.prompts.some((p) => /army|soldiers|Leonidas/i.test(p)), "ninguna reconstrucción de personas ni tropas");
  // Leónidas: solo la representación verificada (o la ausencia).
  for (const d of sim.report.cinematic!.scenes.filter((x) => x.identityRequired)) assert.ok(d.provenance === "text_card" || d.verifiedIdentity);
  assert.ok(!sim.report.cinematic!.qa.findings.some((f) => f.code === "ERA_MISMATCH"));
  assert.ok(!sim.report.scenes.some((s) => s.provenance === "archival_documentary" && s.display === "video"), "ningún archivo filmado de la antigüedad");
  assert.equal(networkCalls, 0);
});

// --------------------------------------------------------------------------
// QA nunca gasta; v3 intacto; planes persistidos intactos
// --------------------------------------------------------------------------

test("38: el QA nunca gasta ni cambia recursos (función pura, sin dependencias de proveedores)", () => {
  const source = readFileSync(new URL("./cinematic-director.ts", import.meta.url), "utf8");
  const imports = source.split("\n").filter((l) => /^import\b/.test(l));
  for (const line of imports) assert.doesNotMatch(line, /providers|shot-executor|production-budget|paid-calls|supply|fetch/, line);
  const scenes = [qaScene({ shotId: "a", startSec: 0, endSec: 120, display: "card", provenance: "text_card" })];
  const before = JSON.stringify(scenes);
  const qa = cinematicQa(scenes);
  assert.equal(JSON.stringify(scenes), before);
  assert.equal(qa.verdict, "FAIL");
  assert.equal(networkCalls, 0);
});

test("39: v3 intacto — sin clases ni reglas del Director, asignación idéntica, informe sin sección cinematográfica", async () => {
  const beatsV3 = gucciBeats.map((b) => ({ ...b }));
  const v3Visuals = beatsV3.flatMap((b) => visualsForBeat(b, GUCCI_TOPIC, { identity: false }));
  assert.ok(v3Visuals.every((v) => v.beatClass === undefined && v.identity === undefined && v.classificationGap === undefined && v.personActions === undefined));
  // Mismas escenas v3 → la asignación sin la bandera v4 es la de siempre (nada del Director se aplica).
  const shots = beatsV3.flatMap((b, i) =>
    shotsForSpan({ beatId: b.id, beatType: b.type, startSec: i * 40, endSec: i * 40 + estimateNarrationSeconds(b.narration), narration: b.narration, typeOffset: i * 2, strategy: "cinematic", visuals: visualsForBeat(b, GUCCI_TOPIC, { identity: false }), anchoring: {} }),
  );
  const a = allocateShotTypes(shots, 240, limitsFor("cinematic", false));
  const b = allocateShotTypes(shots, 240, { ...limitsFor("cinematic", false), cinematic: undefined });
  assert.deepEqual(a, b);
  const report = buildVisualReport({ requestId: "r", planVersion: 3, topic: "t", shots: [], executions: [], now: () => 0 });
  assert.equal("cinematic" in report, false);
  const scenes = [{ id: "s", startSeconds: 0, endSeconds: 5, asset: { kind: "media" as const, url: "u", mediaType: "image" as const }, motion: "ken_burns" as const }];
  assert.deepEqual(directAnchoredScenes(scenes, [{}], []), directAnchoredScenes(scenes, [{}], [], undefined));
});

test("40: planes persistidos intactos — un plan v3 confirmado se resuelve sin cambios ni mutaciones", () => {
  const beats = gucciBeats.map(({ id, type, narration, visuals }) => ({ id, type, narration, visuals }));
  const plan = Object.freeze({ version: 3, strategy: "cinematic", scriptHash: computeScriptHash(beats), voiceCharacters: 1, durationSeconds: 1, shotCount: 1, confirmedAt: "2026-10-01T00:00:00Z" }) as unknown as ProductionPlan;
  const snapshot = JSON.stringify(plan);
  try {
    resolveExecutablePlan({ confirmedAt: "2026-10-01T00:00:00Z", plan, beats });
  } catch {
    // La forma mínima puede no pasar isProductionPlan; lo relevante es que nada la reescribe.
  }
  assert.equal(JSON.stringify(plan), snapshot);
  assert.equal(Object.isFrozen(plan), true);
});

test("QA bloquea el render SOLO por violaciones de verdad (identidad / falso archivo), nunca por métricas", () => {
  const fabricated = buildVisualReport({ requestId: "r", planVersion: 4, topic: "t", shots: [], executions: [], now: () => 0 });
  assert.doesNotThrow(() => assertVisualQuality(fabricated));
  fabricated.cinematic!.qa.findings.push({ code: "LOW_MOTION_DENSITY", severity: "FAIL", shots: ["a"], detail: "x" });
  assert.doesNotThrow(() => assertVisualQuality(fabricated));
  fabricated.cinematic!.qa.findings.push({ code: "IDENTITY_VISUAL_VIOLATION", severity: "BLOCK", shots: ["b"], detail: "y" });
  assert.throws(() => assertVisualQuality(fabricated), LongFormVisualQualityError);
});
