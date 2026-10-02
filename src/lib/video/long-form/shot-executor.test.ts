import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bindMotionReservations, executeShot, MotionShotUnavailableError, reserveMotionClips, type ShotExecutionDeps } from "./shot-executor";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import type { AllocatedShot } from "./production-plan";
import type { ShotType } from "./types";
import {
  GenerativeProviderError,
  type FootageProvider,
  type GenerativeAsset,
  type ImageGenerationRequest,
  type ImageProvider,
  type VideoProvider,
} from "@/lib/providers/types";

const UNITS = { imageUsd: 0.05, veoClipUsd: 0.96, veoBilledSeconds: 8 };

function shot(type: ShotType, overrides: Partial<AllocatedShot> = {}): AllocatedShot {
  return {
    id: "beat-1-shot-2",
    beatId: "beat-1",
    startSec: 0,
    endSec: 4,
    durationSec: 4,
    type,
    plannedType: type,
    source: "stock",
    assetId: "a",
    visualIntent: "cargo ship crossing canal locks",
    motion: "static",
    captionText: "El canal cambió el comercio. Miles de barcos cruzan cada año.",
    license: "resolved-at-execution",
    attribution: "",
    dedupKey: "k",
    status: "planned",
    validationStatus: "pending",
    ...overrides,
  };
}

function fakeFootage(opts: { fail?: (query: string) => boolean } = {}) {
  const calls: { query: string; orientation?: string; kind: string }[] = [];
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage(query, _min, orientation) {
      calls.push({ query, orientation, kind: "video" });
      if (opts.fail?.(query)) throw new Error("Pexels 429");
      return { url: `https://stock/${encodeURIComponent(query)}.mp4`, mediaType: "video", mimeType: "video/mp4", extension: "mp4" };
    },
    async searchImageCandidates(query, orientation) {
      calls.push({ query, orientation, kind: "image" });
      if (opts.fail?.(query)) throw new Error("Pexels 429");
      return [{ url: `https://stock/${encodeURIComponent(query)}.jpg`, sourceId: "p1", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }];
    },
    async downloadFootage() {
      return Buffer.from("bytes");
    },
  };
  return { provider, calls };
}

