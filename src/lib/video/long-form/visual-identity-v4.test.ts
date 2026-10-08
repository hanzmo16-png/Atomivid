import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FootageCandidate, FootageProvider, GenerativeAsset, ImageGenerationRequest, ImageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry } from "./asset-identity";
import { selectStockForShot, selectionQueries } from "./stock-selection";
import { executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, isExecutablePlanVersion, PRODUCTION_PLAN_VERSION, usesVisualIdentity, type AllocatedShot } from "./production-plan";
import { shotsForSpan } from "./shots";
import { VisualSchema } from "./documentary-script";
import { normalizeDeclaredVisuals, requiresIdentity, visualsForBeat, type BeatVisual } from "./visual-intents";

/**
 * Visual Excellence V1 — B2B: clase e identidad por escena, solo en planes v4.
 * Recorrido: salida del planner → script_json → escena normalizada → shot →
 * selector/ejecutor. Sin red, sin proveedores reales, sin revisor.
 */

globalThis.fetch = (async () => {
  throw new Error("B2B: red prohibida en las pruebas");
}) as typeof fetch;

const TOPIC = "Documental de prueba";
const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex") });
const V3 = { identity: usesVisualIdentity({ version: 3 }) };
const V4 = { identity: usesVisualIdentity({ version: 4 }) };

/** Beat tal como lo guardaría un guion v4 (salida del planner). */
const gucciBeat = {
  id: "beat-1",
  type: "hook" as const,
  narration: "Maurizio Gucci arrived early that morning. His office building stood on a quiet street in central Milan. He climbed the stairs toward his office on the first floor.",
  visuals: [
    {
      description: "Maurizio Gucci entering his office building in Milan",
      motion: true,
      quote: "Maurizio Gucci arrived early that morning",
      subject: "Maurizio Gucci",
      action: "entering",
      place: "Milan",
      era: "1995",
      beatClass: "IDENTITY",
      identity: { name: "Maurizio Gucci", kind: "person", sourceIds: ["web-1"] },
    },
    { description: "facade of an office building in Milan", motion: false, quote: "His office building stood on a quiet street in central Milan", subject: "office building", place: "Milan", era: "1990s", beatClass: "PLACE" },
    {
      description: "man climbing stairs toward an office",
      motion: true,
      quote: "He climbed the stairs toward his office",
      subject: "stairs",
      action: "climbing",
      place: "Milan",
      era: "1995",
      beatClass: "TRANSITION",
    },
  ],
};

type Fixture = { id: string; description: string; similarity: number; pageUrl?: string };
const feet: Fixture = { id: "c-a", description: "anonymous feet climbing stairs in Milan", similarity: 0.95 };
const bellboy: Fixture = { id: "c-b", description: "bellboy building attendant entering an office building in Milan", similarity: 0.93 };
const linked: Fixture = { id: "c-c", description: "Maurizio Gucci archival portrait photograph, Milan", similarity: 0.4 };
const facade: Fixture = { id: "c-d", description: "facade of an office building in Milan", similarity: 0.35 };

function rankedProvider(fixtures: Fixture[]) {
  const ranked = [...fixtures].sort((a, b) => b.similarity - a.similarity);
  const searches: string[] = [];
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage() {
      throw new Error("no debe usarse con búsqueda de candidatos");
    },
    async searchImageCandidates(q) {
      searches.push(q);
      return ranked.map(
        (f): FootageCandidate => ({ url: `https://cdn.example/${f.id}.jpg`, sourceId: f.id, description: f.description, pageUrl: f.pageUrl, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }),
      );
    },
    async downloadFootage(url) {
      return Buffer.from(`bytes:${url}`);
    },
  };
  return { provider, searches };
}

/** Catálogo de un archivo de confianza del SERVIDOR (verificador inyectado); nunca lee el texto del candidato. */
const trustedArchive = (records: Record<string, string>) => (c: FootageCandidate) => (records[c.sourceId] ? { name: records[c.sourceId] } : null);

function fakePng(tag: string): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf[0] = 0x89;
  buf.write("PNG", 1, "ascii");
  buf.write(tag, 40, "ascii");
  return buf;
}

