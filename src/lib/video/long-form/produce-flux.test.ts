function testPng(seed = 0) { const b = Buffer.alloc(224, seed % 256); Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,73,72,68,82]).copy(b); b.writeUInt32BE(1024,16); b.writeUInt32BE(1024,20); return b; }
import type { ObservedMax } from "./spend-cap";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { generateLongFormVideoFromScript, type LongFormRuntime } from "./produce";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan, type VisualStrategy } from "./production-plan";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { memoryBudgetStore } from "./production-budget";
import type { ProgressStageKey } from "./progress";
import { documentary180sFixture } from "./test-fixtures";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { fixtureMusicProvider } from "@/lib/providers/music/fixture";
import type { FootageProvider, ImageProvider, VideoProvider, VoiceProvider } from "@/lib/providers/types";
import { fluxImageProvider } from "@/lib/providers/image/flux";
import { jobSupplyDemands } from "@/lib/supply/job";
import type { LongFormProviderSet } from "./mode";
import type { RenderLongFormDocInput } from "./render";
import { memoryOutputDeps } from "./output-finalize";

/**
 * FLUX (fal.ai) en el pipeline REAL de Long Form: mismo arnés que produce-recraft.test.ts con el ADAPTADOR REAL de FLUX
 * (flux.ts) contra una cola de fal SIMULADA por HTTP (fetch interceptado). Render y storage en memoria.
 *
 * Prueba de integración del pipeline REAL de producción de Long Form
 * (produce.ts) — todo es el código real excepto los proveedores (fakes que
 * cuentan llamadas), el render de Remotion y el storage (en memoria).
 * Nunca hace red ni gasta dinero.
 */

function makeStorage() {
  const files = new Map<string, Buffer>();
  return {
    storage: {
      from() {
        return {
          async download(p: string) {
            const buf = files.get(p);
            return buf
              ? { data: { text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null }
              : { data: null, error: { message: "nf" } };
          },
          async upload(p: string, body: Buffer) {
            files.set(p, Buffer.from(body));
            return { error: null };
          },
        };
      },
    },
  };
}

function counters() {
  return { voice: 0, stock: 0, image: 0, veoSubmits: 0 };
}

function providers(c: ReturnType<typeof counters>, image?: ImageProvider): LongFormProviderSet {
  const voiceProvider: VoiceProvider = {
    name: "fake-elevenlabs",
    async synthesize(text, language, speed) {
      c.voice += 1;
      return fixtureVoiceProvider.synthesize(text, language, speed);
    },
  };
  // Catálogo simulado REALISTA: cada consulta devuelve varios candidatos
  // distintos (id estable, descripción = la consulta, bytes únicos por URL).
  const footageProvider: FootageProvider = {
    name: "fake-pexels",
    async fetchFootage(query) {
      c.stock += 1;
      return { url: `https://stock/v/${encodeURIComponent(query)}.mp4`, mediaType: "video", mimeType: "video/mp4", extension: "mp4" };
    },
    async searchImageCandidates(query) {
      c.stock += 1;
      return Array.from({ length: 12 }, (_, i) => ({
        url: `https://stock/i/${encodeURIComponent(query)}/${i}.jpg?sig=abc`,
        sourceId: `img-${query}-${i}`,
        description: query,
        mediaType: "image" as const,
        mimeType: "image/jpeg",
        extension: "jpg",
      }));
    },
    async downloadFootage(url) {
      return Buffer.from(`stock-bytes:${url.split("?")[0]}`);
    },
  };
  const imageProvider: ImageProvider = {
    name: "fake-openai",
    capabilities: { id: "o", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      c.image += 1;
      return { buffer: testPng(c.image), mimeType: "image/png", extension: "png", model: "m", costUsd: 0.05 };
    },
  };
  return { voiceProvider, footageProvider, imageProvider: image ?? imageProvider, musicProvider: fixtureMusicProvider };
}

type Env = {
  paidCalls: { ledger: ReturnType<typeof memoryLedgerStore>; results: ReturnType<typeof memoryResultStore> };
  supabase: ReturnType<typeof makeStorage>;
  mem: ReturnType<typeof memoryShotAssetStore>;
  budgetStore: ReturnType<typeof memoryBudgetStore>;
  out: ReturnType<typeof memoryOutputDeps>;
  reports: import("./visual-report").VisualReport[];
};
function freshEnv(outputOpts: Parameters<typeof memoryOutputDeps>[0] = {}): Env {
  return { paidCalls: { ledger: memoryLedgerStore(), results: memoryResultStore() }, supabase: makeStorage(), mem: memoryShotAssetStore(), budgetStore: memoryBudgetStore(), out: memoryOutputDeps(outputOpts), reports: [] };
}

function planFor(strategy: VisualStrategy): ProductionPlan {
  const script = documentary180sFixture();
  return computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: { ...REAL_LONG_FORM_PROVIDER_NAMES, image: "flux" }, aiVideoEnabled: false });
}

