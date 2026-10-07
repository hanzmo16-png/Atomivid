import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { commonsQueryFor, proposalFromCommonsPage, searchCommonsProposals, type CommonsPage } from "@/lib/providers/footage/commons";
import { SceneLabels, type LongFormShotScene } from "../../../../remotion/LongFormDoc";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot } from "./stock-selection";
import { executeShot, type ShotExecution } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, planShotsFromScript, type AllocatedShot, type ProductionPlan } from "./production-plan";
import { directAnchoredScenes, MAX_TEXT_FALLBACK_RATIO } from "./produce";
import { assertVisualQuality, buildVisualReport } from "./visual-report";
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";
import {
  assetFromProposal,
  contractForVisual,
  contractKey,
  heroCoverage,
  licenseEligibility,
  qualityEligibility,
  validateAsset,
  VerifiedAssetRegistry,
  type AssetProposal,
  type CuratableAsset,
} from "./verified-assets";
import { proposeAsset, emptyCurationFile } from "./asset-curation";
import {
  BELLBOY,
  BUSINESSMAN,
  FEET,
  GUCCI_TOPIC,
  MAURIZIO,
  MAURIZIO_KEY,
  WRONG_NEWSPAPER,
  gucciAdversarial,
  gucciBeats,
  curateFixture,
  fixturePolicy,
  gucciRegistry,
  gucciRegistryDecoys,
  gucciRequested,
  gucciVerifiedAssets,
  rehydrateFixture,
  requestedFor,
  identify,
  planFor,
  poolProvider,
  produceOffline,
  simulate,
  type Pooled,
} from "./cinematic-simulation";

/**
 * Verified Asset Foundation — LEGAL + AUTHENTIC + RELEVANT + QUALITY como
 * condiciones independientes. Commons propone; nunca aprueba. Todo offline:
 * Commons se simula con `fetchImpl` falso; la red real está bloqueada.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("verified assets: red prohibida en las pruebas");
}) as typeof fetch;

const MAURIZIO_VISUAL = normalizeDeclaredVisuals(
  [{ description: "Maurizio Gucci at his wedding", motion: false, subject: "Maurizio Gucci", era: "1972", beatClass: "IDENTITY", identity: MAURIZIO }],
  { identity: true },
)[0];

function commonsPage(over: { title?: string; width?: number; height?: number; mime?: string; license?: string; shortName?: string; restrictions?: string; artist?: string; description?: string; categories?: string }): CommonsPage {
  const meta: Record<string, { value: string }> = {};
  if (over.license !== undefined) meta.License = { value: over.license };
  if (over.shortName !== undefined) meta.LicenseShortName = { value: over.shortName };
  if (over.restrictions) meta.Restrictions = { value: over.restrictions };
  meta.Artist = { value: over.artist ?? "<a href='x'>Foto Studio</a>" };
  meta.ImageDescription = { value: over.description ?? "Maurizio Gucci and Patrizia Reggiani at their wedding" };
  meta.Categories = { value: over.categories ?? "Maurizio Gucci|Weddings in Italy" };
  meta.LicenseUrl = { value: "https://creativecommons.org/licenses/by/4.0" };
  return {
    title: over.title ?? "File:Maurizio Gucci wedding 1972.jpg",
    imageinfo: [{ url: `https://upload.wikimedia.org/${encodeURIComponent(over.title ?? "wedding")}.jpg`, descriptionurl: "https://commons.wikimedia.org/wiki/File:Wedding.jpg", width: over.width ?? 2400, height: over.height ?? 1600, mime: over.mime ?? "image/jpeg", extmetadata: meta }],
  };
}

const WEDDING = commonsPage({ license: "cc-by-4.0", shortName: "CC BY 4.0" });

/** Un curador aprueba ESTE recurso para el contrato EXACTO que pide la escena; se persiste y se rehidrata. */
function approveFor(visual: BeatVisual, asset: CuratableAsset, creditText?: string): VerifiedAssetRegistry {
  return rehydrateFixture(curateFixture([{ asset, key: contractKey(contractForVisual(visual)!), creditText }], requestedFor([visual])));
}