function countingImageProvider() {
  const prompts: string[] = [];
  const provider: ImageProvider = {
    name: "openai",
    capabilities: { id: "openai", models: ["gpt-image-2"], formats: ["image/png"], aspectRatios: ["landscape 3:2"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
      prompts.push(request.prompt);
      return { buffer: fakePng(`call-${prompts.length}`), mimeType: "image/png", extension: "png", width: 1536, height: 1024, model: "gpt-image-2", costUsd: 0.05 };
    },
  };
  return { provider, prompts };
}

async function deps(footage: FootageProvider, image: ImageProvider, extra: Partial<ShotExecutionDeps> = {}): Promise<ShotExecutionDeps> {
  const mem = memoryShotAssetStore();
  return {
    topic: TOPIC,
    footageProvider: footage,
    imageProvider: image,
    store: mem.store,
    budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 2, maxAiVideoClips: 0, maxGenerativeUsd: 0.2 }),
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: 60,
    requireReal: false,
    visualPipeline: "anchored_v1",
    registry: new DocumentAssetRegistry(),
    identify,
    ...extra,
  };
}

function shotFor(visual: BeatVisual, type: AllocatedShot["type"], fragment = "Maurizio Gucci entered his office building in Milan"): AllocatedShot {
  return {
    id: "beat-1-shot-1",
    beatId: "beat-1",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type,
    source: type === "generated_placeholder" || type === "ai_video" ? "generated" : "stock",
    assetId: "beat-1-shot-1",
    visualIntent: visual.description,
    motion: "ken_burns",
    captionText: fragment,
    narrationFragment: fragment,
    anchoredVisual: visual,
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: "beat-1-shot-1",
    status: "planned",
    validationStatus: "pending",
  } as AllocatedShot;
}

const [identityV4, placeV4, transitionV4] = visualsForBeat(gucciBeat, TOPIC, V4);
const [identityV3] = visualsForBeat(gucciBeat, TOPIC, V3);

// --------------------------------------------------------------------------
// Versionado
// --------------------------------------------------------------------------

test("los planes nuevos son v4 y v1-v4 son ejecutables; solo v4 lee clase e identidad", () => {
  assert.equal(PRODUCTION_PLAN_VERSION, 4);
  for (const v of [1, 2, 3, 4]) assert.equal(isExecutablePlanVersion(v), true);
  assert.deepEqual([1, 2, 3, 4].map((version) => usesVisualIdentity({ version })), [false, false, false, true]);
});

// --------------------------------------------------------------------------
// A, B, Q — identidad de extremo a extremo, PLACE separado, época
// --------------------------------------------------------------------------

test("A: el planner declara clase e identidad y viajan a la escena normalizada y al shot", () => {
  // El esquema del planner conserva los campos (zod no los descarta).
  const parsed = VisualSchema.parse(gucciBeat.visuals[0]);
  assert.equal(parsed.beatClass, "IDENTITY");
  assert.deepEqual(parsed.identity, { name: "Maurizio Gucci", kind: "person", sourceIds: ["web-1"] });
  assert.equal(identityV4.beatClass, "IDENTITY");
  assert.deepEqual(identityV4.identity, { name: "Maurizio Gucci", kind: "person", sourceIds: ["web-1"] });
  const shots = shotsForSpan({
    beatId: gucciBeat.id,
    beatType: gucciBeat.type,
    startSec: 0,
    endSec: 24,
    narration: gucciBeat.narration,
    strategy: "economical",
    visuals: [identityV4, placeV4, transitionV4],
    anchoring: {},
    targetCount: 3,
  });
  const carried = shots.find((s) => s.anchoredVisual?.beatClass === "IDENTITY");
  assert.ok(carried, "un shot lleva la escena IDENTITY");
  assert.deepEqual(carried.anchoredVisual?.identity, identityV4.identity);
});

test("B: PLACE no hereda la identidad del beat aunque la narración nombre a la persona", () => {
  assert.equal(placeV4.beatClass, "PLACE");
  assert.equal(placeV4.identity, undefined);
  assert.equal(requiresIdentity(placeV4), false);
  assert.equal(transitionV4.identity, undefined);
});

