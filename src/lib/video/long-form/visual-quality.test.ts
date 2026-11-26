import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { DocumentAssetRegistry, canonicalizeUrl, dhashImage, hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "./asset-identity";
import { assessRelevance, selectStockForShot, selectionQueries } from "./stock-selection";
import { anchorIntents, intentWordSpans, salientFact, wordRangesForShots } from "./scene-anchoring";
import { shotsForSpan } from "./shots";
import { anchoredTextCard, executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { getGenerativeUnitCosts, computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type AllocatedShot } from "./production-plan";
import { buildVisualReport, assertVisualQuality } from "./visual-report";
import { describeFromPexelsPageUrl } from "@/lib/ai/footage";
import { documentary180sFixture } from "./test-fixtures";
import type { BeatVisual } from "./visual-intents";

/**
 * Calidad visual M1 — fallos REALES observados en el Canal de Panamá:
 * descripciones recicladas por módulo, `candidates[0]` sin memoria (el
 * mismo hombre en una puerta 4 veces), material ajeno por la búsqueda del
 * tema, tarjetas que repetían el título. Sin red ni proveedores reales.
 */

const sha = (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex") });
const identify = async (b: Buffer) => sha(b);

function candidate(id: string, description: string, url = `https://cdn.example/${id}.jpg`): FootageCandidate {
  return { url, sourceId: id, description, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" };
}

function provider(opts: { byQuery?: (q: string) => FootageCandidate[]; bytes?: (url: string) => Buffer }): FootageProvider & { searches: string[]; downloads: string[] } {
  const searches: string[] = [];
  const downloads: string[] = [];
  return {
    name: "pexels-video-first",
    searches,
    downloads,
    async fetchFootage() {
      throw new Error("no debe usarse con búsqueda de candidatos");
    },
    async searchImageCandidates(q) {
      searches.push(q);
      return opts.byQuery?.(q) ?? [];
    },
    async downloadFootage(url) {
      downloads.push(url);
      return opts.bytes?.(url) ?? Buffer.from(`bytes:${url.split("?")[0]}`);
    },
  };
}

const ship: BeatVisual = { description: "steamship crossing canal locks", subject: "steamship", place: "Panama", era: "1914", motion: true };

test("mismo recurso devuelto para varias búsquedas: se usa UNA vez; las demás escenas eligen otro o registran carencia", async () => {
  const registry = new DocumentAssetRegistry();
  const same = provider({ byQuery: () => [candidate("pexels-photo-1", "steamship in canal lock Panama")] });
  const first = await selectStockForShot({ shotId: "s1", visual: ship, preferVideo: false, minDurationSec: 4 }, { footageProvider: same, registry, identify });
  assert.equal(first.status, "selected");
  if (first.status === "selected") registry.register("s1", first.identity);
  const second = await selectStockForShot({ shotId: "s2", visual: ship, preferVideo: false, minDurationSec: 4 }, { footageProvider: same, registry, identify });
  assert.equal(second.status, "gap", "el único candidato ya está usado: carencia, no repetición");
  if (second.status === "gap") {
    assert.match(second.reason, /1 ya usados/);
    assert.ok(second.rejected.every((r) => r.reason.includes("mismo id del proveedor")));
  }
  assert.equal(same.downloads.length, 1, "el duplicado por id se detecta ANTES de descargar");
});

test("mismo contenido con URL e id distintos (re-subida): se detecta por SHA-256 después de descargar", async () => {
  const registry = new DocumentAssetRegistry();
  const reupload = provider({
    byQuery: () => [candidate("pexels-photo-10", "steamship canal Panama"), candidate("pexels-photo-99", "steamship canal lock Panama")],
    bytes: () => Buffer.from("MISMO-ARCHIVO"),
  });
  const a = await selectStockForShot({ shotId: "s1", visual: ship, preferVideo: false, minDurationSec: 4 }, { footageProvider: reupload, registry, identify });
  assert.equal(a.status, "selected");
  if (a.status === "selected") registry.register("s1", a.identity);
  const b = await selectStockForShot({ shotId: "s2", visual: ship, preferVideo: false, minDurationSec: 4 }, { footageProvider: reupload, registry, identify });
  assert.equal(b.status, "gap");
  if (b.status === "gap") assert.ok(b.rejected.some((r) => r.reason.includes("SHA-256")));
});

test("URL firmada distinta del MISMO archivo: la URL canónica (sin query) lo identifica", () => {
  assert.equal(canonicalizeUrl("https://Images.Pexels.com/photos/1/p.jpeg?auto=compress&h=650"), canonicalizeUrl("https://images.pexels.com/photos/1/p.jpeg?sig=zzz"));
  const registry = new DocumentAssetRegistry();
  registry.register("s1", { canonicalUrl: canonicalizeUrl("https://cdn.x/a.mp4?token=1") });
  assert.equal(registry.findByReference({ canonicalUrl: canonicalizeUrl("https://cdn.x/a.mp4?token=2") }, "s2")?.key, "canonicalUrl");
  assert.equal(registry.findByReference({ canonicalUrl: canonicalizeUrl("https://cdn.x/a.mp4?token=2") }, "s1"), null, "la propia escena no es duplicado de sí misma");
});

test("hash perceptual: la misma imagen redimensionada/recomprimida es duplicado; otra imagen no", async () => {
  const sharp = (await import("sharp")).default;
  // Estructura a gran escala (bloques 16 px de grises pseudoaleatorios): es lo que el dHash 9×8 compara;
  // el ruido fino se promedia al reducir y NO distingue imágenes (límite documentado en asset-identity.ts).
  const noise = (seed: number) => {
    const raw = Buffer.alloc(96 * 64 * 3);
    let x = seed;
    const blocks: number[] = [];
    for (let b = 0; b < 24; b++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      blocks.push((x >> 16) & 0xff);
    }
    for (let py = 0; py < 64; py++) {
      for (let px = 0; px < 96; px++) {
        const v = blocks[Math.floor(py / 16) * 6 + Math.floor(px / 16)];
        const i = (py * 96 + px) * 3;
        raw[i] = raw[i + 1] = raw[i + 2] = v;
      }
    }
    return sharp(raw, { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer();
  };
  const original = await noise(7);
  const smaller = await sharp(original).resize(60, 40).jpeg({ quality: 60 }).toBuffer();
  const other = await noise(99);
  const [h1, h2, h3] = await Promise.all([dhashImage(original), dhashImage(smaller), dhashImage(other)]);
  assert.ok(hammingHex(h1, h2) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE, `redimensionada: ${hammingHex(h1, h2)}`);
  assert.ok(hammingHex(h1, h3) > PERCEPTUAL_DUPLICATE_MAX_DISTANCE, `distinta: ${hammingHex(h1, h3)}`);
  const registry = new DocumentAssetRegistry();
  registry.register("s1", { dhash: h1 });
  assert.equal(registry.findByContent({ dhash: h2 }, "s2")?.key, "dhash");
});

test("agotamiento de candidatos pertinentes: el tema general NO se usa como búsqueda y el material ajeno se rechaza", async () => {
  const registry = new DocumentAssetRegistry();
  const offTopic = provider({
    byQuery: () => [
      candidate("p1", "woman using smartphone in office"),
      candidate("p2", "container ship port Rotterdam"),
      candidate("p3", "man standing in a doorway"),
    ],
  });
  const out = await selectStockForShot({ shotId: "s1", visual: ship, preferVideo: false, minDurationSec: 4 }, { footageProvider: offTopic, registry, identify });
  assert.equal(out.status, "gap");
  assert.deepEqual(offTopic.searches, selectionQueries(ship), "solo consultas de la MISMA intención");
  assert.ok(!offTopic.searches.some((q) => /canal de panam/i.test(q)));
  assert.equal(offTopic.downloads.length, 0, "nada ajeno se descarga");
  if (out.status === "gap") {
    assert.ok(out.rejected.some((r) => r.reason.includes('época: "container"') || r.reason.includes('lugar: "rotterdam"')));
  }
});

test("pertinencia: léxica y honesta — sin descripción es 'unverified', con contradicción de época/lugar se rechaza", () => {
  assert.equal(assessRelevance(ship, "old steamship passing through canal lock in Panama").relevance, "keyword_match");
  assert.equal(assessRelevance(ship, undefined).relevance, "unverified");
  assert.equal(assessRelevance(ship, "steamship with container cargo").relevance, "irrelevant");
  assert.equal(assessRelevance(ship, "steamship leaving Hamburg harbor").relevance, "irrelevant");
  assert.equal(assessRelevance({ description: "Canal de Panamá esclusas", motion: false, derived: true }, "canal lock").relevance, "unverified");
  assert.equal(describeFromPexelsPageUrl("https://www.pexels.com/video/aerial-view-of-a-ship-3571264/"), "aerial view of a ship");
});

test("anclaje: cada escena lleva SU fragmento narrado y la intención de ese pasaje — nunca visuals[i % n]", () => {
  const narration =
    "En 1914 un barco cruzó de un océano a otro. Durante siglos esa travesía exigía rodear un continente. Francia lo intentó primero y fracasó.";
  const visuals: BeatVisual[] = [
    { description: "steamship crossing canal", motion: true, quote: "En 1914 un barco cruzó" },
    { description: "sailing ship around cape horn storm", motion: true, quote: "Durante siglos esa travesía" },
    { description: "abandoned french excavator jungle", motion: false, quote: "Francia lo intentó primero" },
  ];
  const shots = shotsForSpan({ beatId: "beat-1", beatType: "hook", startSec: 0, endSec: 24, narration, strategy: "balanced", visuals, anchoring: {} });
  assert.equal(shots.length, 6);
  const indices = shots.map((s) => s.intentAnchor?.visualIndex);
  assert.deepEqual(indices, [...indices].sort(), "intenciones contiguas en orden de narración");
  assert.deepEqual(new Set(indices), new Set([0, 1, 2]));
  assert.ok(shots.every((s) => s.narrationFragment && narration.includes(s.narrationFragment.split(" ")[0])));
  assert.notEqual(shots[0].narrationFragment, shots[5].narrationFragment);
  assert.ok(shots.every((s) => s.captionText === s.narrationFragment), "ya no la narración completa del beat");
  // El mismo beat SIN anclaje conserva el comportamiento histórico (planes v1/v2).
  const legacy = shotsForSpan({ beatId: "beat-1", beatType: "hook", startSec: 0, endSec: 24, narration, strategy: "balanced", visuals });
  assert.deepEqual(legacy.map((s) => s.visualIntent), [0, 1, 2, 3, 4, 5].map((i) => visuals[i % 3].description));
});

test("anclaje con tiempos reales por palabra: el fragmento sigue a la voz, no al reparto uniforme", () => {
  const narration = "uno dos tres cuatro cinco seis";
  const words = [0, 1, 2, 3, 4, 5].map((i) => ({ text: narration.split(" ")[i], startSeconds: i < 5 ? i * 0.5 : 7, endSeconds: i < 5 ? i * 0.5 + 0.4 : 7.5 }));
  const ranges = wordRangesForShots([{ startSec: 0, endSec: 4 }, { startSec: 4, endSec: 8 }], 0, 8, narration, words);
  assert.deepEqual(ranges, [{ first: 0, last: 4 }, { first: 5, last: 5 }]);
  const spans = intentWordSpans(narration, [{ description: "a", motion: false }, { description: "b", motion: false }]);
  assert.equal(spans.length, 2);
  assert.equal(anchorIntents(ranges, narration, [{ description: "a", motion: false }, { description: "b", motion: false }])[1].visualIndex, 1);
});

test("tarjetas: solo con dato destacable y nunca con el título del documental", () => {
  assert.equal(salientFact("El 15 de agosto de 1914 el vapor Ancón completó el primer tránsito"), "1914");
  assert.equal(salientFact("elevaría los barcos 26 metros hasta un lago"), "26 metros");
  assert.equal(salientFact("la obra terminó cambiando el comercio"), null);
  const card = anchoredTextCard({ narrationFragment: "Más de 5.000 trabajadores murieron durante la etapa estadounidense", captionText: "" });
  assert.equal(card.title, "5.000 trabajadores");
  assert.doesNotMatch(card.title, /Canal de Panamá/);
  // Ranura "text" sin dato → pasa a imagen (sin tarjeta automática vacía de contenido).
  const shots = shotsForSpan({
    beatId: "b",
    beatType: "setup",
    startSec: 0,
    endSec: 48,
    narration: "Una frase sin cifras que narra algo. Otra frase igual de descriptiva sin datos.",
    strategy: "economical",
    visuals: [{ description: "jungle river", motion: false }],
    anchoring: {},
  });
  assert.ok(shots.every((s) => s.type !== "text"));
});

function execDeps(overrides: Partial<ShotExecutionDeps> & { footageProvider: FootageProvider }): ShotExecutionDeps & { mem: ReturnType<typeof memoryShotAssetStore> } {
  const mem = memoryShotAssetStore();
  return {
    mem,
    topic: "El Canal de Panamá",
    imageProvider: {
      name: "openai",
      capabilities: { id: "o", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
      isAvailable: () => true,
      async generateImage() {
        throw new Error("no se espera imagen IA");
      },
    },
    store: mem.store,
    budget: undefined as unknown as ProductionBudget,
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: 60,
    requireReal: false,
    visualPipeline: "anchored_v1",
    registry: new DocumentAssetRegistry(),
    identify,
    ...overrides,
  };
}

function stockShot(id: string, fragment: string): AllocatedShot {
  return {
    id,
    beatId: "beat-1",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type: "ken_burns_image",
    source: "stock",
    assetId: id,
    visualIntent: ship.description,
    motion: "ken_burns",
    captionText: fragment,
    narrationFragment: fragment,
    anchoredVisual: ship,
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: id,
    status: "planned",
    validationStatus: "pending",
  } as AllocatedShot;
}

test("carencia en ejecución: tarjeta con el PASAJE (no el título), desviación explícita y rastro de rechazos", async () => {
  const deps = execDeps({ footageProvider: provider({ byQuery: () => [candidate("p1", "office laptop meeting")] }) });
  deps.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const ex = await executeShot(stockShot("beat-1-shot-1", "Durante siglos esa travesía había exigido rodear todo un continente"), deps, emptyAiVideoLedgerState());
  assert.equal(ex.executedType, "text");
  assert.match(ex.deviation?.reason ?? "", /carencia de material pertinente/);
  assert.ok(ex.assetMeta?.gap);
  assert.equal(ex.asset.kind, "graphic");
  if (ex.asset.kind === "graphic" && ex.asset.graphic.kind === "text") {
    assert.doesNotMatch(ex.asset.graphic.title, /Canal de Panamá/);
    assert.match(ex.asset.graphic.title, /Durante siglos/);
  }
});

test("continuidad en reintentos: el registro sembrado desde los registros durables impide reutilizar un recurso ya elegido", async () => {
  const pool = provider({ byQuery: () => [candidate("p1", "steamship canal Panama"), candidate("p2", "steamship lock Panama")] });
  const first = execDeps({ footageProvider: pool });
  first.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const exA = await executeShot(stockShot("beat-1-shot-2", "a"), first, emptyAiVideoLedgerState());
  assert.equal(exA.assetMeta?.identity?.sourceId, "p1");
  const record = await first.mem.store.read("beat-1-shot-2", "stock");
  assert.equal(record?.identity?.sourceId, "p1", "la identidad queda en el registro durable");
  assert.equal(record?.provenance?.kind, "stock_illustrative");
  assert.equal(record?.selection?.relevance, "keyword_match");

  // "Reintento": nuevo proceso, nuevo registro sembrado SOLO desde lo durable; una escena anterior aún sin resolver.
  const retryRegistry = new DocumentAssetRegistry();
  retryRegistry.register("beat-1-shot-2", record!.identity!);
  const retry = { ...first, registry: retryRegistry };
  const exB = await executeShot(stockShot("beat-1-shot-1", "b"), retry, emptyAiVideoLedgerState());
  assert.equal(exB.assetMeta?.identity?.sourceId, "p2", "nunca el p1 que ya usa otra escena");
  const exA2 = await executeShot(stockShot("beat-1-shot-2", "a"), retry, emptyAiVideoLedgerState());
  assert.equal(exA2.reused, true, "lo ya resuelto se reutiliza, no se vuelve a buscar");
});

test("muestra inicial (≤ 60 s) del fixture: 0 recursos repetidos, cada escena con su pasaje, 0 tarjetas de título, material ajeno no rellena", async () => {
  const script = documentary180sFixture();
  const plan = computeProductionPlan({ ...script, strategy: "economical", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false });
  // Plan v3: re-armar las escenas del plan (mismas funciones que el worker).
  const { planShotsFromScript, allocateShotTypes, strategyLimits, limitsWithinAllocation, executionAllocation } = await import("./production-plan");
  const { shots, narrationSeconds } = planShotsFromScript(script.beats, script.topic, "economical");
  const allocated = allocateShotTypes(
    shots,
    narrationSeconds,
    limitsWithinAllocation(strategyLimits("economical", plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled: false, units: getGenerativeUnitCosts() }), executionAllocation(plan)),
  );
  const opening = allocated.shots.filter((s) => s.startSec < 60);
  // Catálogo: 3 candidatos pertinentes por intención + 1 ajeno que aparece en TODAS las búsquedas.
  const catalog = provider({
    byQuery: (q) => [
      candidate("generic-doorway-man", "man standing in a doorway"),
      ...[0, 1, 2].map((i) => candidate(`${q}-${i}`, q)),
    ],
  });
  const deps = execDeps({ footageProvider: catalog });
  deps.budget = await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const executions = [];
  for (const shot of opening) executions.push(await executeShot(shot, deps, emptyAiVideoLedgerState()));
  const report = buildVisualReport({ requestId: "fixture", planVersion: 3, topic: script.topic, shots: opening, executions });
  assert.equal(report.summary.repeatedAssets.length, 0);
  assert.equal(report.summary.titleCards.length, 0);
  assert.ok(report.scenes.every((s) => s.narrationFragment && s.narrationFragment.length > 0));
  assert.ok(!executions.some((e) => e.assetMeta?.identity?.sourceId === "generic-doorway-man"), "el recurso genérico ajeno nunca rellena");
  assert.doesNotThrow(() => assertVisualQuality(report));
  assert.ok(report.summary.openingWindow.scenes >= 10 && report.summary.openingWindow.repeatedScenes.length === 0);
});

test("control previo al render (v3): una repetición sin justificación detiene la producción ANTES de renderizar", () => {
  const shots = [stockShot("a", "x"), stockShot("b", "y")];
  const media = (id: string) => ({
    shotId: id,
    asset: { kind: "media" as const, mediaType: "image" as const, url: "u" },
    executedType: "ken_burns_image" as const,
    costUsd: 0,
    bufferBytes: 0,
    providerUsed: "p",
    reused: false,
    attributedCostUsd: 0,
    aiVideoLedger: emptyAiVideoLedgerState(),
    assetMeta: { identity: { sha256: "same" }, objectPath: `o/${id}` },
  });
  const report = buildVisualReport({ requestId: "r", planVersion: 3, topic: "T", shots, executions: [media("a"), media("b")] });
  assert.equal(report.summary.repeatedAssets.length, 1);
  assert.throws(() => assertVisualQuality(report), /repetido/);
  // Plan anterior (v2): el informe se genera pero no bloquea, y declara lo que no puede detectar.
  const legacy = buildVisualReport({ requestId: "r", planVersion: 2, topic: "T", shots, executions: [media("a"), media("b")] });
  assert.doesNotThrow(() => assertVisualQuality(legacy));
  assert.ok(legacy.limitations.some((l) => l.includes("anterior a v3")));
});

test("hash perceptual de VIDEO con el índice (moov) al final — como los MP4 de Pexels: mismo clip reescalado = duplicado", async (t) => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    t.skip("ffmpeg no disponible");
    return;
  }
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-vid-"));
  const make = (name: string, args: string[]) => {
    const out = path.join(dir, name);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, out]);
    assert.equal(r.status, 0, String(r.stderr));
    return fs.readFileSync(out);
  };
  const a = make("a.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  assert.ok(a.indexOf("moov") > a.indexOf("mdat"), "moov al final (no faststart)");
  fs.writeFileSync(path.join(dir, "src.mp4"), a);
  const b = make("b.mp4", ["-i", path.join(dir, "src.mp4"), "-vf", "scale=160:120", "-c:v", "libx264"]);
  const c = make("c.mp4", ["-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const { contentIdentity } = await import("./asset-identity");
  const [ia, ib, ic] = await Promise.all([contentIdentity(a, "video"), contentIdentity(b, "video"), contentIdentity(c, "video")]);
  assert.ok(ia.dhash && ib.dhash && ic.dhash, `sin hash: ${ia.dhashUnavailable ?? ib.dhashUnavailable ?? ic.dhashUnavailable}`);
  assert.ok(hammingHex(ia.dhash, ib.dhash) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE);
  assert.ok(hammingHex(ia.dhash, ic.dhash) > PERCEPTUAL_DUPLICATE_MAX_DISTANCE);
  assert.notEqual(ia.sha256, ib.sha256, "archivos distintos: solo el hash perceptual los une");
  fs.rmSync(dir, { recursive: true, force: true });
});

// Lunar-crater documentary (request 657b2c99): images unrelated to the narration. Synthetic provider texts.
const lunarCrater = { description: "Close view of an impact crater on the lunar surface", motion: false, subject: "lunar crater", place: "Moon" };

test("lunar crater: one shared word, a stem collision or an Earth/festive context no longer passes", () => {
  for (const offTopic of [
    "Volcanic crater lake in Oregon at sunset",
    "Stacked wooden crates in a warehouse",
    "Lunar New Year lanterns over a street",
    "Hikers at the rim of a volcano crater in Iceland",
    "Crater in the desert, Arizona",
  ]) assert.equal(assessRelevance(lunarCrater, offTopic).relevance, "irrelevant", offTopic);
  for (const onTopic of ["Craters on the surface of the moon", "Lunar crater seen from orbit", "Moon surface with many impact craters"]) {
    assert.equal(assessRelevance(lunarCrater, onTopic).relevance, "keyword_match", onTopic);
  }
});

test("stemming keeps distinct words apart and still folds plurals", () => {
  assert.equal(assessRelevance({ description: "wooden crates", motion: false, subject: "crates" }, "crater on the moon").relevance, "irrelevant");
  assert.equal(assessRelevance({ description: "cargo ships", motion: false, subject: "cargo ship" }, "cargo ships in a canal").relevance, "keyword_match");
  assert.equal(assessRelevance({ description: "workers digging", motion: false, subject: "workers" }, "a worker with a shovel").relevance, "keyword_match");
});

test("a multi-word subject needs every word (or its equivalent form), not just one", () => {
  const ironOre = { description: "iron ore train", motion: false, subject: "iron ore" };
  assert.equal(assessRelevance(ironOre, "iron gate of a garden").relevance, "irrelevant");
  assert.equal(assessRelevance(ironOre, "train carrying iron ore").relevance, "keyword_match");
});

test("Earth scenes that mention a meteorite are not treated as off-world", () => {
  const barringer = { description: "Meteor Crater from the air", motion: false, subject: "meteor crater", place: "Arizona" };
  assert.equal(assessRelevance(barringer, "Aerial view of Meteor Crater in the Arizona desert").relevance, "keyword_match");
});

/**
 * Incidente 2026-11-25 — Long Form real de 180,458 s (Drive): un plano prácticamente negro entre ~37–42 s y una
 * estructura/cartel ajena al tema entre ~128–136 s. Reproducción determinista: fixtures en memoria, sin red ni
 * proveedores; las imágenes se generan aquí con sharp y su luminancia se mide de verdad.
 */
async function solidJpeg(r: number, g: number, b: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 96, height: 54, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
}
async function detailedJpeg(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const raw = Buffer.alloc(96 * 54 * 3);
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) { const i = (y * 96 + x) * 3, v = 60 + ((x * 7 + y * 13) % 160); raw[i] = v; raw[i + 1] = v; raw[i + 2] = Math.min(255, v + 30); }
  return sharp(raw, { raw: { width: 96, height: 54, channels: 3 } }).jpeg().toBuffer();
}
const clouds: BeatVisual = { description: "storm clouds condensing into rain over mountains", subject: "clouds", action: "condensing", motion: true };

test("incidente 37–42 s: un candidato prácticamente negro no se usa; se elige el siguiente con señal visual", async () => {
  const black = await solidJpeg(4, 4, 6), good = await detailedJpeg();
  const p = provider({
    byQuery: () => [candidate("dark-1", "storm clouds at night over mountains"), candidate("ok-2", "storm clouds over mountains with rain")],
    bytes: (url) => (url.includes("dark-1") ? black : good),
  });
  const r = await selectStockForShot({ shotId: "s-37", visual: clouds, preferVideo: false, minDurationSec: 4 }, { footageProvider: p, registry: new DocumentAssetRegistry(), identify });
  assert.equal(r.status, "selected");
  assert.equal(r.status === "selected" && r.candidate.sourceId, "ok-2", JSON.stringify(r.rejected));
  assert.ok(r.rejected.some((x) => x.sourceId === "dark-1" && /SIN_SEÑAL_VISUAL: prácticamente negro/.test(x.reason)), JSON.stringify(r.rejected));
});

test("incidente 37–42 s: si TODOS los candidatos son negros, carencia explícita (nunca un plano negro)", async () => {
  const black = await solidJpeg(2, 2, 2);
  const p = provider({ byQuery: () => [candidate("dark-a", "storm clouds over mountains"), candidate("dark-b", "rain clouds condensing")], bytes: () => black });
  const r = await selectStockForShot({ shotId: "s-38", visual: clouds, preferVideo: false, minDurationSec: 4 }, { footageProvider: p, registry: new DocumentAssetRegistry(), identify });
  assert.equal(r.status, "gap");
});

test("incidente 128–136 s: un cartel/estructura que comparte «cloud» no ilustra nubes ni precipitación", async () => {
  const good = await detailedJpeg();
  const p = provider({
    byQuery: () => [
      candidate("billboard-1", "billboard advertising cloud storage on a steel structure by the highway"),
      candidate("tower-2", "cloud over a construction crane and tower"),
      candidate("ok-3", "dark rain clouds condensing over mountains"),
    ],
    bytes: () => good,
  });
  const r = await selectStockForShot({ shotId: "s-128", visual: clouds, preferVideo: false, minDurationSec: 4 }, { footageProvider: p, registry: new DocumentAssetRegistry(), identify });
  assert.equal(r.status === "selected" && r.candidate.sourceId, "ok-3", JSON.stringify(r.rejected));
  assert.ok(!p.downloads.some((u) => /billboard-1|tower-2/.test(u)), "los rechazados por metadatos no se descargan");
  for (const id of ["billboard-1", "tower-2"]) assert.ok(r.rejected.some((x) => x.sourceId === id && /objeto ajeno/.test(x.reason)), `${id}: ${JSON.stringify(r.rejected)}`);
});

test("incidente 128–136 s: también con intención derivada (sin verificar) y en la consulta principal, el cartel se descarta", async () => {
  const derived: BeatVisual = { description: "ice crystals and precipitation", motion: false, derived: true };
  assert.equal(assessRelevance(derived, "ICE arena sign on a building facade").relevance, "irrelevant");
  assert.equal(assessRelevance(derived, "frozen ice crystals on a window").relevance, "unverified");
});

test("señal visual por defecto en VIDEO: un MP4 negro generado localmente se rechaza; uno con imagen, no", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lf-signal-"));
  try {
    const mk = (name: string, src: string) => { const f = join(dir, name); execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-t", "4", "-pix_fmt", "yuv420p", f]); return readFileSync(f); };
    const black = mk("black.mp4", "color=c=black:s=160x90:r=10"), bars = mk("bars.mp4", "testsrc=s=160x90:r=10");
    const vid = (id: string): FootageCandidate => ({ url: `https://cdn.example/${id}.mp4`, sourceId: id, description: "storm clouds condensing over mountains", mediaType: "video", mimeType: "video/mp4", extension: "mp4", durationSeconds: 4 });
    const p: FootageProvider & { searches: string[]; downloads: string[] } = { ...provider({ bytes: (u) => (u.includes("v-black") ? black : bars) }), async searchVideoCandidates() { return [vid("v-black"), vid("v-bars")]; } };
    const r = await selectStockForShot({ shotId: "s-video", visual: clouds, preferVideo: true, minDurationSec: 3 }, { footageProvider: p, registry: new DocumentAssetRegistry(), identify });
    assert.equal(r.status === "selected" && r.candidate.sourceId, "v-bars", JSON.stringify(r.rejected));
    assert.ok(r.rejected.some((x) => x.sourceId === "v-black" && /SIN_SEÑAL_VISUAL/.test(x.reason)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("señal no computable (bytes ilegibles) no rechaza por sí sola; los umbrales son generales, no de este video", async () => {
  const { signalRejection, DARK_MEAN_LUMA, FLAT_LUMA_STD } = await import("./stock-selection");
  assert.equal(signalRejection(null), null);
  assert.equal(signalRejection({ frames: [] }), null);
  assert.match(signalRejection({ frames: [{ meanLuma: 0.02, lumaStd: 0.01 }] }) ?? "", /prácticamente negro/);
  assert.match(signalRejection({ frames: [{ meanLuma: 0.5, lumaStd: 0.005 }] }) ?? "", /plano o corrupto/);
  assert.equal(signalRejection({ frames: [{ meanLuma: 0.02, lumaStd: 0.3 }, { meanLuma: 0.4, lumaStd: 0.2 }, { meanLuma: 0.5, lumaStd: 0.2 }] }), null, "un solo fotograma oscuro de tres (fundido) no basta");
  assert.ok(DARK_MEAN_LUMA > 0 && FLAT_LUMA_STD > 0);
  // Coincidencia débil sin sujeto: «water» solo no basta.
  assert.equal(assessRelevance({ description: "condensation droplets forming on cold glass", motion: false }, "bottle of water on a table").relevance, "irrelevant");
  // Un cartel que la intención SÍ pide sigue siendo válido.
  assert.equal(assessRelevance({ description: "old canal company sign", subject: "sign", motion: false }, "old canal company sign on a wall").relevance, "keyword_match");
});