function commonsAsset(page: CommonsPage): CuratableAsset {
  const out = assetFromProposal(proposalOf(page));
  assert.ok("asset" in out, JSON.stringify(out));
  return out.asset;
}

const portrait = gucciVerifiedAssets[0].asset;
const press = gucciVerifiedAssets[1].asset;
const assetById = (id: string) => gucciVerifiedAssets.find((a) => a.asset.id === id)!.asset;

function proposalOf(page: CommonsPage): AssetProposal {
  const out = proposalFromCommonsPage(page);
  assert.ok("proposal" in out, JSON.stringify(out));
  return out.proposal;
}

async function selectWith(visual: BeatVisual, base: FootageProvider, registry: VerifiedAssetRegistry, docRegistry = new DocumentAssetRegistry(), shotId = "s1") {
  return selectStockForShot(
    { shotId, visual, preferVideo: false, minDurationSec: 4 },
    { footageProvider: registry.providerFor(visual, base), registry: docRegistry, identify, verifyEntityLink: registry.verifyEntityLink, verifyEvidenceLink: registry.verifyEvidenceLink },
  );
}

function shotFor(id: string, visual: BeatVisual, type: AllocatedShot["type"] = "ken_burns_image"): AllocatedShot {
  return {
    id,
    beatId: "b",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type,
    source: "stock",
    assetId: id,
    visualIntent: visual.description,
    motion: "ken_burns",
    captionText: visual.description,
    narrationFragment: visual.description,
    anchoredVisual: visual,
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: id,
    status: "planned",
    validationStatus: "pending",
    plannedType: type,
  } as AllocatedShot;
}

async function executeWith(shots: AllocatedShot[], pool: Pooled[], registry?: VerifiedAssetRegistry) {
  const fake = poolProvider(pool);
  const mem = memoryShotAssetStore();
  const deps = {
    topic: "t",
    footageProvider: fake.provider,
    imageProvider: { name: "fixture", capabilities: { id: "f", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 }, isAvailable: () => true, generateImage: async () => { throw new Error("sin IA"); } },
    store: mem.store,
    budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 }),
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: 60,
    requireReal: false,
    visualPipeline: "anchored_v1" as const,
    registry: new DocumentAssetRegistry(),
    identify,
    ...(registry ? { verifiedAssets: registry } : {}),
  };
  const executions: ShotExecution[] = [];
  for (const shot of shots) executions.push(await executeShot(shot, deps as never, emptyAiVideoLedgerState()));
  return executions;
}

// --------------------------------------------------------------------------
// Gate A — "Recreación IA" visible en el master
// --------------------------------------------------------------------------

test("A: v4 rotula también el VIDEO IA (antes llegaba sin procedencia y sin rótulo); v3 no cambia", () => {
  const scenes: LongFormShotScene[] = [{ id: "s", startSeconds: 0, endSeconds: 5, asset: { kind: "media", mediaType: "video", url: "u" }, motion: "pan" }];
  const v4 = directAnchoredScenes(scenes, [{}], [], [{ camera: "still", provenance: "ai_recreation" }]);
  assert.equal(v4[0].provenance, "ai_recreation");
  assert.match(renderToStaticMarkup(React.createElement(SceneLabels, { scene: v4[0] })), /Recreación IA/);
  const v3 = directAnchoredScenes(scenes, [{}], []);
  assert.equal(v3[0].provenance, undefined, "v3 sin cambios");
});

// --------------------------------------------------------------------------
// Gate C — LEGAL (lista cerrada) / Gate D — QUALITY
// --------------------------------------------------------------------------

