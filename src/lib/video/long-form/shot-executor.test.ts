import { test } from "node:test";
import assert from "node:assert/strict";
import { executeShot, type ShotExecutionDeps } from "./shot-executor";
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

test("video IA no disponible (sin proveedor): usa la imagen IA de referencia con movimiento, nunca un fixture", async () => {
  const { deps: d } = await deps();
  const result = await executeShot(shot("ai_video", { motionRequired: true }), d, emptyAiVideoLedgerState());
  assert.equal(result.executedType, "generated_placeholder");
  assert.equal(result.asset.kind, "media");
  assert.ok(result.deviation);
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