async function run(
  env: Env,
  c: ReturnType<typeof counters>,
  plan: ProductionPlan,
  opts: {
    videoProvider?: VideoProvider | null;
    beats?: ReturnType<typeof documentary180sFixture>["beats"];
    renders?: { count: number };
    replayOnly?: boolean;
    thumbnails?: { calls: unknown[]; uploads: string[] };
    observedUnitMax?: ObservedMax;
    recraftStyle?: LongFormRuntime["recraftStyle"];
    fluxImages?: boolean;
    image?: ImageProvider;
  } = {},
) {
  const script = documentary180sFixture();
  const events: { stage: ProgressStageKey; completed?: number; total?: number; label?: string }[] = [];
  let renderInput: RenderLongFormDocInput | null = null;
  const runtime: LongFormRuntime = {
    paidCalls: env.paidCalls,
    store: env.mem.store,
    budgetStore: env.budgetStore,
    observedUnitMax: opts.observedUnitMax ?? {},
    videoProvider: opts.videoProvider === undefined ? null : opts.videoProvider,
    aiVideoEnabled: opts.videoProvider ? true : false,
    recordCosts: false,
    resumeBackoffMs: 0,
    uploadArtifact: async (p) => {
      opts.thumbnails?.uploads.push(p);
      return { path: p, url: `memory://${p}` };
    },
    renderThumbnail: async (input) => {
      opts.thumbnails?.calls.push(input);
      const out = path.join(os.tmpdir(), `lf-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      fs.writeFileSync(out, "fake-jpg");
      return out;
    },
    output: env.out.deps,
    replayOnly: opts.replayOnly,
    // Identidad sin ffmpeg/sharp en pruebas (SHA-256 real; sin hash perceptual).
    identify: async (buffer) => ({ sha256: createHash("sha256").update(buffer).digest("hex"), dhashUnavailable: "test" }),
    ...(opts.recraftStyle ? { recraftStyle: opts.recraftStyle } : {}),
    ...(opts.fluxImages ? { fluxImages: true } : {}),
    saveVisualReport: async (report) => {
      env.reports.push(report);
    },
    render: async (input) => {
      renderInput = input;
      if (opts.renders) opts.renders.count += 1;
      for (let f = 0; f <= 5400; f += 540) input.onFrameProgress?.({ renderedFrames: f, totalFrames: 5400 });
      const out = path.join(os.tmpdir(), `lf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(out, "fake-mp4");
      return out;
    },
  };
  const result = await generateLongFormVideoFromScript({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: env.supabase as any,
    requestId: "req-panama-qa",
    artifactPrefix: "req-panama-qa/attempt-1",
    topic: script.topic,
    beats: opts.beats ?? script.beats,
    language: "es",
    plan,
    providers: providers(c, opts.image),
    runtime,
    onProgress: (stage, units) => {
      events.push({ stage, completed: units?.completed, total: units?.total, label: units?.label });
    },
  });
  return { result, events, renderInput: renderInput as RenderLongFormDocInput | null };
}


// ---- Simulated fal.ai queue (HTTP level): the real flux.ts adapter talks to it through fetch. ----
/** Minimal JPEG 1280×720 (SOF0) padded past the byte floor; seed makes each image unique. */
function jpeg1280x720(seed: number) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(720, 5); sof.writeUInt16BE(1280, 7); sof[9] = 3;
  return Buffer.concat([head, sof, Buffer.alloc(4096, seed % 256), Buffer.from([0xff, 0xd9])]);
}
type Fal = { posts: Record<string, unknown>[]; statusCalls: Record<string, number>; resultCalls: string[]; stallJob?: string; refuseWith?: number; nonLoopback: string[] };
function installFal(): { fal: Fal; restore: () => void } {
  const fal: Fal = { posts: [], statusCalls: {}, resultCalls: [], nonLoopback: [] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url === "https://queue.fal.run/fal-ai/flux/dev") {
      assert.equal(init?.method, "POST"); assert.equal(auth, "Key local-fake-fal-key");
      if (fal.refuseWith) return Response.json({ detail: "insufficient balance" }, { status: fal.refuseWith });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      fal.posts.push(body);
      return Response.json({ request_id: `flux-req-${String(fal.posts.length).padStart(4, "0")}` });
    }
    const m = /^https:\/\/queue\.fal\.run\/fal-ai\/flux\/requests\/([^/]+)(\/status)?$/.exec(url);
    if (m) {
      if (m[2]) {
        fal.statusCalls[m[1]] = (fal.statusCalls[m[1]] ?? 0) + 1;
        return Response.json({ status: fal.stallJob === m[1] ? "IN_PROGRESS" : "COMPLETED" });
      }
      fal.resultCalls.push(m[1]);
      return Response.json({ images: [{ url: `https://v3.fal.media/files/${m[1]}.jpg`, width: 1280, height: 720 }], timings: {}, seed: 1, has_nsfw_concepts: [false], prompt: "p" });
    }
    const media = /^https:\/\/v3\.fal\.media\/files\/flux-req-(\d+)\.jpg$/.exec(url);
    if (media) return new Response(jpeg1280x720(Number(media[1])), { headers: { "content-type": "image/jpeg" } });
    fal.nonLoopback.push(url);
    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;
  const saved = { FAL_KEY: process.env.FAL_KEY, FLUX_POLL_INTERVAL_MS: process.env.FLUX_POLL_INTERVAL_MS, FLUX_TIMEOUT_MS: process.env.FLUX_TIMEOUT_MS };
  process.env.FAL_KEY = "local-fake-fal-key"; process.env.FLUX_POLL_INTERVAL_MS = "1"; process.env.FLUX_TIMEOUT_MS = "40";
  return { fal, restore: () => { globalThis.fetch = original; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test("Long Form + FLUX (adaptador real, fal simulado): todas las imágenes IA del plan salen de FLUX en 1280×720, sin estilo", async () => {
  const { fal, restore } = installFal();
  try {
    const c = counters();
    const plan = planFor("balanced");
    assert.equal(plan.providers.image, "flux");
    assert.ok(plan.aiImageCount > 1, "the balanced plan includes several AI images");
    const env = freshEnv();
    const { renderInput } = await run(env, c, plan, { image: fluxImageProvider, fluxImages: true });
    assert.equal(c.image, 0, "the environment image provider (OpenAI-like fake) is never called");
    assert.ok(fal.posts.length > 1 && fal.posts.length <= plan.aiImageCount, `never more than confirmed (${fal.posts.length}/${plan.aiImageCount})`);
    assert.ok(fal.posts.every((p) => JSON.stringify(p.image_size) === JSON.stringify({ width: 1280, height: 720 })), "YouTube: 16:9 landscape");
    assert.ok(fal.posts.every((p) => !("style_id" in p) && !("image_urls" in p) && p.num_images === 1 && p.enable_safety_checker === true));
    const ops = [...env.paidCalls.ledger.ops.values()].filter((o) => o.method === "generate_image");
    assert.equal(ops.length, fal.posts.length, "one ledger row per submission");
    assert.ok(ops.every((o) => o.provider === "flux" && o.status === "COMMITTED" && /^flux-req-/.test(String(o.providerJobId))));
    const committed = ops.reduce((s, o) => s + Number(o.committedUsd), 0);
    assert.ok(Math.abs(committed - 0.025 * ops.length) < 1e-6, `committed ${committed}`);
    assert.ok(committed <= plan.estimatedImageCostUsd! + 1e-9, "never above the confirmed image estimate");
    assert.equal(renderInput?.scenes.length, plan.shotCount);
    assert.deepEqual(fal.nonLoopback, []);
  } finally { restore(); }
});

test("Long Form + FLUX: interrupción al sondear → se detiene (sin stock); el reintento reanuda el MISMO request_id y reutiliza lo pagado", async () => {
  const { fal, restore } = installFal();
  try {
    const plan = planFor("balanced");
    const env = freshEnv();
    fal.stallJob = "flux-req-0002";
    const c1 = counters();
    await assert.rejects(run(env, c1, plan, { image: fluxImageProvider, fluxImages: true }), /FLUX no terminó a tiempo/);
    assert.equal(fal.posts.length, 2, "stopped at the stalled image; nothing after it was submitted");
    const stalled = [...env.paidCalls.ledger.ops.values()].find((o) => o.providerJobId === "flux-req-0002");
    assert.equal(stalled?.status, "PROVIDER_JOB_RECORDED");
    fal.stallJob = undefined;
    const c2 = counters();
    const retry = await run(env, c2, plan, { image: fluxImageProvider, fluxImages: true });
    const keys = [...env.paidCalls.ledger.ops.values()].filter((o) => o.method === "generate_image");
    assert.equal(keys.length, fal.posts.length, "no image submitted twice: the stalled one was resumed, the first reused");
    assert.ok(keys.every((o) => o.status === "COMMITTED"));
    assert.equal(fal.resultCalls.filter((id) => id === "flux-req-0001").length, 1, "paid image 1 reused from storage");
    assert.ok(fal.resultCalls.includes("flux-req-0002"), "the stalled request id was resumed");
    assert.ok(retry.renderInput);
    assert.equal(c1.image + c2.image, 0);
  } finally { restore(); }
});

test("Long Form + FLUX: saldo de fal insuficiente (402) → se detiene sin cobro y sin sustituir (ni stock ni OpenAI)", async () => {
  const { fal, restore } = installFal();
  try {
    fal.refuseWith = 402;
    const env = freshEnv();
    const c = counters();
    await assert.rejects(run(env, c, planFor("balanced"), { image: fluxImageProvider, fluxImages: true }), /No se pudo generar una imagen de FLUX \(rechazada sin costo: quota_exceeded\)/);
    assert.equal(c.image, 0);
    const ops = [...env.paidCalls.ledger.ops.values()].filter((o) => o.method === "generate_image");
    assert.ok(ops.length >= 1 && ops.every((o) => o.status === "REFUNDED" && Number(o.committedUsd ?? 0) === 0));
  } finally { restore(); }
});

test("plan FLUX sin la elección guardada (o al revés): se detiene ANTES de voz o imágenes", async () => {
  const { fal, restore } = installFal();
  try {
    const c = counters();
    await assert.rejects(run(freshEnv(), c, planFor("balanced"), { image: fluxImageProvider }), /no coincide con su plan confirmado/);
    const script = documentary180sFixture();
    const openaiPlan = computeProductionPlan({ beats: script.beats, topic: script.topic, strategy: "balanced", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false });
    await assert.rejects(run(freshEnv(), c, openaiPlan, { fluxImages: true }), /no coincide con su plan confirmado/);
    assert.equal(c.voice, 0); assert.equal(fal.posts.length, 0);
  } finally { restore(); }
});

test("plan FLUX: precio por imagen USD 0,025 y el sobre de supply va al proveedor «flux» (no a recraft ni openai)", () => {
  const plan = planFor("balanced");
  const script = documentary180sFixture();
  const demands = jobSupplyDemands({ mode: "long_form", script_json: script, recorded_audio_path: null, long_form_production_plan: plan }, "elevenlabs");
  assert.ok(demands.some((d) => d.provider === "flux" && d.usd > 0));
  assert.ok(!demands.some((d) => d.provider === "recraft" || d.provider === "openai"));
  assert.ok(Math.abs((plan.estimatedImageCostUsd ?? 0) - 0.025 * plan.aiImageCount) < 1e-6, `estimate ${plan.estimatedImageCostUsd} for ${plan.aiImageCount}`);
});
