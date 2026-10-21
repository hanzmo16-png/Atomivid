import { test } from "node:test";
import assert from "node:assert/strict";
import { ChosenImageProviderError, createImageStyleContext, executeShot, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { getGenerativeUnitCosts, imageUnitUsd, computeProductionPlan } from "./production-plan";
import { jobSupplyDemands } from "@/lib/supply/job";
import type { AllocatedShot } from "./production-plan";
import { GenerativeProviderError, type FootageProvider, type GenerativeAsset, type ImageGenerationRequest, type ImageProvider } from "@/lib/providers/types";

// Recraft for Long Form with the REAL paid-call gate and ledger state machine (in memory); fal itself is simulated.
const STYLE = "6654d01b-7c9d-4f87-9f99-80e6cb989380";
function webp1920x1080() {
  const b = Buffer.alloc(400); b.write("RIFF"); b.writeUInt32LE(392, 4); b.write("WEBP", 8); b.write("VP8X", 12); b.writeUInt32LE(10, 16);
  b.writeUIntLE(1919, 24, 3); b.writeUIntLE(1079, 27, 3); return b;
}
function png() { const b = Buffer.alloc(224); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 72, 68, 82]).copy(b); b.writeUInt32BE(1344, 16); b.writeUInt32BE(768, 20); return b; }

function shot(id: string): AllocatedShot {
  return { id, beatId: "beat-1", startSec: 0, endSec: 5, durationSec: 5, type: "generated_placeholder", plannedType: "generated_placeholder", source: "generated",
    assetId: id, visualIntent: "Marcus Aurelius writing at night in a military tent", motion: "static", captionText: "Escribía de noche.", license: "resolved-at-execution",
    attribution: "", dedupKey: id, status: "planned", validationStatus: "pending" } as AllocatedShot;
}

type Behavior = { submit?: (n: number) => Promise<void> | void; resume?: (id: string, n: number) => Promise<void> | void };
function fakeRecraft(behavior: Behavior = {}) {
  const submitted: ImageGenerationRequest[] = [];
  const resumed: string[] = [];
  const provider: ImageProvider = {
    name: "recraft",
    capabilities: { id: "recraft", models: ["recraft/v4/style/text-to-image"], formats: ["image/webp"], aspectRatios: ["landscape_16_9 (16:9)"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() { throw new Error("Long Form must use the two-step queue path for Recraft"); },
    async submitImage(req) {
      submitted.push(req);
      await behavior.submit?.(submitted.length);
      return { providerJobId: `fal-req-${submitted.length.toString().padStart(4, "0")}` };
    },
    async resumeImage(id, req): Promise<GenerativeAsset> {
      resumed.push(id);
      await behavior.resume?.(id, resumed.length);
      return { buffer: webp1920x1080(), mimeType: "image/webp", extension: "webp", width: 1920, height: 1080, model: "recraft/v4/style/text-to-image",
        costUsd: req.style?.styleId ? 0.035 : 0.04, costBasis: "estimated", providerJobId: id, styleId: req.style?.styleId ?? STYLE };
    },
  };
  return { provider, submitted, resumed };
}

function noStock() {
  let calls = 0;
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage() { calls++; return { url: "https://stock/x.jpg", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }; },
    async searchImageCandidates() { calls++; return []; },
    async downloadFootage() { calls++; return png(); },
  };
  return { provider, calls: () => calls };
}

function styleContext(initial: string | null = null, onStyleId?: (id: string) => Promise<void>) {
  const adopted: string[] = [];
  const ctx = createImageStyleContext({ styleId: initial, referenceImageUrls: ["https://storage.test/ref-0.png?token=a"], match: "precise",
    styleNote: "tonos sepia, luz de vela", onStyleId: onStyleId ?? (async (id) => { adopted.push(id); }) });
  return { ctx, adopted };
}

async function harness(opts: { provider: ImageProvider; style?: ReturnType<typeof styleContext>; allocation?: { maxAiImageGenerations: number; maxAiVideoClips: number; maxGenerativeUsd: number };
  failPutObject?: (p: string) => boolean } ) {
  const mem = memoryShotAssetStore({ failPutObject: opts.failPutObject });
  const ledger = memoryLedgerStore();
  const units = getGenerativeUnitCosts("veo", "recraft");
  const budget = await ProductionBudget.open(memoryBudgetStore(), opts.allocation ?? { maxAiImageGenerations: 10, maxAiVideoClips: 0, maxGenerativeUsd: 1 });
  const stock = noStock();
  const style = opts.style ?? styleContext();
  const deps: ShotExecutionDeps = {
    ledger, topic: "Marco Aurelio y el estoicismo", footageProvider: stock.provider, imageProvider: opts.provider, imageStyle: style.ctx, store: mem.store, budget, units,
    aiVideoCostConfig: { ...getAiVideoCostConfig("balanced"), aiVideoCostPerSecondUsd: 0.12 }, totalDurationSec: 600, requireReal: false, metadata: { requestId: "req-lf-1" },
  };
  return { deps, ledger, stock, style, mem };
}
const run = (s: AllocatedShot, d: ShotExecutionDeps) => executeShot(s, d, emptyAiVideoLedgerState());
const ops = (ledger: ReturnType<typeof memoryLedgerStore>) => [...ledger.ops.values()];

test("precio y plan: Recraft se estima como techo 0.04/imagen y el plan reserva su sobre bajo «recraft»", () => {
  assert.equal(imageUnitUsd("recraft"), 0.04);
  assert.equal(imageUnitUsd("openai"), getGenerativeUnitCosts().imageUsd);
  const beats = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, type: (i === 0 ? "hook" : "context") as never, narration: "Marco Aurelio escribió sus meditaciones en campaña, lejos de Roma, durante años de guerra y peste." }));
  const plan = computeProductionPlan({ beats, topic: "Marco Aurelio", strategy: "balanced", providers: { voice: "elevenlabs", footage: "pexels-video-first", image: "recraft", aiVideo: "veo", music: "curated-library" }, aiVideoEnabled: false });
  assert.equal(plan.providers.image, "recraft");
  assert.ok(plan.aiImageCount > 0, "the balanced plan of this script includes AI images");
  assert.ok(Math.abs((plan.estimatedImageCostUsd ?? -1) - plan.aiImageCount * 0.04) < 1e-6, `${plan.estimatedImageCostUsd} vs ${plan.aiImageCount}`);
  const demands = jobSupplyDemands({ mode: "long_form", script_json: { beats }, recorded_audio_path: null, long_form_production_plan: plan }, "elevenlabs");
  assert.ok(demands.some((d) => d.provider === "recraft"), JSON.stringify(demands));
  assert.ok(!demands.some((d) => d.provider === "openai"), "a Recraft plan never reserves OpenAI images");
});