test("C: lista cerrada PD / CC0 / CC BY; todo lo demás (NC, ND, SA, ARR, desconocida, ausente, ambigua, restringida) se rechaza", () => {
  for (const [code, license] of [["pd", "PD"], ["cc0", "CC0"], ["cc-by-4.0", "CC_BY"], ["cc-by-2.0", "CC_BY"]] as const) {
    assert.deepEqual(licenseEligibility({ code }), { eligible: true, license });
  }
  for (const code of ["cc-by-nc-4.0", "cc-by-nc-sa-4.0", "cc-by-nc-nd-4.0", "cc-by-nd-4.0", "cc-by-sa-4.0", "all rights reserved", "gfdl", "unknown-license"]) {
    assert.equal(licenseEligibility({ code }).eligible, false, code);
  }
  assert.equal(licenseEligibility({}).eligible, false, "ausente");
  assert.equal(licenseEligibility({ code: "cc-by-4.0", shortName: "CC BY-SA 4.0" }).eligible, false, "código y nombre en desacuerdo");
  assert.equal(licenseEligibility({ code: "pd", restrictions: "personality" }).eligible, false, "restricción explícita");
  assert.equal(licenseEligibility({ code: "pd", copyrighted: "True" }).eligible, false, "PD contradicho");
});

test("D: calidad — lado largo ≥ 1280 px, MIME permitido, sin reescalado", () => {
  assert.equal(qualityEligibility({ width: 2400, height: 1600, mime: "image/jpeg" }).status, "QUALITY_ELIGIBLE");
  assert.equal(qualityEligibility({ width: 1600, height: 2400, mime: "image/png" }).status, "QUALITY_ELIGIBLE", "vertical: cuenta el lado largo");
  assert.deepEqual(qualityEligibility({ width: 442, height: 590, mime: "image/jpeg" }), { status: "QUALITY_INELIGIBLE", reason: "lado largo 590 px < 1280 px" });
  assert.equal(qualityEligibility({ width: 2400, height: 1600, mime: "image/tiff" }).status, "QUALITY_INELIGIBLE");
  assert.equal(qualityEligibility({ mime: "image/jpeg" }).status, "QUALITY_INELIGIBLE");
});

// --------------------------------------------------------------------------
// Gate J — suite adversarial
// --------------------------------------------------------------------------

test("J1-J2: la foto correcta de la boda (CC BY, 2400 px) es una PROPUESTA; solo tras la curaduría queda vinculada y elegible", async () => {
  const proposal = proposalOf(WEDDING);
  // Sin curaduría: ni la propuesta ni su metadata (categoría, descripción) verifican nada.
  const uncurated = await selectWith(MAURIZIO_VISUAL, poolProvider([{ id: "commons-wedding", description: proposal.description!, similarity: 0.9, media: "image" }]).provider, VerifiedAssetRegistry.empty());
  assert.equal(uncurated.status, "gap", "encontrado por Commons ≠ confiable");
  // Con la decisión humana sobre el par exacto (boda ↔ Maurizio), persistida y rehidratada.
  const registry = approveFor(MAURIZIO_VISUAL, commonsAsset(WEDDING));
  const out = await selectWith(MAURIZIO_VISUAL, poolProvider([FEET, BELLBOY]).provider, registry);
  assert.equal(out.status, "selected");
  if (out.status === "selected") {
    assert.deepEqual(out.entityLink, { name: "Maurizio Gucci" });
    assert.equal(out.candidate.url, proposal.mediaUrl);
    // Los falsos amigos (más similitud) se evaluaron primero y se rechazaron.
    assert.ok(out.rejected.some((r) => r.sourceId === BELLBOY.id), "el falso amigo de imagen (0.93) se evaluó y se rechazó");
  }
});

test("J3-J6: 442 px (calidad), CC BY-NC, CC BY-SA (V1) y licencia desconocida no llegan siquiera a propuesta ni a registro", () => {
  const small = proposalFromCommonsPage(commonsPage({ license: "cc-by-4.0", width: 442, height: 590 }));
  assert.ok("rejected" in small && /calidad/.test(small.rejected));
  for (const license of ["cc-by-nc-4.0", "cc-by-sa-4.0", "", "weird-license"]) {
    const out = proposalFromCommonsPage(commonsPage({ license }));
    assert.ok("rejected" in out && /licencia/.test(out.rejected), license);
  }
  const restricted = proposalFromCommonsPage(commonsPage({ license: "pd", restrictions: "personality" }));
  assert.ok("rejected" in restricted);
  // Tampoco por la vía manual: nunca entran al archivo de curaduría.
  for (const decoy of gucciRegistryDecoys) {
    const out = proposeAsset(emptyCurationFile("r"), { asset: decoy, contractKey: MAURIZIO_KEY, origin: "manual", now: "t" }, gucciRequested());
    assert.ok("error" in out, decoy.id);
  }
});