test("Q: la época sobrevive hasta el punto de decisión (escena, shot, consulta y prompt IA)", async () => {
  assert.equal(identityV4.era, "1995");
  assert.equal(shotFor(placeV4, "generated_placeholder").anchoredVisual?.era, "1990s");
  assert.deepEqual(selectionQueries(identityV4)[0], "Maurizio Gucci Milan 1995");
  const image = countingImageProvider();
  const d = await deps(rankedProvider([]).provider, image.provider);
  const ex = await executeShot(shotFor(placeV4, "generated_placeholder", "His office building stood on a quiet street in central Milan"), d, emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "generated_placeholder", ex.deviation?.reason);
  assert.equal(image.prompts.length, 1, "una escena PLACE sí puede ser recreación IA");
  assert.match(image.prompts[0], /during 1990s/);
});

// --------------------------------------------------------------------------
// C — IDENTITY sin identidad válida: fail-closed
// --------------------------------------------------------------------------

test("C: IDENTITY sin identidad válida falla cerrado: no se busca material, no se genera, termina en tarjeta", async () => {
  const invalid = [
    { description: "a powerful man entering a building", motion: true, subject: "man", beatClass: "IDENTITY" },
    { description: "a powerful man entering a building", motion: true, subject: "man", beatClass: "IDENTITY", identity: { name: "  ", kind: "person" } },
    { description: "a powerful man entering a building", motion: true, subject: "man", beatClass: "IDENTITY", identity: { name: "Someone", kind: "company" } },
  ];
  for (const visual of normalizeDeclaredVisuals(invalid, V4)) {
    assert.equal(visual.beatClass, "IDENTITY", "no se reclasifica como PROCESS");
    assert.equal(visual.identity, undefined, "no se inventa una identidad");
    assert.equal(requiresIdentity(visual), true);
    const fake = rankedProvider([feet, bellboy]);
    const out = await selectStockForShot({ shotId: "s", visual, preferVideo: false, minDurationSec: 4 }, { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify });
    assert.equal(out.status, "gap");
    assert.deepEqual(fake.searches, [], "no se busca stock humano");
    const image = countingImageProvider();
    const ex = await executeShot(shotFor(visual, "generated_placeholder"), await deps(fake.provider, image.provider), emptyAiVideoLedgerState());
    assert.equal(ex.executedType, "text");
    assert.equal(image.prompts.length, 0);
  }
});

// --------------------------------------------------------------------------
// D, F, G, K, L, O, P — reglas v4 en ejecución
// --------------------------------------------------------------------------

test("D/L/O: v4 — pies (0.95) y botones (0.93) se rechazan; sin archivo de confianza la escena queda en la tarjeta existente", async () => {
  const ex = await executeShot(shotFor(identityV4, "ken_burns_image"), await deps(rankedProvider([feet, bellboy, linked, facade]).provider, countingImageProvider().provider), emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "text");
  const rejected = ex.assetMeta?.gap?.rejected ?? [];
  // Rechazados por identidad, nunca por su score: FALSE_FRIEND si el léxico los habría aprobado, IDENTITY_UNVERIFIED si no.
  assert.match(rejected.find((r) => r.sourceId === "c-a")?.reason ?? "", /^(FALSE_FRIEND|IDENTITY_UNVERIFIED): sin vínculo de confianza/);
  assert.match(rejected.find((r) => r.sourceId === "c-b")?.reason ?? "", /^(FALSE_FRIEND|IDENTITY_UNVERIFIED): sin vínculo de confianza/);
  assert.match(rejected.find((r) => r.sourceId === "c-c")?.reason ?? "", /^FALSE_FRIEND: sin vínculo de confianza/, "el nombre en el alt text no verifica");
});

test("G: v4 — un vínculo confirmado por el verificador del servidor hace elegible al 0.40 y se registra como archivo documental", async () => {
  const d = await deps(rankedProvider([feet, bellboy, linked, facade]).provider, countingImageProvider().provider, { verifyEntityLink: trustedArchive({ "c-c": "Maurizio Gucci" }) });
  const ex = await executeShot(shotFor(identityV4, "ken_burns_image"), d, emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "ken_burns_image");
  assert.equal(ex.assetMeta?.selection?.candidateDescription, linked.description);
  assert.equal(ex.assetMeta?.provenance?.kind, "archival_documentary");
  assert.deepEqual(ex.assetMeta?.selection?.entityLink, { name: "Maurizio Gucci" });
});