function fakeImages(behavior: (req: ImageGenerationRequest, n: number) => Promise<GenerativeAsset>) {
  let calls = 0;
  const provider: ImageProvider = {
    name: "openai",
    capabilities: { id: "openai", models: ["gpt-image"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage(req) {
      calls += 1;
      return behavior(req, calls);
    },
  };
  return { provider, calls: () => calls };
}

const pngAsset = (): GenerativeAsset => ({ buffer: Buffer.from("png"), mimeType: "image/png", extension: "png", model: "gpt-image", costUsd: 0.05 });

async function deps(overrides: Partial<ShotExecutionDeps> = {}, allocation = { maxAiImageGenerations: 5, maxAiVideoClips: 2, maxGenerativeUsd: 5 }) {
  const mem = memoryShotAssetStore();
  const budgetStore = memoryBudgetStore();
  const budget = await ProductionBudget.open(budgetStore, allocation);
  const base: ShotExecutionDeps = {
    topic: "El Canal de Panamá",
    footageProvider: fakeFootage().provider,
    imageProvider: fakeImages(async () => pngAsset()).provider,
    store: mem.store,
    budget,
    units: UNITS,
    aiVideoCostConfig: { ...getAiVideoCostConfig("premium"), aiVideoCostPerSecondUsd: 0.12 },
    totalDurationSec: 180,
    requireReal: false,
    ...overrides,
  };
  return { deps: base, mem, budgetStore };
}

test("stock: busca en 16:9 (landscape) con la intención REAL del shot; el reintento reutiliza sin volver a buscar", async () => {
  const footage = fakeFootage();
  const { deps: d } = await deps({ footageProvider: footage.provider });
  const first = await executeShot(shot("stock_video"), d, emptyAiVideoLedgerState());
  assert.equal(first.asset.kind, "media");
  assert.equal(footage.calls[0].orientation, "landscape");
  assert.equal(footage.calls[0].query, "cargo ship crossing canal locks");
  const again = await executeShot(shot("stock_video"), d, emptyAiVideoLedgerState());
  assert.equal(again.reused, true);
  assert.equal(footage.calls.length, 1);
});

test("stock caído para la consulta del shot → consulta alternativa (tema); si todo falla → tarjeta de texto REAL con desvío", async () => {
  const partial = fakeFootage({ fail: (q) => q !== "El Canal de Panamá" });
  const { deps: d1 } = await deps({ footageProvider: partial.provider });
  const r1 = await executeShot(shot("ken_burns_image"), d1, emptyAiVideoLedgerState());
  assert.equal(r1.asset.kind, "media");
  assert.equal(r1.deviation, undefined);

  const down = fakeFootage({ fail: () => true });
  const { deps: d2 } = await deps({ footageProvider: down.provider });
  const r2 = await executeShot(shot("stock_video"), d2, emptyAiVideoLedgerState());
  assert.equal(r2.asset.kind, "graphic");
  assert.equal(r2.executedType, "text");
  assert.ok(r2.deviation);
  if (r2.asset.kind === "graphic") {
    assert.equal(r2.asset.graphic.kind, "text");
    assert.equal((r2.asset.graphic as { isFixture: boolean }).isFixture, false);
    const card = r2.asset.graphic as { title: string; body: string };
    assert.doesNotMatch(`${card.title} ${card.body}`, /fixture|ejemplo/i);
  }
});

test("imagen IA: se genera UNA vez; el reintento (mismo store) reutiliza — 0 llamadas nuevas, costo 0", async () => {
  const images = fakeImages(async () => pngAsset());
  const { deps: d, budgetStore } = await deps({ imageProvider: images.provider });
  const first = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(first.costUsd, 0.05);
  const retry = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(retry.reused, true);
  assert.equal(retry.costUsd, 0);
  assert.equal(images.calls(), 1);
  assert.equal(budgetStore.current()?.used.aiImageGenerations, 1);
});

test("imagen IA con resultado incierto (timeout): nunca se regenera en el reintento — cae a archivo real con desvío", async () => {
  const images = fakeImages(async () => {
    throw new GenerativeProviderError("timeout", "openai", "timeout");
  });
  const { deps: d } = await deps({ imageProvider: images.provider });
  const first = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(first.executedType, "ken_burns_image");
  assert.match(first.deviation?.reason ?? "", /imagen IA falló/);
  const retry = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.match(retry.deviation?.reason ?? "", /costo incierto/);
  assert.equal(images.calls(), 1, "un STARTED incierto nunca se vuelve a pagar");
});

test("imagen IA rechazada por moderación (costo 0 conocido): libera la reserva y cae a archivo real", async () => {
  const images = fakeImages(async () => {
    throw new GenerativeProviderError("moderación", "openai", "moderation_rejected");
  });
  const { deps: d, budgetStore } = await deps({ imageProvider: images.provider });
  const result = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(result.executedType, "ken_burns_image");
  assert.equal(budgetStore.current()?.used.aiImageGenerations, 0);
});

test("presupuesto de imágenes agotado: el proveedor NUNCA se llama; fallback a archivo real (nunca a algo más caro)", async () => {
  const images = fakeImages(async () => pngAsset());
  const { deps: d } = await deps({ imageProvider: images.provider }, { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const result = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(images.calls(), 0);
  assert.equal(result.executedType, "ken_burns_image");
  assert.match(result.deviation?.reason ?? "", /presupuesto/);
});

function makeStorage() {
  const files = new Map<string, Buffer>();
  return {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            return buf
              ? { data: { text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null }
              : { data: null, error: { message: "nf" } };
          },
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
    },
  };
}

test("video IA (Veo image-to-video): referencia IA + 1 envío; el reintento reutiliza el clip — 0 envíos nuevos", async () => {
  const previous = process.env.LONG_FORM_AI_VIDEO_ENABLED;
  process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";
  try {
    let submits = 0;
    const veo: VideoProvider = {
      name: "veo",
      capabilities: { id: "veo", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
      isAvailable: () => true,
      async generateVideo(req) {
        assert.ok(req.referenceImageUrl, "Veo recibe la imagen de referencia");
        submits += 1;
        await req.onProviderJobAccepted?.(`op-${submits}`);
        const buffer = Buffer.alloc(64);
        buffer.write("ftyp", 4, "ascii");
        return { buffer, mimeType: "video/mp4", extension: "mp4", durationSeconds: 8, model: "veo", costUsd: 0.96, providerJobId: `op-${submits}` };
      },
    };
    const images = fakeImages(async () => pngAsset());
    const { deps: d, budgetStore } = await deps({ imageProvider: images.provider });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeStorage() as any;
    d.videoProvider = wrapDurableVideoProvider(veo, { supabase, scopeId: "req-1", beforeSubmit: () => d.budget.reserveAiVideoSubmit(UNITS.veoClipUsd) });
    const motionShot = shot("ai_video", { visualIntent: "workers digging during canal construction", motionRequired: true, durationSec: 5, endSec: 5 });
    const first = await executeShot(motionShot, d, emptyAiVideoLedgerState());
    assert.equal(first.executedType, "ai_video");
    assert.equal(first.aiVideoLedger.usedClips, 1);
    const retry = await executeShot(motionShot, d, emptyAiVideoLedgerState());
    assert.equal(retry.reused, true);
    assert.equal(submits, 1);
    assert.equal(images.calls(), 1, "la referencia tampoco se regenera");
    assert.equal(budgetStore.current()?.used.aiVideoSubmits, 1);
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_AI_VIDEO_ENABLED;
    else process.env.LONG_FORM_AI_VIDEO_ENABLED = previous;
  }
});

async function reserveClip(store: ShotExecutionDeps["store"], ref: string, durationSec: number) {
  const objectPath = store.objectPathFor(ref, "stock", "mp4");
  await store.putObject(objectPath, Buffer.from(`clip:${ref}`), "video/mp4");
  await store.write({ shotId: ref, kind: "stock", status: "COMPLETED", objectPath, contentType: "video/mp4", mediaType: "video", costUsd: 0, provider: "pexels-video-first", bytes: 9, updatedAtIso: "x", identity: { provider: "pexels-video-first", sourceId: ref, sha256: ref }, clipDurationSec: durationSec });
  return objectPath;
}

test("B5.1: video IA no disponible (sin proveedor) en una escena motion:true → su clip reservado, nunca la imagen IA con Ken Burns; 0 imágenes IA, 0 búsquedas", async () => {
  const images = fakeImages(async () => pngAsset());
  const footage = fakeFootage();
  const { deps: d, mem } = await deps({ imageProvider: images.provider, footageProvider: footage.provider });
  await reserveClip(mem.store, "motionres-beat-1-v0-0", 12);
  const result = await executeShot(shot("ai_video", { motionRequired: true, motionVisualId: "beat-1-v0", motionClipRef: "motionres-beat-1-v0-0" }), d, emptyAiVideoLedgerState());
  assert.equal(footage.calls.length, 0, "la ejecución no vuelve a buscar archivo");
  assert.equal(result.executedType, "stock_video");
  assert.equal(result.asset.kind, "media");
  assert.equal(result.asset.kind === "media" ? result.asset.mediaType : null, "video");
  assert.equal(images.calls(), 0, "sin proveedor de video IA no se paga una imagen de referencia");
  assert.ok(result.deviation, "el cambio ai_video → stock_video queda registrado");
});

test("B5.1: escena motion:true sin video IA y con archivo solo en imagen fija → la producción se detiene; nada se sustituye, 0 imágenes IA", async () => {
  const images = fakeImages(async () => pngAsset());
  const stills: FootageProvider = {
    name: "stills-only",
    async fetchFootage() { return { url: "https://stock/x.jpg", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }; },
    async downloadFootage() { return Buffer.from("jpg"); },
  };
  for (const type of ["ai_video", "stock_video"] as const) {
    const { deps: d } = await deps({ imageProvider: images.provider, footageProvider: stills });
    await assert.rejects(executeShot(shot(type, { motionRequired: true }), d, emptyAiVideoLedgerState()), MotionShotUnavailableError);
  }
  assert.equal(images.calls(), 0);
});

test("B5.1: escena motion:false con el presupuesto de imágenes agotado sigue el fallback actual (archivo con Ken Burns)", async () => {
  const images = fakeImages(async () => pngAsset());
  const { deps: d } = await deps({ imageProvider: images.provider }, { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const result = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(images.calls(), 0);
  assert.equal(result.executedType, "ken_burns_image");
});

test("tarjeta de texto: tema + oración real de la narración, sin marca de fixture", async () => {
  const { deps: d } = await deps();
  const result = await executeShot(shot("text"), d, emptyAiVideoLedgerState());
  assert.equal(result.asset.kind, "graphic");
  if (result.asset.kind === "graphic" && result.asset.graphic.kind === "text") {
    assert.equal(result.asset.graphic.title, "El Canal de Panamá");
    assert.equal(result.asset.graphic.body, "Miles de barcos cruzan cada año.");
    assert.equal(result.asset.graphic.isFixture, false);
  }
});

// --- PI V2 B5.2: reserva por visual, consumo sin segunda búsqueda ---

test("B5.2-3: el timing medido alarga un plano motion:true → se parte y consume el clip de margen; 0 búsquedas; nunca still", async () => {
  const footage = fakeFootage();
  const images = fakeImages(async () => pngAsset());
  const { deps: d, mem } = await deps({ footageProvider: footage.provider, imageProvider: images.provider });
  for (const k of [0, 1, 2]) await reserveClip(mem.store, `motionres-beat-1-v0-${k}`, 5);
  const reservations = new Map([["beat-1-v0", [0, 1, 2].map((k) => ({ ref: `motionres-beat-1-v0-${k}`, durationSec: 5 }))]]);
  // Estimado: 3.5 s por plano; medido: el primer plano dura 7 s (> 5 s - 1.2 s de margen).
  const shots = [
    shot("stock_video", { id: "beat-1-shot-1", startSec: 0, endSec: 7, durationSec: 7, motionRequired: true, motionVisualId: "beat-1-v0" }),
    shot("ken_burns_image", { id: "beat-1-shot-2", startSec: 7, endSec: 11, durationSec: 4 }),
  ];
  const bound = bindMotionReservations(shots, reservations);
  assert.deepEqual(bound.map((s) => [s.id, s.type, s.startSec, s.endSec, s.motionClipRef]), [
    ["beat-1-shot-1", "stock_video", 0, 3.5, "motionres-beat-1-v0-0"],
    ["beat-1-shot-1-m2", "stock_video", 3.5, 7, "motionres-beat-1-v0-1"],
    ["beat-1-shot-2", "ken_burns_image", 7, 11, undefined],
  ]);
  const executed = [];
  for (const s of bound.slice(0, 2)) executed.push(await executeShot(s, d, emptyAiVideoLedgerState()));
  assert.deepEqual(executed.map((e) => [e.executedType, e.asset.kind === "media" ? e.asset.url : ""]), [
    ["stock_video", "memory://req/assets/motionres-beat-1-v0-0.stock.mp4"],
    ["stock_video", "memory://req/assets/motionres-beat-1-v0-1.stock.mp4"],
  ]);
  assert.equal(footage.calls.length, 0);
  assert.equal(images.calls(), 0);
  // Sin clips suficientes: el job falla, sin sustitución.
  assert.throws(() => bindMotionReservations([shots[0]], new Map([["beat-1-v0", [{ ref: "motionres-beat-1-v0-0", durationSec: 5 }]]])), MotionShotUnavailableError);
  // Un clip que no cubre el plano tampoco se usa en ejecución.
  await assert.rejects(executeShot({ ...bound[0], durationSec: 6 }, d, emptyAiVideoLedgerState()), MotionShotUnavailableError);
});

test("B5.2: la reserva aplica los criterios reales (relevancia, duración, video, únicos) y se guarda durable; un segundo intento no busca", async () => {
  const { mem } = await deps();
  let searches = 0;
  const provider: FootageProvider = {
    name: "pexels-video-first",
    async fetchFootage() { throw new Error("no se usa"); },
    async searchVideoCandidates(q) {
      searches += 1;
      return [
        { url: "https://v/cat.mp4", sourceId: "cat", description: "cat sleeping on a sofa", mediaType: "video", mimeType: "video/mp4", extension: "mp4", durationSeconds: 30 },
        { url: "https://v/short.mp4", sourceId: "short", description: q, mediaType: "video", mimeType: "video/mp4", extension: "mp4", durationSeconds: 2 },
        { url: "https://v/a.mp4", sourceId: "a", description: q, mediaType: "video", mimeType: "video/mp4", extension: "mp4", durationSeconds: 10 },
        { url: "https://v/b.mp4", sourceId: "b", description: q, mediaType: "video", mimeType: "video/mp4", extension: "mp4", durationSeconds: 10 },
      ];
    },
    async downloadFootage(url) { return Buffer.from(`bytes:${url}`); },
  };
  const demand = { visualId: "beat-1-v0", visual: { description: "workers digging canal locks", motion: true }, clips: 2, minDurationSec: 6 };
  const identify = async (b: Buffer) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" });
  const first = await reserveMotionClips([demand], { footageProvider: provider, store: mem.store, identify }, { searchAllowed: true });
  assert.deepEqual(first.get("beat-1-v0")!.map((c) => c.identity?.sourceId), ["a", "b"], "ni el gato (irrelevante) ni el clip de 2 s");
  const searchesAfterFirst = searches;
  const again = await reserveMotionClips([demand], { footageProvider: provider, store: mem.store, identify }, { searchAllowed: true });
  assert.deepEqual(again.get("beat-1-v0")!.map((c) => c.ref), first.get("beat-1-v0")!.map((c) => c.ref));
  assert.equal(searches, searchesAfterFirst, "retry: 0 búsquedas nuevas");
  await assert.rejects(reserveMotionClips([{ ...demand, clips: 3 }], { footageProvider: provider, store: mem.store, identify }, { searchAllowed: false }), /reserva de movimiento incompleta/);
});

test("B5.2-5: motion:false con el presupuesto de imágenes agotado sigue el fallback actual, sin reserva", async () => {
  const images = fakeImages(async () => pngAsset());
  const { deps: d } = await deps({ imageProvider: images.provider }, { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
  const result = await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
  assert.equal(images.calls(), 0);
  assert.equal(result.executedType, "ken_burns_image");
  assert.deepEqual(bindMotionReservations([shot("ken_burns_image")], new Map()).map((s) => s.type), ["ken_burns_image"]);
});

// --- PI V2 B5.3b (RB-08): plan confirmado y executor no divergen en motion:true ---

test("B5.3: mismo guion motion:true → el plan confirmado solo asigna ai_video/stock_video y el executor solo consume un clip reservado de ESE visualId (3 estrategias, video IA on/off)", async () => {
  const { allocateShotTypes, computeProductionPlan, executionAllocation, getGenerativeUnitCosts, limitsWithinAllocation, planShotsFromScript, REAL_LONG_FORM_PROVIDER_NAMES, strategyLimits } = await import("./production-plan");
  const { motionDemands } = await import("./produce");
  const { documentary180sFixture } = await import("./test-fixtures");
  const script = documentary180sFixture();
  const MOVING = new Set(["ai_video", "stock_video"]);
  const OFF_CONTRACT = new Set(["ken_burns_image", "generated_placeholder", "stock_image", "text", "diagram", "map"]);
  for (const strategy of ["economical", "balanced", "cinematic"] as const) {
    for (const aiVideoEnabled of [false, true]) {
      const label = `${strategy} aiVideo=${aiVideoEnabled}`;
      const plan = computeProductionPlan({ ...script, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled });
      const { shots, narrationSeconds } = planShotsFromScript(script.beats, script.topic, strategy);
      const limits = limitsWithinAllocation(strategyLimits(strategy, plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled, units: getGenerativeUnitCosts() }), executionAllocation(plan));
      const allocated = allocateShotTypes(shots, narrationSeconds, limits).shots;
      const motion = allocated.filter((s) => s.motionRequired);
      assert.ok(motion.length > 0, `${label}: el fixture tiene escenas motion:true`);
      const offContract = motion.filter((s) => !MOVING.has(s.type) || OFF_CONTRACT.has(s.type));
      assert.deepEqual(offContract.map((s) => `${s.id}:${s.type}`), [], `${label}: offContract=0`);

      // Reserva del worker para el mismo guion y plan; cada clip vive en el store durable.
      const demands = motionDemands(script.beats, script.topic, plan.beatShotCounts);
      const demandIds = new Set(demands.map((d) => d.visualId));
      const unreserved = motion.filter((s) => !s.motionVisualId || !demandIds.has(s.motionVisualId));
      assert.deepEqual(unreserved.map((s) => s.id), [], `${label}: unreserved=0`);

      const images = fakeImages(async () => pngAsset());
      const noStock: FootageProvider = {
        name: "must-not-search",
        async fetchFootage() { throw new Error("la ejecución motion no debe buscar archivo"); },
        async searchVideoCandidates() { throw new Error("la ejecución motion no debe buscar archivo"); },
        async downloadFootage() { throw new Error("la ejecución motion no debe descargar archivo"); },
      };
      const { deps: d, mem } = await deps({ imageProvider: images.provider, footageProvider: noStock });
      const reservations = new Map<string, { ref: string; durationSec: number }[]>();
      for (const demand of demands) {
        const clips = [];
        for (let k = 0; k < demand.clips; k++) {
          const ref = `motionres-${demand.visualId}-${k}`;
          await reserveClip(mem.store, ref, 30);
          clips.push({ ref, durationSec: 30 });
        }
        reservations.set(demand.visualId, clips);
      }

      const bound = bindMotionReservations(allocated, reservations);
      for (const s of bound.filter((x) => x.motionRequired)) {
        const own = (reservations.get(s.motionVisualId!) ?? []).map((c) => c.ref);
        assert.ok(s.motionClipRef && own.includes(s.motionClipRef), `${label}: ${s.id} ligado a un clip de SU visual ${s.motionVisualId}`);
        const execution = await executeShot(s, d, emptyAiVideoLedgerState());
        assert.ok(MOVING.has(execution.executedType), `${label}: ${s.id} ejecutado como ${execution.executedType}`);
        assert.ok(execution.asset.kind === "media" && execution.asset.mediaType === "video", `${label}: ${s.id} se ve como video`);
        if (execution.executedType === "stock_video") {
          assert.equal(execution.asset.kind === "media" ? execution.asset.url : "", `memory://${mem.store.objectPathFor(s.motionClipRef!, "stock", "mp4")}`, `${label}: ${s.id} consume exactamente su clip reservado`);
        }
      }
      assert.equal(images.calls(), 0, `${label}: sin proveedor de video IA no se paga imagen de referencia`);
    }
  }
});

test("COST-A2-3 imagen IA: upstream_error / rate_limited → una sola llamada, sin reintento automático; el reintento del job tampoco vuelve a pagar", async () => {
  for (const reason of ["upstream_error", "rate_limited"] as const) {
    const images = fakeImages(async () => {
      throw new GenerativeProviderError(`openai ${reason}`, "openai", reason);
    });
    const { deps: d } = await deps({ imageProvider: images.provider });
    await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
    assert.equal(images.calls(), 1, `${reason}: retry automático = 0`);
    await executeShot(shot("generated_placeholder"), d, emptyAiVideoLedgerState());
    assert.equal(images.calls(), 1, `${reason}: el reintento no vuelve a llamar`);
  }
});