test("J7: unas escaleras de licencia libre son LEGALES y aun así no pueden representar a Maurizio", async () => {
  assert.equal(licenseEligibility({ code: "pd" }).eligible, true);
  const stairs: Pooled = { id: "pd-stairs", description: "Maurizio Gucci stairs public domain photograph", similarity: 0.97, media: "image" };
  const out = await selectWith(MAURIZIO_VISUAL, poolProvider([stairs]).provider, VerifiedAssetRegistry.empty());
  assert.equal(out.status, "gap");
  // Y sin decisión humana sobre ese par, ni siquiera estando en el archivo, es de confianza.
  const file = { ...emptyCurationFile("req-release-gate"), assets: [{ ...portrait, id: "stairs", rights: { kind: "PD" as const } }] };
  assert.equal(rehydrateFixture(file).size, 0);
});

test("J8, J16: un candidato o proveedor no puede autocrear confianza (nombre, entityReference, id 'verified:', misma URL)", async () => {
  const registry = gucciRegistry();
  const spoof: FootageCandidate = {
    url: portrait.mediaUrl,
    sourceId: `verified:${portrait.id}`,
    description: "Maurizio Gucci archival portrait photograph, Milan",
    entityReference: { name: "Maurizio Gucci" },
    mediaType: "image",
    mimeType: "image/jpeg",
    extension: "jpg",
  };
  assert.equal(registry.verifyEntityLink(spoof), null, "solo los objetos EMITIDOS por el registro son de confianza");
  assert.equal(registry.verifyEvidenceLink(spoof), null);
  // Una propuesta con vínculo y "curaduría" autodeclarados no se rehidrata.
  const selfAsserted = { ...emptyCurationFile("req-release-gate"), assets: [{ ...commonsAsset(WEDDING), entityLink: { name: "Maurizio Gucci" }, curation: { curatedBy: "fixture" } }] };
  assert.equal(VerifiedAssetRegistry.rehydrate(selfAsserted, fixturePolicy()).size, 0);
  // Commons trae depicts/categoría/descripción con el nombre: no crean vínculo.
  const withDepicts = assetFromProposal({ ...proposalOf(WEDDING), depicts: ["Maurizio Gucci"] });
  assert.ok("asset" in withDepicts && !("entityLink" in withDepicts.asset), "sin decisión de vínculo del curador no hay registro");
});

const DEBT_VISUAL = normalizeDeclaredVisuals(
  [{ description: "financial newspaper headlines about corporate debt", motion: false, subject: "newspaper", era: "1990s", beatClass: "EVIDENCE", evidence: { sourceIds: ["web-5"] } }],
  { identity: true },
)[0];

test("J9-J10: el periódico equivocado (0.94) se rechaza; la prueba correcta (menor similitud) solo es elegible con evidenceLink", async () => {
  const debtRecord = assetById("ev-debt-1");
  const withLink = await selectWith(DEBT_VISUAL, poolProvider([WRONG_NEWSPAPER]).provider, approveFor(DEBT_VISUAL, debtRecord));
  assert.equal(withLink.status, "selected");
  if (withLink.status === "selected") {
    assert.equal(withLink.candidate.url, debtRecord.mediaUrl);
    assert.match(withLink.rejected.find((r) => r.sourceId === WRONG_NEWSPAPER.id)?.reason ?? "", /^FALSE_FRIEND/);
  }
  const without = await selectWith(DEBT_VISUAL, poolProvider([WRONG_NEWSPAPER, { id: "same-desc", description: debtRecord.description!, similarity: 0.5, media: "image" }]).provider, VerifiedAssetRegistry.empty());
  assert.equal(without.status, "gap", "la misma descripción sin vínculo no prueba nada");
});

