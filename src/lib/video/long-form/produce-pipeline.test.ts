import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateLongFormVideoFromScript, LongFormScriptChangedError, type LongFormRuntime } from "./produce";
import { computeProductionPlan, resolveExecutablePlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan, type VisualStrategy } from "./production-plan";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { memoryBudgetStore } from "./production-budget";
import { computeProductionProgress, type ProgressStageKey } from "./progress";
import { documentary180sFixture } from "./test-fixtures";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { fixtureMusicProvider } from "@/lib/providers/music/fixture";
import type { FootageProvider, ImageProvider, VideoProvider, VoiceProvider } from "@/lib/providers/types";
import type { LongFormProviderSet } from "./mode";
import type { RenderLongFormDocInput } from "./render";
import { memoryOutputDeps } from "./output-finalize";

/**
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

function providers(c: ReturnType<typeof counters>): LongFormProviderSet {
  const voiceProvider: VoiceProvider = {
    name: "fake-elevenlabs",
    async synthesize(text, language, speed) {
      c.voice += 1;
      return fixtureVoiceProvider.synthesize(text, language, speed);
    },
  };
  const footageProvider: FootageProvider = {
    name: "fake-pexels",
    async fetchFootage() {
      c.stock += 1;
      return { url: "https://stock/v.mp4", mediaType: "video", mimeType: "video/mp4", extension: "mp4" };
    },
    async searchImageCandidates() {
      c.stock += 1;
      return [{ url: "https://stock/i.jpg", sourceId: "1", mediaType: "image", mimeType: "image/jpeg", extension: "jpg" }];
    },
    async downloadFootage() {
      return Buffer.from("stock-bytes");
    },
  };
  const imageProvider: ImageProvider = {
    name: "fake-openai",
    capabilities: { id: "o", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      c.image += 1;
      return { buffer: Buffer.from("png"), mimeType: "image/png", extension: "png", model: "m", costUsd: 0.05 };
    },
  };
  return { voiceProvider, footageProvider, imageProvider, musicProvider: fixtureMusicProvider };
}

function fakeVeo(c: ReturnType<typeof counters>): VideoProvider {
  return {
    name: "veo",
    capabilities: { id: "veo", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(req) {
      c.veoSubmits += 1;
      await req.onProviderJobAccepted?.(`op-${c.veoSubmits}`);
      const buffer = Buffer.alloc(64);
      buffer.write("ftyp", 4, "ascii");
      return { buffer, mimeType: "video/mp4", extension: "mp4", durationSeconds: 8, model: "veo", costUsd: 0.96, providerJobId: `op-${c.veoSubmits}` };
    },
  };
}

type Env = {
  supabase: ReturnType<typeof makeStorage>;
  mem: ReturnType<typeof memoryShotAssetStore>;
  budgetStore: ReturnType<typeof memoryBudgetStore>;
  out: ReturnType<typeof memoryOutputDeps>;
};
function freshEnv(outputOpts: Parameters<typeof memoryOutputDeps>[0] = {}): Env {
  return { supabase: makeStorage(), mem: memoryShotAssetStore(), budgetStore: memoryBudgetStore(), out: memoryOutputDeps(outputOpts) };
}

function planFor(strategy: VisualStrategy): ProductionPlan {
  const script = documentary180sFixture();
  return computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true });
}

async function run(
  env: Env,
  c: ReturnType<typeof counters>,
  plan: ProductionPlan,
  opts: { videoProvider?: VideoProvider | null; beats?: ReturnType<typeof documentary180sFixture>["beats"]; renders?: { count: number }; replayOnly?: boolean } = {},
) {
  const script = documentary180sFixture();
  const events: { stage: ProgressStageKey; completed?: number; total?: number; label?: string }[] = [];
  let renderInput: RenderLongFormDocInput | null = null;
  const runtime: LongFormRuntime = {
    store: env.mem.store,
    budgetStore: env.budgetStore,
    videoProvider: opts.videoProvider === undefined ? null : opts.videoProvider,
    aiVideoEnabled: opts.videoProvider ? true : false,
    recordCosts: false,
    resumeBackoffMs: 0,
    uploadArtifact: async (p) => ({ path: p, url: `memory://${p}` }),
    output: env.out.deps,
    replayOnly: opts.replayOnly,
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
    providers: providers(c),
    runtime,
    onProgress: (stage, units) => {
      events.push({ stage, completed: units?.completed, total: units?.total, label: units?.label });
    },
  });
  return { result, events, renderInput: renderInput as RenderLongFormDocInput | null };
}

test("economical confirmado: 0 imágenes IA, 0 video IA — el worker ejecuta la estrategia del snapshot", async () => {
  const c = counters();
  const plan = planFor("economical");
  const { renderInput } = await run(freshEnv(), c, plan, { videoProvider: fakeVeo(c) });
  assert.equal(c.image, 0);
  assert.equal(c.veoSubmits, 0);
  assert.equal(c.voice, 5, "una síntesis por beat");
  assert.equal(renderInput?.scenes.length, plan.shotCount);
});

test("balanced: las imágenes IA ejecutadas coinciden con el plan y NUNCA lo exceden", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv();
  await run(env, c, plan);
  assert.equal(c.image, plan.aiImageCount);
  assert.ok(c.image <= (plan.allocation?.maxAiImageGenerations ?? 0));
  assert.equal(env.budgetStore.current()?.used.aiImageGenerations, plan.aiImageCount);
});

test("reintento del worker (mismo requestId): NO resintetiza la voz ni regenera imágenes — 0 llamadas pagadas nuevas", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv();
  await run(env, c, plan);
  const afterFirst = { ...c };
  await run(env, c, plan);
  assert.equal(c.voice, afterFirst.voice, "ElevenLabs: 0 llamadas nuevas en el reintento");
  assert.equal(c.image, afterFirst.image, "OpenAI Images: 0 llamadas nuevas en el reintento");
  assert.equal(c.stock, afterFirst.stock, "archivo reutilizado desde el store durable");
});

test("cinematic con video IA: envíos a Veo ≤ allocation confirmada, y 0 envíos nuevos en el reintento", async () => {
  const previous = process.env.LONG_FORM_AI_VIDEO_ENABLED;
  process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";
  try {
    const c = counters();
    const plan = computeProductionPlan({ ...documentary180sFixture(), strategy: "cinematic", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true });
    assert.ok(plan.aiVideoClipCount > 0);
    const env = freshEnv();
    const veo = fakeVeo(c);
    await run(env, c, plan, { videoProvider: veo });
    assert.ok(c.veoSubmits > 0 && c.veoSubmits <= plan.aiVideoClipCount, `envíos=${c.veoSubmits} plan=${plan.aiVideoClipCount}`);
    const submits = c.veoSubmits;
    await run(env, c, plan, { videoProvider: veo });
    assert.equal(c.veoSubmits, submits);
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_AI_VIDEO_ENABLED;
    else process.env.LONG_FORM_AI_VIDEO_ENABLED = previous;
  }
});

test("progreso real: monotónico, con unidades reales (narraciones, escenas, fotogramas) y sin la fase ai_video fantasma", async () => {
  const c = counters();
  const { events } = await run(freshEnv(), c, planFor("balanced"));
  assert.ok(!events.some((e) => e.stage === "ai_video"));
  assert.ok(events.some((e) => e.label === "narraciones" && e.completed === 5));
  assert.ok(events.some((e) => e.label === "escenas"));
  assert.ok(events.some((e) => e.label === "fotogramas" && e.completed === 5400));
  let prev = -1;
  for (const e of events) {
    const value = computeProductionProgress({ stage: e.stage, unitsCompleted: e.completed ?? 0, unitsTotal: e.total ?? 0 });
    assert.ok(value >= prev, `retroceso en ${e.stage}: ${prev} -> ${value}`);
    assert.ok(value < 100);
    prev = value;
  }
});

test("guion modificado después de confirmar: falla ANTES de cualquier llamada pagada", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const edited = documentary180sFixture().beats.map((b, i) => (i === 0 ? { ...b, narration: b.narration + " Texto agregado." } : b));
  await assert.rejects(run(freshEnv(), c, plan, { beats: edited }), LongFormScriptChangedError);
  assert.deepEqual(c, { voice: 0, stock: 0, image: 0, veoSubmits: 0 });
});

test("sin confirmación humana: el mismo orden que run-job.ts nunca llega a llamar un proveedor pagado", async () => {
  const c = counters();
  const script = documentary180sFixture();
  const plan = planFor("cinematic");
  await assert.rejects(async () => {
    const confirmed = resolveExecutablePlan({ confirmedAt: null, plan, beats: script.beats });
    await run(freshEnv(), c, confirmed, { videoProvider: fakeVeo(c) });
  }, /confirmación humana/);
  assert.deepEqual(c, { voice: 0, stock: 0, image: 0, veoSubmits: 0 });
});

// --- P0 2026-09-25: entrega del final.mp4 (Canal de Panamá) ---

test("P0: la subida del final.mp4 falla → error seguro; el reintento hace SOLO render+subida: 0 llamadas pagadas nuevas", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  const renders = { count: 0 };
  await assert.rejects(() => run(env, c, plan, { renders }), (err: unknown) => err instanceof Error && err.name === "LongFormOutputError");
  assert.equal(renders.count, 1);
  const afterFail = { ...c };
  const { result } = await run(env, c, plan, { renders });
  assert.deepEqual(c, afterFail, "ElevenLabs/OpenAI/Pexels/Veo: 0 llamadas nuevas en el reintento");
  assert.equal(renders.count, 2, "solo se vuelve a renderizar desde los assets ya persistidos");
  assert.equal(result.videoPath, "req-panama-qa/output/final.mp4", "salida canónica por solicitud, no por intento");
});

test("P0: subida OK pero falló actualizar la fila → el reintento reconcilia la salida existente (0 render, 0 proveedores)", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv({ durationSeconds: 180 });
  const renders = { count: 0 };
  const first = await run(env, c, plan, { renders });
  assert.equal(first.result.reconciled, false);
  const before = { ...c };
  const again = await run(env, c, plan, { renders });
  assert.equal(again.result.reconciled, true);
  assert.equal(again.result.videoPath, first.result.videoPath);
  assert.equal(renders.count, 1, "no se vuelve a renderizar");
  assert.deepEqual(c, before);
});

test("P0: recuperación replayOnly desde lo persistido → misma composición, 0 llamadas a proveedores", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  const original = await run(env, c, plan).catch(() => null);
  assert.equal(original, null, "la ejecución original falló en la entrega");
  const before = { ...c };
  const replay = await run(env, c, plan, { replayOnly: true });
  assert.deepEqual(c, before, "replayOnly: ni voz, ni imágenes, ni archivo, ni Veo");
  assert.equal(replay.renderInput?.scenes.length, plan.shotCount);
  assert.equal(replay.result.videoPath, "req-panama-qa/output/final.mp4");
});

test("P0: replayOnly sin caché (nada persistido) aborta ANTES de renderizar, sin llamar a ningún proveedor", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const renders = { count: 0 };
  await assert.rejects(() => run(freshEnv(), c, plan, { replayOnly: true, renders }), (err: unknown) => err instanceof Error && err.name === "TtsReplayCacheMissError");
  assert.deepEqual(c, counters());
  assert.equal(renders.count, 0);
});

test("P0: replayOnly con UN asset durable faltante aborta (nunca lo reemplaza en silencio por una tarjeta de texto)", async () => {
  const c = counters();
  const plan = planFor("balanced");
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  await run(env, c, plan).catch(() => null);
  const stockKey = [...env.mem.records.keys()].find((k) => k.endsWith(".stock"));
  assert.ok(stockKey);
  env.mem.records.delete(stockKey);
  const before = { ...c };
  const renders = { count: 0 };
  await assert.rejects(() => run(env, c, plan, { replayOnly: true, renders }), (err: unknown) => err instanceof Error && err.name === "LongFormReplayError");
  assert.deepEqual(c, before);
  assert.equal(renders.count, 0);
});
