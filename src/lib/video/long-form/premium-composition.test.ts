import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CAMERA_MAX_SCALE,
  DOCUMENT_MAX_ZOOM,
  OPENING_MAX_SCALE,
  cameraTransform,
  documentFrame,
  documentLayout,
  documentStops,
  easedProgress,
  kenBurnsTransform,
  lookStyle,
  prepareCuratedSvg,
  safeAreas,
  svgRevealState,
  validateDirection,
  type DocumentDirection,
} from "../../../../remotion/long-form-direction";
import { DocumentAssetRegistry } from "./asset-identity";
import { directCinematic, RENDERER_CAPABILITIES, type DirectorInput } from "./cinematic-director";
import { executeShot, type ShotExecution } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, type AllocatedShot } from "./production-plan";
import { directAnchoredScenes } from "./produce";
import { buildVisualReport, assertVisualQuality } from "./visual-report";
import { curatedSvgGraphic } from "./premium-composition";
import { VerifiedAssetRegistry } from "./verified-assets";
import type { BeatVisual } from "./visual-intents";
import { WRONG_NEWSPAPER, identify, poolProvider } from "./cinematic-simulation";
import {
  DOCUMENT_REGIONS,
  DOCUMENT_SIZE,
  FIXTURE_DOCUMENT_VISUAL,
  FIXTURE_PERSON_VISUAL,
  FIXTURE_SCHEMATIC_VISUAL,
  premiumAssets,
  premiumRegistry,
  schematicSvg,
} from "./premium-fixtures";