test("J11-J13: reutilización — retrato verificado SÍ (justificada); stock genérico NO; identidad distinta NO", async () => {
  const registry = approveFor(MAURIZIO_VISUAL, portrait);
  const doc = new DocumentAssetRegistry();
  const first = await selectWith(MAURIZIO_VISUAL, poolProvider([]).provider, registry, doc, "s1");
  assert.equal(first.status, "selected");
  if (first.status === "selected") doc.register("s1", first.identity);
  const second = await selectWith(MAURIZIO_VISUAL, poolProvider([]).provider, registry, doc, "s2");
  assert.equal(second.status, "selected");
  if (second.status === "selected") assert.deepEqual(second.reuse, { of: "s1", justification: "verified_identity_reuse" });
  // Genérico: el mismo stock no se repite.
  const place = normalizeDeclaredVisuals([{ description: "quiet street in Milan", motion: false, subject: "street", beatClass: "PLACE" }], { identity: true })[0];
  const street: Pooled = { id: "street-1", description: "quiet street in Milan", similarity: 0.8, media: "image" };
  const gdoc = new DocumentAssetRegistry();
  const g1 = await selectWith(place, poolProvider([street]).provider, registry, gdoc, "p1");
  if (g1.status === "selected") gdoc.register("p1", g1.identity);
  assert.equal((await selectWith(place, poolProvider([street]).provider, registry, gdoc, "p2")).status, "gap");
  // Identidad distinta: el retrato de Maurizio (objeto emitido) ofrecido a otra persona no se reutiliza ni se acepta.
  const issued = await registry.providerFor(MAURIZIO_VISUAL, poolProvider([]).provider).searchImageCandidates!("x");
  const patrizia = normalizeDeclaredVisuals([{ description: "Patrizia Reggiani", motion: false, beatClass: "IDENTITY", identity: { name: "Patrizia Reggiani", kind: "person" } }], { identity: true })[0];
  const passthrough: FootageProvider = { ...poolProvider([]).provider, searchImageCandidates: async () => issued };
  const mismatch = await selectStockForShot(
    { shotId: "s3", visual: patrizia, preferVideo: false, minDurationSec: 4 },
    { footageProvider: passthrough, registry: doc, identify, verifyEntityLink: registry.verifyEntityLink, verifyEvidenceLink: registry.verifyEvidenceLink },
  );
  assert.equal(mismatch.status, "gap");
  assert.match(mismatch.rejected[0]?.reason ?? "", /duplicado|otra entidad/);
});

test("J11b: el informe justifica la reutilización verificada y el render no se bloquea; con otro encuadre", async () => {
  const registry = approveFor(MAURIZIO_VISUAL, portrait);
  const shots = [shotFor("s1", MAURIZIO_VISUAL), shotFor("s2", { ...MAURIZIO_VISUAL })];
  shots[1] = { ...shots[1], startSec: 5, endSec: 10 };
  const executions = await executeWith(shots, [], registry);
  assert.deepEqual(executions[1].assetMeta?.selection?.reuse, { of: "s1", justification: "verified_identity_reuse" });
  const report = buildVisualReport({ requestId: "r", planVersion: 4, topic: "t", shots, executions, now: () => 0 });
  assert.equal(report.summary.repeatedAssets[0]?.justification, "verified_identity_reuse");
  assert.doesNotThrow(() => assertVisualQuality(report));
  const [a, b] = report.cinematic!.scenes;
  assert.equal(a.look, undefined);
  assert.ok(b.look?.scale && b.look.scale > 1, "la reutilización usa otro encuadre estático");
  assert.ok(b.executed.includes("look:reframe"));
});