test("16:9, estilo creado UNA vez y reutilizado: la 2.ª imagen usa el style_id persistido, nunca las referencias", async () => {
  const fal = fakeRecraft();
  const h = await harness({ provider: fal.provider });
  const a = await run(shot("s1"), h.deps);
  const b = await run(shot("s2"), h.deps);
  assert.equal(a.executedType, "generated_placeholder"); assert.equal(b.executedType, "generated_placeholder");
  assert.equal(fal.submitted.length, 2);
  assert.deepEqual(fal.submitted.map((r) => r.aspectRatio), ["16:9", "16:9"]);
  assert.deepEqual(fal.submitted[0].style?.referenceImageUrls?.length, 1);
  assert.equal(fal.submitted[1].style?.styleId, STYLE, "second image reuses the created style");
  assert.equal(fal.submitted[1].style?.referenceImageUrls, undefined);
  assert.deepEqual(h.style.adopted, [STYLE], "style persisted exactly once, before the next image");
  assert.match(fal.submitted[0].prompt, /tonos sepia, luz de vela/);
  assert.match(fal.submitted[0].prompt, /Marcus Aurelius/);
  assert.equal(h.stock.calls(), 0);
  assert.deepEqual(ops(h.ledger).map((o) => [o.provider, o.status]), [["recraft", "COMMITTED"], ["recraft", "COMMITTED"]]);
  assert.equal(a.assetMeta?.provenance?.kind ?? "ai_recreation", "ai_recreation");
  // Retry of the whole production: both images are reused, zero new submissions.
  await run(shot("s1"), h.deps); await run(shot("s2"), h.deps);
  assert.equal(fal.submitted.length, 2);
});