test("P: sourceIds sustentan el GUION, no verifican un recurso — ni con la misma URL de la fuente", async () => {
  const sourceUrl = "https://archive.example/maurizio-gucci";
  const sameUrl: Fixture = { ...linked, id: "c-u", pageUrl: sourceUrl, similarity: 0.99 };
  const visual: BeatVisual = { ...identityV4, identity: { name: "Maurizio Gucci", kind: "person", sourceIds: ["web-1"] } };
  const out = await selectStockForShot(
    { shotId: "s", visual, preferVideo: false, minDurationSec: 4 },
    { footageProvider: rankedProvider([sameUrl]).provider, registry: new DocumentAssetRegistry(), identify },
  );
  assert.equal(out.status, "gap");
  assert.match(out.rejected[0]?.reason ?? "", /sin vínculo de confianza/);
});

test("F: v4 — un proveedor genérico no se autodeclara con entityReference", async () => {
  const fake = rankedProvider([]);
  fake.provider.searchImageCandidates = async () => [
    { url: "https://cdn.example/s.jpg", sourceId: "c-s", description: "man in a suit entering a Milan office", entityReference: { name: "Maurizio Gucci" }, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" },
  ];
  const out = await selectStockForShot({ shotId: "s", visual: identityV4, preferVideo: false, minDurationSec: 4 }, { footageProvider: fake.provider, registry: new DocumentAssetRegistry(), identify });
  assert.equal(out.status, "gap");
});

test("K: v4 — la ruta generativa NO se llama para una escena de identidad (imagen y video IA): 0 llamadas, 0 reserva", async () => {
  for (const type of ["generated_placeholder", "ai_video"] as const) {
    const image = countingImageProvider();
    const d = await deps(rankedProvider([feet, bellboy]).provider, image.provider);
    const ex = await executeShot(shotFor(identityV4, type), d, emptyAiVideoLedgerState());
    assert.equal(image.prompts.length, 0, `${type}: proveedor IA sin llamadas`);
    assert.equal(d.budget.snapshot().used.aiImageGenerations, 0, `${type}: sin reserva de presupuesto`);
    assert.equal(ex.executedType, "text");
  }
});

// --------------------------------------------------------------------------
// E — Leonidas, la misma regla general
// --------------------------------------------------------------------------

test("E: v4 — el hoplita anónimo (0.95) se rechaza; la representación vinculada (0.40) es elegible", async () => {
  const [leonidas] = normalizeDeclaredVisuals(
    [{ description: "Leonidas leading the Spartans at Thermopylae", motion: true, subject: "Leonidas", place: "Thermopylae", era: "480 BC ancient Greece", beatClass: "IDENTITY", identity: { name: "Leonidas", kind: "person" } }],
    V4,
  );
  const fixtures: Fixture[] = [
    { id: "l-a", description: "anonymous Spartan hoplite warrior with shield at Thermopylae", similarity: 0.95 },
    { id: "l-b", description: "statue of Leonidas king of Sparta at Thermopylae", similarity: 0.4 },
  ];
  const out = await selectStockForShot(
    { shotId: "s", visual: leonidas, preferVideo: false, minDurationSec: 4 },
    { footageProvider: rankedProvider(fixtures).provider, registry: new DocumentAssetRegistry(), identify, verifyEntityLink: trustedArchive({ "l-b": "Leonidas" }) },
  );
  assert.equal(out.status, "selected");
  if (out.status === "selected") assert.equal(out.candidate.sourceId, "l-b");
  assert.match(out.rejected.find((r) => r.sourceId === "l-a")?.reason ?? "", /^(FALSE_FRIEND|IDENTITY_UNVERIFIED): sin vínculo de confianza/);
});

// --------------------------------------------------------------------------
// H, I, J — PROCESS, PLACE, identidad + mismo lugar
// --------------------------------------------------------------------------

const workshop: Fixture = { id: "w-1", description: "weavers working at looms in a vintage textile workshop in Florence", similarity: 0.9 };

test("H: v4 PROCESS — el taller con tejedores se ACEPTA", async () => {
  const [process] = normalizeDeclaredVisuals(
    [{ description: "textile workshop in Florence in the 1950s with weavers at looms", motion: true, subject: "textile workshop", action: "weaving", place: "Florence", era: "1950s", beatClass: "PROCESS" }],
    V4,
  );
  const out = await selectStockForShot({ shotId: "s", visual: process, preferVideo: false, minDurationSec: 4 }, { footageProvider: rankedProvider([workshop]).provider, registry: new DocumentAssetRegistry(), identify });
  assert.equal(out.status, "selected");
});

test("I: v4 PLACE — el contexto verdadero se acepta sin vínculo de entidad, como material ilustrativo", async () => {
  const ex = await executeShot(shotFor(placeV4, "ken_burns_image", "His office building stood on a quiet street in central Milan"), await deps(rankedProvider([facade]).provider, countingImageProvider().provider), emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "ken_burns_image");
  assert.equal(ex.assetMeta?.provenance?.kind, "stock_illustrative");
  assert.equal(ex.assetMeta?.selection?.entityLink, undefined);
});

test("J: v4 identidad + mismo lugar — el taller del control PROCESS no representa a la persona", async () => {
  const [walk] = normalizeDeclaredVisuals(
    [{ description: "Maurizio Gucci walking through a textile workshop in Florence", motion: true, subject: "textile workshop", action: "walking", place: "Florence", beatClass: "IDENTITY", identity: { name: "Maurizio Gucci", kind: "person" } }],
    V4,
  );
  const out = await selectStockForShot({ shotId: "s", visual: walk, preferVideo: false, minDurationSec: 4 }, { footageProvider: rankedProvider([workshop]).provider, registry: new DocumentAssetRegistry(), identify });
  assert.equal(out.status, "gap");
  assert.match(out.rejected[0]?.reason ?? "", /^FALSE_FRIEND/);
});

test("TRANSITION v4: el verbo narrado no se busca literalmente (ni descripción ni acción)", () => {
  assert.deepEqual(selectionQueries(transitionV4), ["stairs Milan 1995", "stairs Milan"]);
});

// --------------------------------------------------------------------------
// M, N — aislamiento v3
// --------------------------------------------------------------------------

test("M: v3 — la normalización de un guion con campos v4 es idéntica a la de v3 sin ellos", () => {
  const stripped = gucciBeat.visuals.map((v) => {
    const copy: Record<string, unknown> = { ...v };
    delete copy.beatClass;
    delete copy.identity;
    return copy;
  });
  const v3 = visualsForBeat(gucciBeat, TOPIC, V3);
  assert.deepEqual(v3, normalizeDeclaredVisuals(stripped));
  assert.ok(v3.every((v) => v.beatClass === undefined && v.identity === undefined));
  // Consultas y reparto de shots exactamente como antes.
  assert.deepEqual(selectionQueries(v3[2]), ["man climbing stairs toward an office", "stairs Milan"]);
  const span = (visuals: BeatVisual[]) =>
    shotsForSpan({ beatId: "beat-1", beatType: "hook", startSec: 0, endSec: 24, narration: gucciBeat.narration, strategy: "cinematic", visuals, anchoring: {}, targetCount: 3 }).map(
      (shot) => ({ ...shot, anchoredVisual: undefined }),
    );
  assert.deepEqual(span(v3), span(visualsForBeat(gucciBeat, TOPIC, V4)), "la clase/identidad no cambia la composición del plan");
});

test("N: v3 — NO ejecuta las reglas de identidad (comportamiento léxico anterior, ni más estricto)", async () => {
  assert.equal(identityV3.identity, undefined);
  const ex = await executeShot(shotFor(identityV3, "ken_burns_image"), await deps(rankedProvider([feet, bellboy, linked]).provider, countingImageProvider().provider), emptyAiVideoLedgerState());
  // Hecho histórico de v3: el primer candidato léxico gana. v3 no se reinterpreta.
  assert.equal(ex.executedType, "ken_burns_image");
  assert.equal(ex.assetMeta?.provenance?.kind, "stock_illustrative");
  assert.ok(!(ex.assetMeta?.selection?.rejected ?? []).some((r) => r.reason.startsWith("FALSE_FRIEND")));
});