test("J14: el crédito CC BY llega a la escena renderizada (SceneLabels), no solo al JSON", async () => {
  const registry = approveFor(MAURIZIO_VISUAL, commonsAsset(WEDDING));
  const shots = [shotFor("s1", MAURIZIO_VISUAL)];
  const executions = await executeWith(shots, [], registry);
  const credit = executions[0].assetMeta?.provenance?.credit;
  assert.ok(credit && /CC BY/.test(credit), credit);
  const report = buildVisualReport({ requestId: "r", planVersion: 4, topic: "t", shots, executions, now: () => 0 });
  const scenes = directAnchoredScenes([{ id: "s1", startSeconds: 0, endSeconds: 5, asset: executions[0].asset as LongFormShotScene["asset"], motion: "ken_burns" }], executions, [], report.cinematic!.scenes);
  assert.equal(scenes[0].creditText, credit);
  assert.ok(renderToStaticMarkup(React.createElement(SceneLabels, { scene: scenes[0] })).includes(credit!.replace(/&/g, "&amp;")));
  // v3 (sin decisiones del Director) no cambia.
  assert.equal(directAnchoredScenes([{ id: "s1", startSeconds: 0, endSeconds: 5, asset: executions[0].asset as LongFormShotScene["asset"], motion: "ken_burns" }], executions, [])[0].creditText, undefined);
});

test("J15: un registro manual de archivo licenciado sigue EXACTAMENTE la misma vía (y CC BY sin crédito no entra)", async () => {
  const registry = approveFor(MAURIZIO_VISUAL, { ...press, source: "licensed_archive" });
  const [ex] = await executeWith([shotFor("s1", MAURIZIO_VISUAL)], [], registry);
  assert.equal(ex.executedType, "ken_burns_image");
  assert.equal(ex.assetMeta?.provenance?.kind, "archival_documentary");
  assert.match(ex.assetMeta?.provenance?.license ?? "", /^LICENSED: /);
  const noCredit = validateAsset({ ...press, source: "manual", rights: { kind: "CC_BY" }, creditText: undefined }, { forApproval: true });
  assert.ok(noCredit.some((r) => /CC BY exige/.test(r)));
  const commonsLicensed = validateAsset({ ...press, source: "commons" });
  assert.ok(commonsLicensed.length > 0, "Commons nunca entra con derechos 'LICENSED'");
});

test("regiones curadas (0–1) viajan con la prueba junto al crédito y la procedencia; fuera de rango se rechazan", () => {
  const regions = [{ label: "headline" as const, x: 0.1, y: 0.05, w: 0.8, h: 0.2 }, { label: "date" as const, x: 0.7, y: 0.01, w: 0.25, h: 0.05 }];
  const registry = approveFor(DEBT_VISUAL, { ...assetById("ev-debt-1"), regions });
  const [record] = registry.recordsFor(DEBT_VISUAL);
  assert.ok(record.regions?.length === 2 && record.creditText && record.evidenceLink);
  assert.ok(validateAsset({ ...assetById("ev-debt-1"), regions: [{ label: "headline", x: 0.5, y: 0.5, w: 0.8, h: 0.2 }] }).length > 0);
});