test("interrupción al sondear (timeout con request_id): se detiene SIN stock y el reintento REANUDA el mismo request_id, sin reenviar", async () => {
  let failResume = true;
  const fal = fakeRecraft({ resume: () => { if (failResume) throw new GenerativeProviderError("Recraft no terminó", "recraft", "timeout", undefined, "fal-req-0001"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && e.resumable && /sin reenviarla ni volver a cobrarla/.test(e.customerMessage));
  assert.equal(ops(h.ledger)[0].status, "PROVIDER_JOB_RECORDED");
  assert.equal(ops(h.ledger)[0].providerJobId, "fal-req-0001");
  assert.equal(h.stock.calls(), 0, "never substituted by stock");
  failResume = false;
  const r = await run(shot("s1"), h.deps);
  assert.equal(r.executedType, "generated_placeholder");
  assert.equal(fal.submitted.length, 1, "no second submission");
  assert.deepEqual(fal.resumed, ["fal-req-0001", "fal-req-0001"]);
  assert.equal(ops(h.ledger)[0].status, "COMMITTED");
  assert.deepEqual(h.style.adopted, [STYLE]);
});

test("respuesta perdida en el envío (fal pudo aceptar): estado ambiguo conservado y el reintento NUNCA reenvía", async () => {
  const fal = fakeRecraft({ submit: () => { throw new GenerativeProviderError("Error de red hablando con fal.ai", "recraft", "upstream_error"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && e.paidUncertain);
  assert.equal(ops(h.ledger)[0].status, "RECONCILIATION_REQUIRED");
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  assert.equal(fal.submitted.length, 1, "ambiguous submission is never resent");
  assert.equal(h.stock.calls(), 0);
});

test("429: incierto para el ledger, nunca se reintenta con otra clave", async () => {
  const fal = fakeRecraft({ submit: () => { throw new GenerativeProviderError("fal.ai limitó la velocidad (HTTP 429)", "recraft", "rate_limited"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  assert.equal(fal.submitted.length, 1);
});

test("402 sin saldo: se detiene sin sustituir; tras recargar, el reintento envía con una clave nueva (el rechazo fue REFUNDED)", async () => {
  let funded = false;
  const fal = fakeRecraft({ submit: () => { if (!funded) throw new GenerativeProviderError("saldo insuficiente (HTTP 402)", "recraft", "quota_exceeded"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && !e.paidUncertain && /sin sustituir imágenes/.test(e.customerMessage));
  assert.equal(ops(h.ledger)[0].status, "REFUNDED");
  assert.equal(h.stock.calls(), 0);
  funded = true;
  const r = await run(shot("s1"), h.deps);
  assert.equal(r.executedType, "generated_placeholder");
  assert.equal(fal.submitted.length, 2);
  assert.deepEqual(ops(h.ledger).map((o) => o.status), ["REFUNDED", "COMMITTED"]);
});

test("401 credencial rechazada: sin costo, detenido; nunca otro proveedor ni stock", async () => {
  const fal = fakeRecraft({ submit: () => { throw new GenerativeProviderError("fal.ai rechazó la credencial", "recraft", "authentication_error"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  assert.equal(h.stock.calls(), 0);
});

test("5xx/medio inválido al recuperar el resultado: imagen pagada no usable, detenido sin reenviar", async () => {
  const fal = fakeRecraft({ resume: () => { throw new GenerativeProviderError("fal.ai respondió HTTP 503", "recraft", "upstream_error", undefined, "fal-req-0001"); } });
  const h = await harness({ provider: fal.provider });
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  assert.equal(ops(h.ledger)[0].status, "PROVIDER_JOB_RECORDED", "request id kept for resume/reconciliation");
  assert.equal(fal.submitted.length, 1);
});

test("fallo de subida tras pagar: el reintento no vuelve a pagar la imagen", async () => {
  let failUpload = true;
  const fal = fakeRecraft();
  const h = await harness({ provider: fal.provider, failPutObject: () => failUpload });
  await assert.rejects(run(shot("s1"), h.deps));
  assert.equal(ops(h.ledger)[0].status, "COMMITTED", "the provider charged: the row is committed");
  failUpload = false;
  await assert.rejects(run(shot("s1"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && e.paidUncertain);
  assert.equal(fal.submitted.length, 1, "never paid twice");
});

test("concurrencia: dos ejecuciones simultáneas del mismo plano envían UNA sola vez", async () => {
  const fal = fakeRecraft({ submit: () => new Promise((r) => setTimeout(r, 20)) });
  const h = await harness({ provider: fal.provider });
  const results = await Promise.allSettled([run(shot("s1"), h.deps), run(shot("s1"), h.deps)]);
  assert.equal(fal.submitted.length, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length >= 1, true);
  assert.equal(h.stock.calls(), 0);
});

test("presupuesto de imágenes agotado: se detiene ANTES de llamar a fal (sin cobro, sin stock)", async () => {
  const fal = fakeRecraft();
  const h = await harness({ provider: fal.provider, allocation: { maxAiImageGenerations: 1, maxAiVideoClips: 0, maxGenerativeUsd: 0.04 } });
  await run(shot("s1"), h.deps);
  await assert.rejects(run(shot("s2"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && /presupuesto/.test(e.customerMessage));
  assert.equal(fal.submitted.length, 1);
  assert.equal(h.stock.calls(), 0);
});

test("no se pudo guardar el style_id creado: se detiene y NINGUNA otra imagen se pide en ese intento (nunca un segundo estilo)", async () => {
  const fal = fakeRecraft();
  const h = await harness({ provider: fal.provider, style: styleContext(null, async () => { throw new Error("db down"); }) });
  await assert.rejects(run(shot("s1"), h.deps), ChosenImageProviderError);
  await assert.rejects(run(shot("s2"), h.deps), (e: unknown) => e instanceof ChosenImageProviderError && /estilo/.test(e.customerMessage));
  assert.equal(fal.submitted.length, 1, "the second image was never requested");
  assert.equal(h.stock.calls(), 0);
});

test("estilo dado por el usuario (style_id): nunca crea otro estilo ni usa referencias", async () => {
  const fal = fakeRecraft();
  const h = await harness({ provider: fal.provider, style: styleContext("user-style-12345678") });
  await run(shot("s1"), h.deps);
  assert.equal(fal.submitted[0].style?.styleId, "user-style-12345678");
  assert.deepEqual(h.style.adopted, []);
});
