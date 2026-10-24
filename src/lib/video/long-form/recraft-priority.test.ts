import { test } from "node:test";
import assert from "node:assert/strict";
import { prioritizeOriginalImages, recraftImageBudget, recreationEligible, OPENING_SEC, RECRAFT_PRIORITY_VERSION } from "./image-priority";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, getGenerativeUnitCosts } from "./production-plan";
import { checkGeneratedImage } from "./generated-image-qc";
import { ChosenImageProviderError, createImageStyleContext, executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { DocumentAssetRegistry } from "./asset-identity";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import type { AllocatedShot } from "./production-plan";
import type { BeatType, Shot, ShotType } from "./types";
import type { FootageProvider, GenerativeAsset, ImageProvider } from "@/lib/providers/types";

// ---------- planning ----------
function shot(i: number, type: ShotType, beatId: string, extra: Partial<Shot> = {}): Shot {
  return { id: `s${i}`, beatId, startSec: i * 5, endSec: i * 5 + 5, durationSec: 5, type, source: "stock", assetId: `a${i}`, visualIntent: `scene ${i}`,
    motion: "static", captionText: "", license: "", attribution: "", dedupKey: `k${i}`, status: "planned", validationStatus: "pending",
    anchoredVisual: { description: `scene ${i}`, motion: false }, ...extra };
}
const beatTypes = new Map<string, BeatType>([["hook", "hook"], ["setup", "setup"], ["twist", "twist"], ["payoff", "payoff"]]);

test("prioridad: apertura primero, luego momentos clave (giro, cierre); el ciclo de la estrategia no decide", () => {
  const shots = [
    shot(0, "stock_image", "hook"), shot(1, "stock_video", "hook"), // opening (< 30 s)
    ...Array.from({ length: 10 }, (_, k) => shot(6 + k, k % 2 ? "generated_placeholder" : "ken_burns_image", "setup")), // ordinary
    shot(20, "stock_image", "twist"), shot(21, "ken_burns_image", "payoff"),
  ];
  const r = prioritizeOriginalImages(shots, beatTypes, 4);
  const ai = r.shots.filter((s) => s.type === "generated_placeholder").map((s) => s.id);
  assert.deepEqual(ai, ["s0", "s1", "s20", "s21"], "opening + twist + payoff, ahead of ordinary scenes the cycle had marked");
  assert.equal(r.opening, 2); assert.equal(r.keyMoments, 2);
  assert.ok(r.shots.filter((s) => s.beatId === "setup").every((s) => s.type === "ken_burns_image"), "unselected illustrations become archive (pertinent-only)");
  assert.ok(shots[0].startSec < OPENING_SEC);
});

test("escenas protegidas (persona real, prueba documental, acción sin registro) NUNCA se generan, aunque sean apertura", () => {
  const identity = shot(0, "stock_image", "hook", { anchoredVisual: { description: "Marcus Aurelius", motion: false, identity: { name: "Marcus Aurelius" } } as never });
  const evidence = shot(1, "stock_image", "hook", { anchoredVisual: { description: "manuscript page", motion: false, beatClass: "EVIDENCE" } as never });
  const ok = shot(2, "stock_image", "hook");
  assert.equal(recreationEligible(identity), false); assert.equal(recreationEligible(evidence), false); assert.equal(recreationEligible(ok), true);
  const r = prioritizeOriginalImages([identity, evidence, ok], beatTypes, 10);
  assert.deepEqual(r.shots.map((s) => s.type), ["stock_image", "stock_image", "generated_placeholder"]);
  assert.equal(r.protectedScenes, 2);
});

test("tarjetas de dato y video IA previsto se conservan; el metraje en movimiento es el último candidato", () => {
  const r = prioritizeOriginalImages([shot(10, "stock_video", "setup"), shot(11, "text", "setup"), shot(12, "ai_video", "setup"), shot(13, "stock_image", "setup")], beatTypes, 1);
  assert.deepEqual(r.shots.map((s) => s.type), ["stock_video", "text", "ai_video", "generated_placeholder"]);
});

test("presupuesto: imágenes pagables al precio de Recraft, con reserva de regeneración; determinista", () => {
  assert.deepEqual(recraftImageBudget(2, 0.04), { planned: 45, reserve: 5 });
  assert.deepEqual(recraftImageBudget(0.4, 0.04), { planned: 9, reserve: 1 });
  assert.deepEqual(recraftImageBudget(0, 0.04), { planned: 0, reserve: 0 });
  const shots = Array.from({ length: 30 }, (_, i) => shot(i, "stock_image", "setup"));
  assert.deepEqual(prioritizeOriginalImages(shots, beatTypes, 5), prioritizeOriginalImages(shots, beatTypes, 5));
});

const sentence = "Marco Aurelio escribía de noche en su tienda de campaña, a orillas del Danubio, notas para sí mismo sobre el deber y la serenidad. ";
const beats = (["hook", "setup", "discovery", "escalation", "twist", "insight", "payoff", "next_curiosity"] as BeatType[])
  .map((type, i) => ({ id: `b${i}`, type, narration: sentence.repeat(6) }));
const providers = (image: string) => ({ ...REAL_LONG_FORM_PROVIDER_NAMES, image });

test("plan Recraft: prioriza imágenes originales (más que el ciclo OpenAI), apertura cubierta, coste total con estilo y reserva", () => {
  const recraft = computeProductionPlan({ beats, topic: "Marco Aurelio", strategy: "balanced", providers: providers("recraft"), aiVideoEnabled: false });
  const openai = computeProductionPlan({ beats, topic: "Marco Aurelio", strategy: "balanced", providers: providers("openai"), aiVideoEnabled: false });
  const ip = recraft.imagePriority!;
  assert.equal(ip.version, RECRAFT_PRIORITY_VERSION);
  assert.ok(recraft.aiImageCount > openai.aiImageCount, `${recraft.aiImageCount} > ${openai.aiImageCount}`);
  assert.ok(ip.openingImages >= 1 && ip.keyMomentImages >= 1, JSON.stringify(ip));
  assert.equal(ip.perImageUsd, getGenerativeUnitCosts("veo", "recraft").imageUsd);
  assert.equal(ip.ceilingUsd, Math.round((ip.plannedImages + ip.regenerationReserve) * ip.perImageUsd * 10000) / 10000);
  assert.ok(Math.abs((recraft.estimatedImageCostUsd ?? 0) - ip.ceilingUsd) < 1e-6, "shown cost = planned + reserve, style creation included");
  assert.equal(openai.imagePriority, undefined, "OpenAI plans keep the strategy cycle exactly as before");
  assert.equal(computeProductionPlan({ beats, topic: "x", strategy: "economical", providers: providers("recraft"), aiVideoEnabled: false }).aiImageCount, 0);
});

test("mezcla por presupuesto: con menos presupuesto hay menos Recraft, pero la apertura sigue siendo original", () => {
  const prev = process.env.LONG_FORM_MAX_IMAGE_USD;
  process.env.LONG_FORM_MAX_IMAGE_USD = "0.4";
  try {
    const small = computeProductionPlan({ beats, topic: "Marco Aurelio", strategy: "balanced", providers: providers("recraft"), aiVideoEnabled: false });
    assert.equal(small.imagePriority?.plannedImages, 9);
    assert.equal(small.aiImageCount, 9);
    assert.ok((small.imagePriority?.openingImages ?? 0) >= 1);
    assert.ok(small.stockImageCount + small.stockVideoCount > 0, "the rest is archive (used only if pertinent)");
  } finally { if (prev === undefined) delete process.env.LONG_FORM_MAX_IMAGE_USD; else process.env.LONG_FORM_MAX_IMAGE_USD = prev; }
});

// ---------- execution: QC and no irrelevant filler ----------
function webp(w: number, h: number, blank = false) {
  const b = Buffer.alloc(400); if (blank) b[399] = 1; b.write("RIFF"); b.writeUInt32LE(392, 4); b.write("WEBP", 8); b.write("VP8X", 12); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
}
test("control automático: encuadre, resolución y fotograma uniforme; nunca juzga la correspondencia (queda pendiente de revisión humana)", async () => {
  const ok = await checkGeneratedImage({ buffer: webp(1820, 1024) }, "16:9", { stats: async () => ({ stdev: [40, 38, 35] }) });
  assert.equal(ok.passed, true);
  assert.equal((await checkGeneratedImage({ buffer: webp(1024, 1024) }, "16:9", { stats: async () => ({ stdev: [40, 40, 40] }) })).passed, false, "square");
  assert.equal((await checkGeneratedImage({ buffer: webp(640, 360) }, "16:9", { stats: async () => ({ stdev: [40, 40, 40] }) })).passed, false, "too small");
  assert.equal((await checkGeneratedImage({ buffer: webp(1820, 1024) }, "16:9", { stats: async () => ({ stdev: [1, 1, 1] }) })).passed, false, "blank");
  assert.equal((await checkGeneratedImage({ buffer: webp(1792, 1024) }, "16:9", { stats: async () => ({ stdev: [40, 40, 40] }) })).passed, true, "1792x1024 (1.75) is within framing tolerance");
});

function aiShot(id = "s1"): AllocatedShot {
  return { ...shot(1, "generated_placeholder", "hook"), id, plannedType: "generated_placeholder", source: "generated" } as AllocatedShot;
}
function fal(sizes: ([number, number] | [number, number, "blank"])[]) {
  let n = 0; const submitted: string[] = [];
  const provider: ImageProvider = {
    name: "recraft", capabilities: { id: "recraft", models: ["m"], formats: [], aspectRatios: [], timeoutMs: 1, maxRetries: 0 }, isAvailable: () => true,
    async generateImage() { throw new Error("two-step only"); },
    async submitImage() { n++; submitted.push(`fal-req-000${n}`); return { providerJobId: `fal-req-000${n}` }; },
    async resumeImage(id, req): Promise<GenerativeAsset> {
      const [w, h, blank] = sizes[Math.min(Number(id.slice(-1)) - 1, sizes.length - 1)];
      return { buffer: webp(w, h, blank === "blank"), mimeType: "image/webp", extension: "webp", width: w, height: h, model: "m", costUsd: req.style?.styleId ? 0.035 : 0.04, providerJobId: id, styleId: "7a3f1c2e-9b8d-4e6f-a1b2-c3d4e5f6a7b8" };
    },
  };
  return { provider, submitted };
}
async function deps(provider: ImageProvider, footage?: FootageProvider, allocation = { maxAiImageGenerations: 2, maxAiVideoClips: 0, maxGenerativeUsd: 1 }) {
  const mem = memoryShotAssetStore(); const ledger = memoryLedgerStore();
  const d: ShotExecutionDeps = {
    ledger, topic: "Marco Aurelio", imageProvider: provider, store: mem.store, budget: await ProductionBudget.open(memoryBudgetStore(), allocation),
    units: getGenerativeUnitCosts("veo", "recraft"), aiVideoCostConfig: { ...getAiVideoCostConfig("balanced"), aiVideoCostPerSecondUsd: 0.12 }, totalDurationSec: 600,
    requireReal: false, metadata: { requestId: "req-qc" }, imageStats: async (b) => ({ stdev: b[399] === 1 ? [1, 1, 1] : [40, 40, 40] }),
    imageStyle: createImageStyleContext({ styleId: null, referenceImageUrls: ["https://storage.test/r.png"], match: null, styleNote: null, onStyleId: async () => {} }),
    footageProvider: footage ?? { name: "pexels", async fetchFootage() { throw new Error("no stock"); }, async downloadFootage() { return Buffer.alloc(0); } },
    visualPipeline: "anchored_v1", registry: new DocumentAssetRegistry(),
    identify: async (b) => ({ sha256: String(b.length) + Math.random(), dhashUnavailable: "test" }),
  };
  return { d, ledger };
}

test("imagen en blanco: se paga y se registra, NO se usa; se regenera UNA vez (clave nueva) y la buena ocupa la escena", async () => {
  const f = fal([[1820, 1024, "blank"], [1820, 1024]]);
  const { d, ledger } = await deps(f.provider);
  const r = await executeShot(aiShot(), d, emptyAiVideoLedgerState());
  assert.equal(r.executedType, "generated_placeholder");
  assert.equal(f.submitted.length, 2, "exactly one regeneration");
  const ops = [...ledger.ops.values()];
  assert.deepEqual(ops.map((o) => o.status), ["COMMITTED", "COMMITTED"], "the rejected image is accounted as paid, not ambiguous");
  assert.notEqual(ops[0].idempotencyKey, ops[1].idempotencyKey);
  assert.equal(r.assetMeta?.selection?.review?.status, "pendiente_revision_humana", "generated ≠ approved");
});

test("tamaño/encuadre del proveedor (p. ej. 1024x576 o cuadrada): se detiene con UNA imagen pagada, sin regenerar ni usar stock", async () => {
  for (const size of [[1024, 576], [1024, 1024]] as [number, number][]) {
    const f = fal([size, [1820, 1024]]);
    const { d } = await deps(f.provider, undefined, { maxAiImageGenerations: 3, maxAiVideoClips: 0, maxGenerativeUsd: 1 });
    await assert.rejects(executeShot(aiShot(), d, emptyAiVideoLedgerState()), (e: unknown) => e instanceof ChosenImageProviderError && !e.retryable && /no se paga otra generación/.test(e.message));
    assert.equal(f.submitted.length, 1, `${size.join("x")}: no regeneration`);
  }
});

test("defecto también tras regenerar: se detiene (soporte), sin stock y sin una tercera imagen", async () => {
  const f = fal([[1820, 1024, "blank"], [1820, 1024, "blank"]]);
  let stock = 0;
  const footage: FootageProvider = { name: "pexels", async fetchFootage() { stock++; throw new Error("x"); }, async downloadFootage() { stock++; return Buffer.alloc(0); } };
  const { d } = await deps(f.provider, footage, { maxAiImageGenerations: 3, maxAiVideoClips: 0, maxGenerativeUsd: 1 });
  await assert.rejects(executeShot(aiShot(), d, emptyAiVideoLedgerState()), (e: unknown) => e instanceof ChosenImageProviderError && !e.retryable);
  assert.equal(f.submitted.length, 2); assert.equal(stock, 0);
});

test("sin reserva de regeneración: la imagen defectuosa no se sustituye por stock; se detiene", async () => {
  const f = fal([[1820, 1024, "blank"]]);
  const { d } = await deps(f.provider, undefined, { maxAiImageGenerations: 1, maxAiVideoClips: 0, maxGenerativeUsd: 0.04 });
  await assert.rejects(executeShot(aiShot(), d, emptyAiVideoLedgerState()), /reserva para regenerar/);
  assert.equal(f.submitted.length, 1);
});

test("escena de archivo no priorizada: material ajeno a la narración se rechaza; queda una tarjeta con su propio pasaje, nunca relleno", async () => {
  const f = fal([[1820, 1024]]);
  const offTopic: FootageProvider = {
    name: "pexels",
    async fetchFootage() { return { url: "https://stock/v/1.mp4", mediaType: "video", mimeType: "video/mp4", extension: "mp4", sourceId: "v1", description: "smiling business team in a modern office" }; },
    async searchImageCandidates() { return Array.from({ length: 6 }, (_, i) => ({ url: `https://stock/i/${i}.jpg`, sourceId: `p${i}`, description: "colorful birthday cake with candles", mediaType: "image" as const, mimeType: "image/jpeg", extension: "jpg" })); },
    async downloadFootage(u) { return Buffer.from(`bytes:${u}`); },
  };
  const { d } = await deps(f.provider, offTopic);
  const s = { ...shot(30, "ken_burns_image", "setup", { anchoredVisual: { description: "roman legion camp on the Danube at night", motion: false, subject: "roman legion camp", place: "Danube", era: "2nd century" },
    narrationFragment: "Marco Aurelio escribía de noche en su tienda de campaña, a orillas del Danubio." }), plannedType: "ken_burns_image" } as AllocatedShot;
  const r = await executeShot(s, d, emptyAiVideoLedgerState());
  assert.equal(r.executedType, "text", "no off-topic stock fills the scene");
  assert.ok(r.assetMeta?.gap, "the gap is recorded");
  assert.equal(f.submitted.length, 0, "an archive scene never silently becomes a paid image either");
});