test("Commons: consulta por identidad (nunca su acción), EVIDENCE solo con proposición; búsqueda simulada sin red", async () => {
  assert.equal(commonsQueryFor({ ...MAURIZIO_VISUAL, description: "Maurizio Gucci climbing stairs", action: "climbing" }), "Maurizio Gucci");
  assert.equal(commonsQueryFor({ ...DEBT_VISUAL, evidence: undefined }), null);
  assert.equal(commonsQueryFor(DEBT_VISUAL), "newspaper 1990s");
  assert.equal(commonsQueryFor({ description: "street", motion: false, beatClass: "PLACE" }), null);
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    const pages = { 1: { ...WEDDING, index: 1 }, 2: { ...commonsPage({ title: "File:small.jpg", license: "cc-by-4.0", width: 442, height: 590 }), index: 2 }, 3: { ...commonsPage({ title: "File:nc.jpg", license: "cc-by-nc-4.0" }), index: 3 } };
    return new Response(JSON.stringify({ query: { pages } }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await searchCommonsProposals("Maurizio Gucci", { fetchImpl: fakeFetch });
  assert.equal(out.proposals.length, 1);
  assert.equal(out.rejected.length, 2);
  assert.match(calls[0], /commons\.wikimedia\.org/);
  assert.equal(networkCalls, 0, "ninguna llamada de red real");
});

// --------------------------------------------------------------------------
// Gate I — cobertura HERO antes de gastar
// --------------------------------------------------------------------------

test("J17: cobertura HERO sin registro → insuficiente y la producción se detiene ANTES de cualquier llamada pagada", async () => {
  const { shots } = planShotsFromScript(gucciBeats, GUCCI_TOPIC, "cinematic");
  const coverage = heroCoverage(shots, undefined, MAX_TEXT_FALLBACK_RATIO);
  assert.ok(coverage.blockers.length > 0, JSON.stringify(coverage));
  assert.ok(coverage.missingIdentities.includes("Maurizio Gucci"));
  const run = await produceOffline(gucciBeats, planFor(gucciBeats));
  assert.match(String(run.error), /HERO_COVERAGE/);
  assert.deepEqual(run.events, [], "0 voz, 0 stock, 0 imagen, 0 música, 0 render");
});

test("J18: cobertura HERO con el registro mínimo refleja la reutilización (identidades cubiertas)", () => {
  const { shots } = planShotsFromScript(gucciBeats, GUCCI_TOPIC, "cinematic");
  const coverage = heroCoverage(shots, gucciRegistry(), MAX_TEXT_FALLBACK_RATIO);
  assert.deepEqual(coverage.missingIdentities, []);
  assert.deepEqual(coverage.heroMissingRequiredIdentities, []);
  assert.ok(coverage.heroIdentitySeconds > 0);
  assert.deepEqual(coverage.blockers, []);
});

test("J20: v3 sin cambios — sin registro, sin cobertura, sin reutilización", async () => {
  const v3 = { ...planFor(gucciBeats), version: 3 } as ProductionPlan;
  const run = await produceOffline(gucciBeats, v3);
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.events.includes("render"));
  const [v] = normalizeDeclaredVisuals([{ description: "x", motion: false, beatClass: "IDENTITY", identity: MAURIZIO }]);
  assert.equal(v.identity, undefined);
});

// --------------------------------------------------------------------------
// Gate K — Gucci offline: A sin registro, B registro mínimo, C solo Commons
// --------------------------------------------------------------------------

function summary(label: string, sim: Awaited<ReturnType<typeof simulate>>) {
  const qa = sim.report.cinematic!.qa;
  const out = {
    scenario: label,
    coverage: sim.coverage,
    deliverable: !sim.gateError,
    gate: sim.gateError ? String(sim.gateError).slice(0, 240) : null,
    heroCards: qa.cards.filter((c) => c.startSec < 120).length,
    cards: qa.cards.length,
    textFallbackRatio: Math.round(sim.textFallbackRatio * 1000) / 1000,
    reuses: sim.executions.filter((e) => e.assetMeta?.selection?.reuse).length,
  };
  console.log(`GUCCI ${label}`, JSON.stringify(out, null, 1));
  return out;
}

test("K: Gucci offline — A sin registro (fallo verdadero), B registro mínimo + reutilización, C solo Commons", async () => {
  const a = summary("A", await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic"));
  assert.equal(a.deliverable, false, "sin registro no hay entrega: tarjetas inevitables");
  assert.ok(a.coverage.blockers.length > 0);

  const bSim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry: gucciRegistry() });
  const b = summary("B", bSim);
  assert.equal(b.deliverable, true, String(bSim.gateError));
  assert.ok(b.reuses > 0, "la reutilización verificada cubre escenas de identidad repetidas");
  for (const adv of [FEET, BELLBOY, BUSINESSMAN, WRONG_NEWSPAPER]) assert.ok(!bSim.report.scenes.some((s) => s.candidateDescription === adv.description), adv.id);

  // C: un único retrato CC BY de Commons, curado. Las pruebas (portada 1995, juicio 1998, deuda 1993) no tienen licencia abierta.
  const cSim = await simulate(gucciBeats, GUCCI_TOPIC, gucciAdversarial, "cinematic", { registry: approveFor(MAURIZIO_VISUAL, commonsAsset(WEDDING)) });
  const c = summary("C", cSim);
  assert.ok(c.coverage.missingEvidence.length > 0, "las proposiciones de prueba quedan sin cubrir");
  assert.equal(c.deliverable, false, "un retrato no es cobertura de prueba: HERO_EVIDENCE_COVERAGE_MISSING");
  assert.equal(networkCalls, 0);
});
