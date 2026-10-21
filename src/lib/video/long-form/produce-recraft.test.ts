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
import { recraftImageProvider } from "@/lib/providers/image/recraft";
import type { LongFormProviderSet } from "./mode";
import type { RenderLongFormDocInput } from "./render";
import { memoryOutputDeps } from "./output-finalize";

/**
 * Recraft (fal.ai) en el pipeline REAL de Long Form: copia del arnés de produce-pipeline.test.ts con el ADAPTADOR REAL
 * de Recraft (recraft.ts) contra una cola de fal SIMULADA por HTTP (fetch interceptado). Render y storage en memoria.
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
  return computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: { ...REAL_LONG_FORM_PROVIDER_NAMES, image: "recraft" }, aiVideoEnabled: false });
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

// ---- Simulated fal.ai queue (HTTP level): the real recraft.ts adapter talks to it through fetch. ----
const STYLE = "7a3f1c2e-9b8d-4e6f-a1b2-c3d4e5f6a7b8";
function webp1920x1080(seed: number) {
  const b = Buffer.alloc(400, seed % 256); b.write("RIFF"); b.writeUInt32LE(392, 4); b.write("WEBP", 8); b.write("VP8X", 12); b.writeUInt32LE(10, 16);
  b.writeUIntLE(1919, 24, 3); b.writeUIntLE(1079, 27, 3); return b;
}
type Fal = { posts: Record<string, unknown>[]; statusCalls: Record<string, number>; resultCalls: string[]; stallJob?: string; nonLoopback: string[] };
function installFal(): { fal: Fal; restore: () => void } {
  const fal: Fal = { posts: [], statusCalls: {}, resultCalls: [], nonLoopback: [] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (url === "https://queue.fal.run/recraft/v4/style/text-to-image") {
      assert.equal(init?.method, "POST"); assert.equal(auth, "Key local-fake-fal-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      fal.posts.push(body);
      return Response.json({ request_id: `fal-req-${String(fal.posts.length).padStart(4, "0")}` });
    }
    const m = /^https:\/\/queue\.fal\.run\/recraft\/v4\/requests\/([^/]+)(\/status)?$/.exec(url);
    if (m) {
      if (m[2]) {
        fal.statusCalls[m[1]] = (fal.statusCalls[m[1]] ?? 0) + 1;
        return Response.json({ status: fal.stallJob === m[1] ? "IN_PROGRESS" : "COMPLETED" });
      }
      fal.resultCalls.push(m[1]);
      return Response.json({ images: [{ url: `https://v3.fal.media/files/${m[1]}.webp` }], style_id: STYLE });
    }
    const media = /^https:\/\/v3\.fal\.media\/files\/fal-req-(\d+)\.webp$/.exec(url);
    if (media) return new Response(webp1920x1080(Number(media[1])), { headers: { "content-type": "image/webp" } });
    fal.nonLoopback.push(url);
    throw new Error(`unexpected network call in test: ${url}`);
  }) as typeof fetch;
  const saved = { FAL_KEY: process.env.FAL_KEY, RECRAFT_POLL_INTERVAL_MS: process.env.RECRAFT_POLL_INTERVAL_MS, RECRAFT_TIMEOUT_MS: process.env.RECRAFT_TIMEOUT_MS };
  process.env.FAL_KEY = "local-fake-fal-key"; process.env.RECRAFT_POLL_INTERVAL_MS = "1"; process.env.RECRAFT_TIMEOUT_MS = "40";
  return { fal, restore: () => { globalThis.fetch = original; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

function styleChoice() {
  const persisted: string[] = [];
  return { persisted, choice: { styleId: null, referenceImageUrls: ["https://storage.test/req-panama-qa/recraft-style/ref-0.png?token=t"], match: "precise" as const,
    styleNote: "grabado antiguo en tinta sepia", onStyleId: async (id: string) => { persisted.push(id); } } };
}

test("Long Form + Recraft (adaptador real, fal simulado): todas las imágenes IA del plan salen de Recraft en 16:9 con UN estilo", async () => {
  const { fal, restore } = installFal();
  try {
    const c = counters();
    const plan = planFor("balanced");
    assert.equal(plan.providers.image, "recraft");
    assert.ok(plan.aiImageCount > 1, "the balanced plan includes several AI images");
    const env = freshEnv();
    const style = styleChoice();
    const { renderInput } = await run(env, c, plan, { image: recraftImageProvider, recraftStyle: style.choice });
    assert.equal(c.image, 0, "the environment image provider (OpenAI-like fake) is never called");
    assert.equal(fal.posts.length, plan.aiImageCount, "exactly the planned number of Recraft images");
    assert.ok(fal.posts.every((p) => p.image_size === "landscape_16_9"), "YouTube: 16:9 landscape");
    assert.deepEqual(Object.keys(fal.posts[0]).sort(), ["enable_safety_checker", "image_size", "image_urls", "prompt", "style_match"]);
    assert.ok(fal.posts.slice(1).every((p) => p.style_id === STYLE && !("image_urls" in p)), "one style created, then reused");
    assert.ok(fal.posts.every((p) => String(p.prompt).includes("grabado antiguo en tinta sepia")));
    assert.deepEqual(style.persisted, [STYLE], "style persisted once");
    const ops = [...env.paidCalls.ledger.ops.values()].filter((o) => o.method === "generate_image");
    assert.equal(ops.length, plan.aiImageCount);
    assert.ok(ops.every((o) => o.provider === "recraft" && o.status === "COMMITTED" && /^fal-req-/.test(String(o.providerJobId))));
    const committed = ops.reduce((s, o) => s + Number(o.committedUsd), 0);
    assert.ok(Math.abs(committed - (0.04 + 0.035 * (plan.aiImageCount - 1))) < 1e-6, `committed ${committed}`);
    assert.equal(renderInput?.scenes.length, plan.shotCount);
    assert.deepEqual(fal.nonLoopback, []);
  } finally { restore(); }
});

test("Long Form + Recraft: interrupción al sondear → se detiene (sin stock); reintento reanuda el MISMO request_id y reutiliza lo pagado", async () => {
  const { fal, restore } = installFal();
  try {
    const plan = planFor("balanced");
    const env = freshEnv();
    const style = styleChoice();
    fal.stallJob = "fal-req-0002";
    const c1 = counters();
    await assert.rejects(run(env, c1, plan, { image: recraftImageProvider, recraftStyle: style.choice }), /Recraft no terminó a tiempo/);
    assert.equal(fal.posts.length, 2, "stopped at the stalled image; nothing after it was submitted");
    const stalled = [...env.paidCalls.ledger.ops.values()].find((o) => o.providerJobId === "fal-req-0002");
    assert.equal(stalled?.status, "PROVIDER_JOB_RECORDED");
    fal.stallJob = undefined;
    const c2 = counters();
    // Retry reads the persisted style_id (as run-job does from the DB).
    const retry = await run(env, c2, plan, { image: recraftImageProvider, recraftStyle: { ...style.choice, styleId: style.persisted[0] ?? null, referenceImageUrls: [] } });
    assert.equal(fal.posts.length, plan.aiImageCount, "no image submitted twice: the stalled one was resumed, the first reused");
    assert.ok(fal.resultCalls.filter((id) => id === "fal-req-0001").length === 1, "paid image 1 reused from storage");
    assert.ok(fal.resultCalls.includes("fal-req-0002"), "the stalled request id was resumed");
    assert.ok(retry.renderInput);
    assert.equal(c1.image + c2.image, 0);
  } finally { restore(); }
});

test("plan Recraft sin la elección guardada (o al revés): se detiene ANTES de voz o imágenes", async () => {
  const { fal, restore } = installFal();
  try {
    const c = counters();
    await assert.rejects(run(freshEnv(), c, planFor("balanced"), { image: recraftImageProvider }), /no coincide con su plan confirmado/);
    assert.equal(c.voice, 0); assert.equal(fal.posts.length, 0);
  } finally { restore(); }
});