/**
 * Premium Composition V1: primitivas COMPARTIDAS del renderer (cámara con
 * aceleración, documento con regiones curadas, dos looks, revelado de SVG
 * curado, zonas seguras 16:9/9:16). Verdad primero, presentación después.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("premium composition: red prohibida");
}) as typeof fetch;

const BASE = "http://127.0.0.1:0/fixtures";
const A = premiumAssets(BASE);
const scaleOf = (css: string) => Number(/scale\(([\d.]+)\)/.exec(css)?.[1] ?? 1);

// --------------------------------------------------------------------------
// Gate 1 — una cámara compartida, con ease-in-out y los mismos topes
// --------------------------------------------------------------------------

test("cámara: curva NO lineal (inicio/medio/fin) y simétrica", () => {
  assert.equal(easedProgress(0), 0);
  assert.ok(Math.abs(easedProgress(0.5) - 0.5) < 1e-9);
  assert.equal(easedProgress(1), 1);
  assert.ok(easedProgress(0.1) < 0.1 / 2, `arranque lento (${easedProgress(0.1)})`);
  assert.ok(easedProgress(0.9) > 1 - 0.1 / 2, `aterrizaje lento (${easedProgress(0.9)})`);
  assert.ok(Math.abs(easedProgress(0.25) + easedProgress(0.75) - 1) < 1e-9, "simétrica");
  // La velocidad es máxima en el centro (no constante como antes).
  const v = (p: number) => easedProgress(p + 0.01) - easedProgress(p);
  assert.ok(v(0.495) > v(0.05) * 5);
  assert.deepEqual([0, 0.5, 1].map((p) => scaleOf(cameraTransform("push", p))), [1, 1.04, 1.08]);
});

test("cámara: topes existentes intactos — 1.08 normal, 1.16 solo en la apertura", () => {
  assert.equal(CAMERA_MAX_SCALE, 1.08);
  assert.equal(OPENING_MAX_SCALE, 1.16);
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    for (const cam of ["push", "pull", "left", "right"] as const) assert.ok(scaleOf(cameraTransform(cam, p)) <= CAMERA_MAX_SCALE + 1e-9, `${cam}@${p}`);
    assert.ok(kenBurnsTransform(p, false).scale <= CAMERA_MAX_SCALE + 1e-9);
    assert.ok(kenBurnsTransform(p, true).scale <= OPENING_MAX_SCALE + 1e-9);
  }
  assert.equal(kenBurnsTransform(1, false).scale, CAMERA_MAX_SCALE);
  assert.equal(kenBurnsTransform(0.4, true).scale, OPENING_MAX_SCALE);
  assert.equal(cameraTransform("still", 0.5), "none");
});

// --------------------------------------------------------------------------
// Gate 2 — documento verificado con regiones CURADAS
// --------------------------------------------------------------------------

const DOC: DocumentDirection = { regions: DOCUMENT_REGIONS, sourceWidth: DOCUMENT_SIZE.width, sourceHeight: DOCUMENT_SIZE.height };

test("documento: página completa → titular → fecha → salida; sin regiones inventadas", () => {
  const f = (p: number) => documentFrame(DOC, p, 1920, 1080);
  assert.equal(f(0).phase, "full");
  assert.equal(f(0).scale, 1);
  assert.equal(f(0.45).phase, "headline");
  assert.equal(f(0.76).phase, "date");
  assert.equal(f(1).scale, 1, "termina en la página completa");
  assert.ok(f(0.45).focus && f(0.45).dim > 0);
  // El titular queda centrado en el cuadro.
  const focus = f(0.45).focus!;
  assert.ok(Math.abs(focus.x + focus.w / 2 - 960) < 1 && Math.abs(focus.y + focus.h / 2 - 540) < 1);
  // Solo existen las regiones curadas: con solo "detail" no aparece ni titular ni fecha.
  assert.deepEqual(documentStops({ ...DOC, regions: [DOCUMENT_REGIONS[2]] }).map((r) => r.label), ["detail"]);
  assert.deepEqual(documentStops({ ...DOC, regions: [] }), []);
  assert.equal(documentFrame({ ...DOC, regions: [] }, 0.5, 1920, 1080).scale, 1);
});

test("documento: el zoom nunca supera 1.5 ni la resolución nativa (1280 px no recibe más zoom)", () => {
  for (const [w, h, frameW, frameH] of [[1800, 2400, 1920, 1080], [1280, 853, 1920, 1080], [1800, 2400, 1080, 1920], [4000, 3000, 1920, 1080]]) {
    const doc = { ...DOC, sourceWidth: w, sourceHeight: h };
    const L = documentLayout(doc, frameW, frameH);
    for (let i = 0; i <= 50; i++) {
      const fr = documentFrame(doc, i / 50, frameW, frameH);
      assert.ok(fr.scale <= DOCUMENT_MAX_ZOOM + 1e-9);
      assert.ok(fr.scale === 1 || fr.scale * L.s <= 1 + 1e-9, `${w}×${h}: nunca más allá de 1:1 (${fr.scale}·${L.s})`);
    }
  }
  assert.equal(documentLayout({ ...DOC, sourceWidth: 1280, sourceHeight: 853 }, 1920, 1080).maxZoom, 1, "una imagen ya ampliada no se amplía más");
});

const director = (over: Partial<DirectorInput>) =>
  directCinematic([{ startSec: 0, endSec: 9, durationSec: 9, executedType: "ken_burns_image", kind: "image", provenance: "archival_documentary", visual: FIXTURE_DOCUMENT_VISUAL, evidenceLink: { sourceIds: ["fixture-src-1"] }, documentRegions: DOCUMENT_REGIONS, sourceSize: DOCUMENT_SIZE, ...over }])[0];

test("documento: solo prueba VERIFICADA + regiones curadas; sin regiones → cámara normal; nunca en retratos, stock ni IA", () => {
  const ok = director({});
  assert.ok(ok.document && ok.executed.includes("document_animation"));
  assert.equal(RENDERER_CAPABILITIES.document_animation, "SUPPORTED_NOW");
  const noRegions = director({ documentRegions: undefined });
  assert.equal(noRegions.document, undefined);
  assert.equal(noRegions.camera, "push", "tratamiento normal con cámara suave");
  assert.equal(director({ documentRegions: [{ label: "subject", x: 0, y: 0, w: 0.5, h: 0.5 }] }).document, undefined, "V1: solo headline/date/detail");
  assert.equal(director({ evidenceLink: undefined }).document, undefined, "sin vínculo de prueba verificado");
  assert.equal(director({ provenance: "stock_illustrative" }).document, undefined);
  assert.equal(director({ provenance: "ai_recreation" }).document, undefined);
  assert.equal(director({ visual: FIXTURE_PERSON_VISUAL, evidenceLink: undefined, entityLink: { name: "Fixture Person" } }).document, undefined, "un retrato no es un documento");
  assert.equal(director({ kind: "video" }).document, undefined);
  // El renderer también lo exige (defensa en profundidad).
  const scene = (provenance: string, mediaType = "image") => [{ id: "d", startSeconds: 0, endSeconds: 9, provenance, asset: { kind: "media", mediaType }, direction: { document: DOC } }];
  assert.doesNotThrow(() => validateDirection(scene("archival_documentary"), undefined, 9));
  for (const bad of [scene("stock_illustrative"), scene("ai_recreation"), scene("archival_documentary", "video")]) assert.throws(() => validateDirection(bad, undefined, 9));
  assert.throws(() => validateDirection([{ ...scene("archival_documentary")[0], direction: { document: { ...DOC, regions: [{ label: "headline", x: 0.8, y: 0, w: 0.5, h: 0.1 }] } } }], undefined, 9));
});

function shotFor(id: string, visual: BeatVisual, startSec: number): AllocatedShot {
  return { id, beatId: "b", startSec, endSec: startSec + 9, durationSec: 9, type: "ken_burns_image", source: "stock", assetId: id, visualIntent: visual.description, motion: "ken_burns", captionText: "", narrationFragment: "", anchoredVisual: visual, license: "resolved-at-execution", attribution: "", dedupKey: id, status: "planned", validationStatus: "pending", plannedType: "ken_burns_image" } as AllocatedShot;
}

async function execute(shots: AllocatedShot[], registry: VerifiedAssetRegistry) {
  const deps = {
    topic: "t",
    footageProvider: poolProvider([WRONG_NEWSPAPER]).provider,
    imageProvider: { name: "fixture", capabilities: { id: "f", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 }, isAvailable: () => true, generateImage: async () => { throw new Error("sin IA"); } },
    store: memoryShotAssetStore().store,
    budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 }),
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: 60,
    requireReal: false,
    visualPipeline: "anchored_v1" as const,
    registry: new DocumentAssetRegistry(),
    identify,
    verifiedAssets: registry,
  };
  const executions: ShotExecution[] = [];
  for (const shot of shots) executions.push(await executeShot(shot, deps as never, emptyAiVideoLedgerState()));
  return executions;
}

test("documento por la ruta real: registro verificado → ejecutor → Director → escena del renderer; el periódico equivocado sigue rechazado", async () => {
  const registry = premiumRegistry([{ asset: A.document, visual: FIXTURE_DOCUMENT_VISUAL }]);
  const shots = [shotFor("d1", FIXTURE_DOCUMENT_VISUAL, 0), shotFor("d2", { ...FIXTURE_DOCUMENT_VISUAL, description: "the same front page again" }, 9)];
  const executions = await execute(shots, registry);
  assert.deepEqual(executions[0].assetMeta?.provenance?.regions, DOCUMENT_REGIONS, "las regiones salen del registro verificado");
  assert.match(executions[0].assetMeta?.selection?.rejected?.find((r) => r.sourceId === WRONG_NEWSPAPER.id)?.reason ?? "", /^FALSE_FRIEND/);
  // Reutilización: solo bajo verified_evidence_reuse, justificada en el informe.
  assert.deepEqual(executions[1].assetMeta?.selection?.reuse, { of: "d1", justification: "verified_evidence_reuse" });
  const report = buildVisualReport({ requestId: "r", planVersion: 4, topic: "t", shots, executions, now: () => 0 });
  assert.equal(report.summary.repeatedAssets[0]?.justification, "verified_evidence_reuse");
  assert.doesNotThrow(() => assertVisualQuality(report));
  const [d1, d2] = report.cinematic!.scenes;
  assert.ok(d1.document && d2.document);
  assert.equal(d1.look?.preset, "documentary_1990s", "1995: color documental");
  const scenes = directAnchoredScenes(shots.map((s, i) => ({ id: s.id, startSeconds: s.startSec, endSeconds: s.endSec, asset: executions[i].asset as never, motion: "ken_burns" as const })), executions, [], report.cinematic!.scenes);
  assert.deepEqual(scenes[0].direction?.document?.regions, DOCUMENT_REGIONS);
  assert.doesNotThrow(() => validateDirection(scenes, undefined, 18));
  // Sin regiones curadas: el mismo documento NO se anima.
  const plain = premiumRegistry([{ asset: A.documentNoRegions, visual: FIXTURE_DOCUMENT_VISUAL }]);
  const [ex] = await execute([shotFor("p1", FIXTURE_DOCUMENT_VISUAL, 0)], plain);
  const plainReport = buildVisualReport({ requestId: "r", planVersion: 4, topic: "t", shots: [shotFor("p1", FIXTURE_DOCUMENT_VISUAL, 0)], executions: [ex], now: () => 0 });
  assert.equal(plainReport.cinematic!.scenes[0].document, undefined);
  assert.equal(plainReport.cinematic!.scenes[0].camera, "push");
});

test("documento: una prueba aprobada para OTRA proposición no se anima en esta escena (verdad primero)", async () => {
  const other = { ...FIXTURE_DOCUMENT_VISUAL, evidence: { sourceIds: ["fixture-src-9"] }, quote: "another proposition" };
  const registry = premiumRegistry([{ asset: A.document, visual: other }]);
  const [ex] = await execute([shotFor("x", FIXTURE_DOCUMENT_VISUAL, 0)], registry);
  assert.equal(ex.executedType, "text", "sin prueba verificada: tarjeta, nunca el documento animado");
  assert.equal(ex.assetMeta?.provenance?.regions, undefined);
});

// --------------------------------------------------------------------------
// Gate 3 — dos looks; monocromo explícito y acotado
// --------------------------------------------------------------------------

test("looks: 1990s sigue en COLOR; mono solo con su preset; el límite global de saturación no cambia", () => {
  const nineties = lookStyle({ preset: "documentary_1990s" }, "none");
  assert.equal(nineties.filter, "contrast(1.06) saturate(0.9)");
  assert.doesNotMatch(nineties.filter!, /sepia|grayscale/);
  assert.equal(lookStyle({ preset: "schematic_mono" }, "none").filter, "contrast(1.08) saturate(0)");
  assert.equal(lookStyle({ preset: "schematic_mono", saturation: 1.2 }, "none").filter, "contrast(1.08) saturate(0)", "el preset mono no se puede reabrir");
  type Asset = { kind: string; mediaType?: string; graphic?: { kind: string } };
  const scene = (look: object, provenance = "archival_documentary", asset: Asset = { kind: "media", mediaType: "image" }) => [{ id: "s", startSeconds: 0, endSeconds: 4, provenance, asset, direction: { look: look as never } }];
  for (const saturation of [0, 0.3, 0.59]) assert.throws(() => validateDirection(scene({ saturation }), undefined, 4), `saturación ${saturation} sin preset`);
  assert.doesNotThrow(() => validateDirection(scene({ preset: "schematic_mono" }), undefined, 4));
  assert.doesNotThrow(() => validateDirection(scene({ preset: "schematic_mono" }, "", { kind: "graphic", graphic: { kind: "curated_svg" } }), undefined, 4), "esquema SVG curado");
  for (const provenance of ["stock_illustrative", "ai_recreation", ""]) {
    assert.throws(() => validateDirection(scene({ preset: "schematic_mono" }, provenance), undefined, 4), `mono sobre ${provenance || "sin procedencia"}`);
    assert.throws(() => validateDirection(scene({ preset: "documentary_1990s" }, provenance), undefined, 4), `1990s sobre ${provenance || "sin procedencia"}`);
  }
  assert.throws(() => validateDirection(scene({ preset: "vhs" }), undefined, 4), "no hay más presets");
});

test("looks del Director: 1990s color sobre archivo verificado; mono solo en la época fotográfica temprana; la antigüedad nunca finge archivo filmado", () => {
  const d = (era: string, provenance: DirectorInput["provenance"], kind: DirectorInput["kind"] = "image", beatClass = "PLACE") =>
    directCinematic([{ startSec: 0, endSec: 5, durationSec: 5, executedType: kind === "video" ? "ai_video" : kind === "graphic" ? "text" : "ken_burns_image", kind, provenance, visual: { description: "x", motion: false, era, beatClass: beatClass as never } }])[0];
  assert.equal(d("1995", "archival_documentary").look?.preset, "documentary_1990s");
  assert.equal(d("1930s", "archival_documentary").look?.preset, "schematic_mono");
  for (const [era, prov, kind] of [["480 BC", "ai_recreation", "image"], ["480 BC", "ai_recreation", "video"], ["480 BC", "stock_illustrative", "image"], ["480 BC", undefined, "graphic"], ["1930s", "stock_illustrative", "image"], ["1930s", "ai_recreation", "video"], ["1995", "stock_illustrative", "image"]] as const) {
    assert.equal(d(era, prov, kind).look?.preset, undefined, `${era}/${prov}/${kind}: sin look de época`);
  }
  assert.equal(RENDERER_CAPABILITIES["grade:period_color"], "SUPPORTED_NOW");
  assert.equal(RENDERER_CAPABILITIES.parallax, "PLANNED_NOT_SUPPORTED");
  assert.equal(RENDERER_CAPABILITIES.map_animation, "PLANNED_NOT_SUPPORTED");
});

// --------------------------------------------------------------------------
// Gate 4 — revelado de SVG CURADO (un trazo + una etiqueta existentes)
// --------------------------------------------------------------------------

test("SVG: solo se revelan el trazo y la etiqueta que YA existen; contenido activo o ids ausentes → sin animación", () => {
  const svg = prepareCuratedSvg(schematicSvg(), { pathId: "route", labelId: "route-label" })!;
  assert.ok(svg);
  assert.equal(svg.viewBox, "0 0 1920 1080");
  assert.match(svg.path.d, /^M440 700/);
  assert.equal(svg.label.text, "Route (fixture)");
  assert.doesNotMatch(svg.baseMarkup, /id="route"|id="route-label"/, "la base no los contiene (no se duplican)");
  assert.equal(prepareCuratedSvg(schematicSvg(), { pathId: "troops", labelId: "route-label" }), null, "no se inventa geometría");
  assert.equal(prepareCuratedSvg(schematicSvg(), { pathId: "route", labelId: "nope" }), null);
  for (const evil of ["<script>x</script>", '<rect onload="x"/>', '<image href="x"/>', "<foreignObject/>", '<rect style="fill:url(#x)"/>']) {
    assert.equal(prepareCuratedSvg(schematicSvg().replace("</svg>", `${evil}</svg>`), { pathId: "route", labelId: "route-label" }), null, evil);
  }
  assert.deepEqual(svgRevealState(0), { pathDrawn: 0, labelOpacity: 0 });
  const mid = svgRevealState(0.375);
  assert.ok(Math.abs(mid.pathDrawn - 0.5) < 1e-9 && mid.labelOpacity === 0);
  assert.deepEqual(svgRevealState(1), { pathDrawn: 1, labelOpacity: 1 });
});

test("SVG: exige un registro de CONFIANZA (rehidratado) con MIME SVG, ids aprobados y contenido intacto", () => {
  const sha = createHash("sha256").update(schematicSvg()).digest("hex");
  const registry = premiumRegistry([{ asset: { ...A.schematic, contentSha256: sha }, visual: FIXTURE_SCHEMATIC_VISUAL }]);
  const [record] = registry.recordsFor(FIXTURE_SCHEMATIC_VISUAL);
  assert.ok(curatedSvgGraphic(record, schematicSvg()));
  assert.equal(curatedSvgGraphic(JSON.parse(JSON.stringify(record)), schematicSvg()), null, "una copia/JSON no es de confianza");
  assert.equal(curatedSvgGraphic({ ...record }, schematicSvg()), null);
  assert.equal(curatedSvgGraphic(record, schematicSvg().replace("Route (fixture)", "Invented troops")), null, "contenido distinto del aprobado");
  assert.equal(curatedSvgGraphic(null, schematicSvg()), null, "sin SVG aprobado no hay animación");
  const noReveal = premiumRegistry([{ asset: { ...A.schematic, svgReveal: undefined }, visual: FIXTURE_SCHEMATIC_VISUAL }]).recordsFor(FIXTURE_SCHEMATIC_VISUAL)[0];
  assert.equal(curatedSvgGraphic(noReveal, schematicSvg()), null, "sin ids aprobados no hay animación");
  assert.equal(networkCalls, 0);
});

// --------------------------------------------------------------------------
// Gate 5 — la misma composición en 9:16
// --------------------------------------------------------------------------

test("zonas seguras: 16:9 exactamente como antes; 9:16 despeja la interfaz de la plataforma sin asumir 16:9", () => {
  assert.deepEqual(safeAreas(1920, 1080), { top: 44, side: 56, bottom: 120, captionMaxWidth: 1400, captionFontSize: 46, labelFontSize: 28 });
  const v = safeAreas(1080, 1920);
  assert.ok(v.bottom >= 0.18 * 1920 && v.top >= 0.08 * 1920, JSON.stringify(v));
  assert.ok(v.captionMaxWidth <= 1080 - 2 * v.side && v.side >= 0.06 * 1080);
  assert.ok(v.labelFontSize >= 30 && v.captionFontSize >= 48, "legibles en móvil");
  // El documento también se reparte en vertical (contain): la página completa cabe en el cuadro.
  const L = documentLayout(DOC, 1080, 1920);
  assert.ok(L.x >= 0 && L.y >= 0 && L.w <= 1080 + 1e-9 && L.h <= 1920 + 1e-9);
});
