import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { generateLongFormVideoFromScript, LongFormScriptChangedError, type LongFormRuntime } from "./produce";
import { allocateShotTypes, computeProductionPlan, MotionRequiredUnsatisfiableError, planShotsFromScript, resolveExecutablePlan, REAL_LONG_FORM_PROVIDER_NAMES, strategyLimits, type ProductionPlan, type VisualStrategy } from "./production-plan";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { memoryBudgetStore } from "./production-budget";
import { computeProductionProgress, type ProgressStageKey } from "./progress";
import { documentary180sFixture } from "./test-fixtures";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { fixtureMusicProvider } from "@/lib/providers/music/fixture";
import type { FootageProvider, ImageProvider, MusicProvider, MusicSelectionContext, VideoProvider, VoiceProvider } from "@/lib/providers/types";
import type { LongFormProviderSet } from "./mode";
import type { RenderLongFormDocInput } from "./render";
import { memoryOutputDeps } from "./output-finalize";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { gatedMusicTrack, loadCommittedMusicTrack } from "@/lib/paid-calls/gated-providers";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { visualsForBeat } from "./visual-intents";
import { selectionQueries } from "./stock-selection";

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
  // Catálogo simulado REALISTA: cada consulta devuelve varios candidatos
  // distintos (id estable, descripción = la consulta, bytes únicos por URL).
  const footageProvider: FootageProvider = {
    name: "fake-pexels",
    async fetchFootage(query) {
      c.stock += 1;
      return { url: `https://stock/v/${encodeURIComponent(query)}.mp4`, mediaType: "video", mimeType: "video/mp4", extension: "mp4" };
    },
    // Como el proveedor real: búsqueda de candidatos de VIDEO (las escenas con motion:true solo
    // admiten video en movimiento — PI V2 B5.1).
    async searchVideoCandidates(query) {
      c.stock += 1;
      return Array.from({ length: 12 }, (_, i) => ({
        url: `https://stock/v/${encodeURIComponent(query)}/${i}.mp4?sig=abc`,
        sourceId: `vid-${query}-${i}`,
        description: query,
        mediaType: "video" as const,
        mimeType: "video/mp4",
        extension: "mp4",
        durationSeconds: 12,
      }));
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
      return { buffer: Buffer.from(`png-${c.image}`), mimeType: "image/png", extension: "png", model: "m", costUsd: 0.05 };
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
  ledger: ReturnType<typeof memoryLedgerStore>;
  out: ReturnType<typeof memoryOutputDeps>;
  reports: import("./visual-report").VisualReport[];
};
function freshEnv(outputOpts: Parameters<typeof memoryOutputDeps>[0] = {}): Env {
  return { supabase: makeStorage(), mem: memoryShotAssetStore(), budgetStore: memoryBudgetStore(), ledger: memoryLedgerStore(), out: memoryOutputDeps(outputOpts), reports: [] };
}

function planFor(strategy: VisualStrategy): ProductionPlan {
  const script = documentary180sFixture();
  return computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true });
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
    providersOverride?: Partial<LongFormProviderSet>;
    artifacts?: Map<string, Buffer>;
  } = {},
) {
  const script = documentary180sFixture();
  const events: { stage: ProgressStageKey; completed?: number; total?: number; label?: string }[] = [];
  let renderInput: RenderLongFormDocInput | null = null;
  const runtime: LongFormRuntime = {
    store: env.mem.store,
    budgetStore: env.budgetStore,
    ledger: env.ledger,
    videoProvider: opts.videoProvider === undefined ? null : opts.videoProvider,
    aiVideoEnabled: opts.videoProvider ? true : false,
    recordCosts: false,
    resumeBackoffMs: 0,
    uploadArtifact: async (p, buffer) => {
      opts.thumbnails?.uploads.push(p);
      opts.artifacts?.set(p, Buffer.from(buffer));
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
    providers: { ...providers(c), ...opts.providersOverride },
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

// --- Calidad visual M1: compatibilidad con planes anteriores ---

test("plan v2 (anterior a M1): se ejecuta con el reparto histórico y el informe se marca 'legacy' sin bloquear", async () => {
  const c = counters();
  const v2 = { ...planFor("balanced"), version: 2, beatShotCounts: undefined };
  const env = freshEnv({ durationSeconds: 180 });
  const { renderInput } = await run(env, c, v2);
  assert.ok(renderInput);
  const report = env.reports.at(-1);
  assert.equal(report?.pipeline, "legacy");
  assert.ok(report?.scenes.every((s) => s.narrationFragment === null), "v2 no ancla escenas");
  assert.ok(report?.limitations.some((l) => l.includes("anterior a v3")));
});

test("plan v3: informe con cada escena anclada, 0 repeticiones y procedencia en cada recurso", async () => {
  const c = counters();
  const env = freshEnv({ durationSeconds: 180 });
  await run(env, c, planFor("balanced"));
  const report = env.reports.at(-1);
  assert.equal(report?.pipeline, "anchored_v1");
  assert.equal(report?.summary.repeatedAssets.length, 0);
  assert.equal(report?.summary.titleCards.length, 0);
  assert.ok(report?.scenes.every((s) => s.narrationFragment && s.narrationFragment.length > 0));
  assert.ok(report?.scenes.filter((s) => s.display !== "card").every((s) => s.provenance === "stock_illustrative" || s.provenance === "ai_recreation"));
  assert.ok(report?.scenes.filter((s) => s.provenance === "ai_recreation").every((s) => s.relevance === "generated_from_intent"));
});

const packagingBoth = {
  cover: { enabled: true, style: "impacto" as const, title: "Cavar una *montaña*", kicker: "Canal de Panamá" },
  thumbnail: { enabled: true, style: "alerta" as const, title: "Cavar una *montaña*" },
};

test("presentación v3: portada en el render y miniatura subida junto al video (ruta canónica)", async () => {
  const c = counters();
  const env = freshEnv({ durationSeconds: 180 });
  const thumbnails = { calls: [] as unknown[], uploads: [] as string[] };
  const { result, renderInput } = await run(env, c, { ...planFor("balanced"), packaging: packagingBoth }, { thumbnails });
  assert.equal(renderInput?.opening?.title, "Cavar una *montaña*");
  assert.equal(thumbnails.calls.length, 1);
  const call = thumbnails.calls[0] as { cover: { style: string }; background: { url: string } };
  assert.equal(call.cover.style, "alerta");
  assert.ok(call.background.url);
  assert.ok(thumbnails.uploads.includes("req-panama-qa/output/thumbnail.jpg"));
  assert.equal(result.thumbnailPath, "req-panama-qa/output/thumbnail.jpg");
});

test("presentación independiente: solo miniatura → sin portada en el video", async () => {
  const c = counters();
  const env = freshEnv({ durationSeconds: 180 });
  const thumbnails = { calls: [] as unknown[], uploads: [] as string[] };
  const onlyThumb = { ...packagingBoth, cover: { ...packagingBoth.cover, enabled: false } };
  const { renderInput } = await run(env, c, { ...planFor("balanced"), packaging: onlyThumb }, { thumbnails });
  assert.equal(renderInput?.opening, undefined);
  assert.equal(thumbnails.calls.length, 1);
});

test("v1/v2 no cambian: un plan v2 con presentación no añade portada ni miniatura; v3 sin presentación tampoco", async () => {
  const c = counters();
  const thumbnails = { calls: [] as unknown[], uploads: [] as string[] };
  const v2 = { ...planFor("balanced"), version: 2, beatShotCounts: undefined, packaging: packagingBoth };
  const { renderInput } = await run(freshEnv({ durationSeconds: 180 }), c, v2, { thumbnails });
  assert.equal(renderInput?.opening, undefined);
  assert.equal(thumbnails.calls.length, 0);
  const plain = await run(freshEnv({ durationSeconds: 180 }), counters(), planFor("balanced"), { thumbnails });
  assert.equal(plain.renderInput?.opening, undefined);
  assert.equal(thumbnails.calls.length, 0);
});

test("Runway plan executes 10s clips at its own cost and reuses completed output", async () => {
  const previous = process.env.LONG_FORM_AI_VIDEO_ENABLED;
  process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";
  try {
    const c = counters();
    const plan = computeProductionPlan({ ...documentary180sFixture(), strategy: "cinematic", providers: { ...REAL_LONG_FORM_PROVIDER_NAMES, aiVideo: "runway" }, aiVideoEnabled: true });
    assert.ok(plan.aiVideoClipCount > 0);
    const env = freshEnv();
    const fake = fakeVeo(c);
    const runway: VideoProvider = { ...fake, name: "runway", async generateVideo(req) {
      assert.equal(req.durationSeconds, 10);
      assert.equal(req.maxCostUsd, 0.5);
      return { ...await fake.generateVideo(req), durationSeconds: 10, costUsd: 0.5, model: "gen4_turbo" };
    } };
    await run(env, c, plan, { videoProvider: runway });
    assert.ok(c.veoSubmits > 0 && c.veoSubmits <= plan.aiVideoClipCount);
    const after = { ...c };
    await run(env, c, plan, { videoProvider: runway });
    assert.deepEqual(c, after);
    const missing = counters();
    await assert.rejects(run(freshEnv(), missing, plan), /requiere Runway/);
    assert.equal(missing.voice, 0);
    assert.equal(missing.image, 0);
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_AI_VIDEO_ENABLED;
    else process.env.LONG_FORM_AI_VIDEO_ENABLED = previous;
  }
});

// --- PI V2 B5.1 (RB-08): motion:true no se degrada a imagen fija ---

test("B5.1-1: motion:true sin video IA y sin archivo en movimiento → la producción falla ANTES de la voz y de cualquier llamada de pago", async () => {
  for (const strategy of ["balanced", "economical"] as const) {
    const c = counters();
    const stillsOnly: FootageProvider = {
      name: "stills-only",
      async fetchFootage(query) {
        c.stock += 1;
        return { url: `https://stock/i/${encodeURIComponent(query)}.jpg`, mediaType: "image", mimeType: "image/jpeg", extension: "jpg" };
      },
      async searchImageCandidates(query) {
        c.stock += 1;
        return [{ url: `https://stock/i/${encodeURIComponent(query)}.jpg`, sourceId: query, description: query, mediaType: "image" as const, mimeType: "image/jpeg", extension: "jpg" }];
      },
      async downloadFootage() {
        return Buffer.from("jpg");
      },
    };
    const renders = { count: 0 };
    await assert.rejects(run(freshEnv(), c, planFor(strategy), { videoProvider: null, providersOverride: { footageProvider: stillsOnly }, renders }), MotionRequiredUnsatisfiableError);
    assert.deepEqual({ voice: c.voice, image: c.image, veoSubmits: c.veoSubmits, renders: renders.count }, { voice: 0, image: 0, veoSubmits: 0, renders: 0 }, strategy);
  }
});

test("B5.1-2: motion:true con archivo en movimiento → cada escena con movimiento se ve como VIDEO, nunca Ken Burns ni imagen IA", async () => {
  const c = counters();
  const env = freshEnv({ durationSeconds: 180 });
  const script = documentary180sFixture();
  const { shots } = planShotsFromScript(script.beats, script.topic, "balanced");
  const motionIds = new Set(shots.filter((s) => s.motionRequired).map((s) => s.id));
  assert.ok(motionIds.size > 0, "el fixture tiene escenas motion:true");
  await run(env, c, planFor("balanced"), { videoProvider: null });
  const report = env.reports.at(-1)!;
  const motionScenes = report.scenes.filter((s) => motionIds.has(s.shotId));
  assert.equal(motionScenes.length, motionIds.size);
  for (const scene of motionScenes) {
    assert.equal(scene.display, "video", `${scene.shotId} se ve como ${scene.display}`);
    assert.ok(scene.executedType === "stock_video" || scene.executedType === "ai_video", `${scene.shotId}: ${scene.executedType}`);
  }
});

test("B5.1-3: el solver nunca asigna Ken Burns, imagen IA ni tarjeta a una escena motion:true; sin archivo en movimiento falla; motion:false conserva su fallback", () => {
  const script = documentary180sFixture();
  const { shots, narrationSeconds } = planShotsFromScript(script.beats, script.topic, "cinematic");
  const limits = strategyLimits("cinematic", 0, { aiVideoEnabled: false });
  const noBudget = { ...limits, maxAiImageGenerations: 0, maxGenerativeUsd: 0 };
  const allocated = allocateShotTypes(shots, narrationSeconds, noBudget);
  const motion = allocated.shots.filter((s) => s.motionRequired);
  const still = allocated.shots.filter((s) => !s.motionRequired);
  assert.ok(motion.length > 0 && still.length > 0);
  for (const s of motion) assert.ok(s.type === "stock_video" || s.type === "ai_video", `${s.id}: ${s.type}`);
  assert.ok(still.some((s) => s.type === "ken_burns_image" && s.plannedType === "generated_placeholder"), "motion:false con imágenes agotadas sigue cayendo a Ken Burns");
  assert.throws(() => allocateShotTypes(shots, narrationSeconds, { ...noBudget, movingStockAvailable: false }), MotionRequiredUnsatisfiableError);
});

// --- PI V2 B5.2 (RB-08): reserva por visual antes de la voz; la ejecución solo la consume ---

function loggedProviders(c: ReturnType<typeof counters>, log: string[], footage?: FootageProvider): Partial<LongFormProviderSet> {
  const base = providers(c);
  const f = footage ?? base.footageProvider;
  const footageProvider: FootageProvider = {
    ...f,
    name: f.name,
    fetchFootage: (...a) => (log.push(`stock:${a[0]}`), f.fetchFootage(...a)),
    downloadFootage: (url) => f.downloadFootage(url),
    ...(f.searchVideoCandidates ? { searchVideoCandidates: (...a: Parameters<NonNullable<FootageProvider["searchVideoCandidates"]>>) => (log.push(`stock:${a[0]}`), f.searchVideoCandidates!(...a)) } : {}),
    ...(f.searchImageCandidates ? { searchImageCandidates: (...a: Parameters<NonNullable<FootageProvider["searchImageCandidates"]>>) => (log.push("stock-image"), f.searchImageCandidates!(...a)) } : {}),
  };
  const voiceProvider: VoiceProvider = { name: base.voiceProvider.name, synthesize: (...a) => (log.push("voice"), base.voiceProvider.synthesize(...a)) };
  return { footageProvider, voiceProvider };
}

test("B5.2-1: hay video, pero ningún candidato cumple los criterios reales (irrelevante o demasiado corto) → falla ANTES de la voz; voz, imagen IA, Veo y render en 0", async () => {
  for (const kind of ["irrelevante", "corto"] as const) {
    const c = counters();
    const bad: FootageProvider = {
      name: "pexels-video-first",
      async fetchFootage() { throw new Error("no se usa"); },
      async searchVideoCandidates(query) {
        c.stock += 1;
        return Array.from({ length: 12 }, (_, i) => ({
          url: `https://stock/v/${kind}/${encodeURIComponent(query)}/${i}.mp4`,
          sourceId: `${kind}-${query}-${i}`,
          description: kind === "irrelevante" ? "cat sleeping on a sofa" : query,
          mediaType: "video" as const,
          mimeType: "video/mp4",
          extension: "mp4",
          durationSeconds: kind === "corto" ? 2 : 30,
        }));
      },
      async downloadFootage(url) { return Buffer.from(url); },
    };
    const renders = { count: 0 };
    await assert.rejects(run(freshEnv(), c, planFor("economical"), { videoProvider: null, providersOverride: { footageProvider: bad }, renders }), MotionRequiredUnsatisfiableError);
    assert.ok(c.stock > 0, "sí había candidatos de video");
    assert.deepEqual({ voice: c.voice, image: c.image, veoSubmits: c.veoSubmits, renders: renders.count }, { voice: 0, image: 0, veoSubmits: 0, renders: 0 }, kind);
  }
});

test("B5.2-2: reserva llena → cada escena motion sale como video de SU clip reservado; 0 búsquedas de las visuales motion después de la voz; 0 imágenes IA", async () => {
  const c = counters();
  const log: string[] = [];
  const env = freshEnv({ durationSeconds: 180 });
  const { renderInput } = await run(env, c, planFor("economical"), { videoProvider: null, providersOverride: loggedProviders(c, log) });
  const firstVoice = log.indexOf("voice");
  assert.ok(firstVoice > 0, "la reserva buscó antes de la primera voz");
  // Las escenas motion:false conservan su búsqueda normal (sin cambios); ninguna búsqueda de una visual motion:true tras la voz.
  const script0 = documentary180sFixture();
  const motionQueries = new Set(script0.beats.flatMap((b) => visualsForBeat(b as { narration: string; visuals?: unknown }, script0.topic)).filter((v) => v.motion).flatMap((v) => selectionQueries(v)));
  assert.ok(log.slice(0, firstVoice).some((e) => motionQueries.has(e.replace(/^stock:/, ""))), "la reserva usó las consultas de las visuales motion:true");
  assert.deepEqual(log.slice(firstVoice).filter((e) => e.startsWith("stock:") && motionQueries.has(e.slice(6))), [], "ninguna búsqueda de una visual motion:true después de la voz");
  assert.equal(c.image, 0);
  const reserved = [...env.mem.records.values()].filter((r) => r.shotId.startsWith("motionres-"));
  assert.ok(reserved.length > 0);
  const motionScenes = renderInput!.scenes.filter((s) => s.asset.kind === "media" && s.asset.url.includes("/motionres-"));
  assert.ok(motionScenes.length > 0);
  const script = documentary180sFixture();
  const { shots } = planShotsFromScript(script.beats, script.topic, "economical");
  const motionIds = new Set(shots.filter((s) => s.motionRequired).map((s) => s.id));
  for (const scene of renderInput!.scenes.filter((s) => motionIds.has(s.id))) {
    assert.ok(scene.asset.kind === "media" && scene.asset.mediaType === "video" && scene.asset.url.includes("/motionres-"), `${scene.id} usa un clip reservado`);
  }
  const used = motionScenes.map((s) => (s.asset.kind === "media" ? s.asset.url : ""));
  assert.equal(new Set(used).size, used.length, "cada clip reservado se consume una sola vez");
});

test("B5.2-4: retry con reserva persistida → 0 búsquedas nuevas, 0 voz nueva, mismos clips", async () => {
  const c = counters();
  const log: string[] = [];
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  const first = await run(env, c, planFor("economical"), { videoProvider: null, providersOverride: loggedProviders(c, log) }).catch(() => null);
  assert.equal(first, null, "el primer intento falla en la subida");
  const before = { ...c, log: log.length };
  const reservedBefore = [...env.mem.records.values()].filter((r) => r.shotId.startsWith("motionres-")).map((r) => `${r.shotId}:${r.objectPath}`).sort();
  const { renderInput } = await run(env, c, planFor("economical"), { videoProvider: null, providersOverride: loggedProviders(c, log) });
  assert.deepEqual(log.slice(before.log), [], "el reintento no busca stock ni sintetiza voz");
  assert.deepEqual({ voice: c.voice, image: c.image, veoSubmits: c.veoSubmits }, { voice: before.voice, image: before.image, veoSubmits: before.veoSubmits });
  const reservedAfter = [...env.mem.records.values()].filter((r) => r.shotId.startsWith("motionres-")).map((r) => `${r.shotId}:${r.objectPath}`).sort();
  assert.deepEqual(reservedAfter, reservedBefore, "la identidad de la reserva no cambia");
  assert.ok(renderInput!.scenes.some((s) => s.asset.kind === "media" && s.asset.url.includes("/motionres-")));
});

// ---- PI V2 COST-B: música pagada (Beatoven) de Long Form por la misma puerta + result store que Reel ----

function fakeBeatoven(calls: MusicSelectionContext[]): MusicProvider {
  return {
    name: "beatoven",
    async getTrack(context) {
      calls.push(context);
      return { audioBuffer: Buffer.from(`beatoven-track-${calls.length}`), durationSeconds: context.durationSeconds, mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
}

const composeOps = (env: Env) => [...env.ledger.ops.values()].filter((op) => op.method === "compose");
const musicDepsFor = (env: Env, musicProvider: MusicProvider) => ({
  ledger: env.ledger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results: supabaseResultStore(env.supabase as any, "videos"),
  requestId: "req-panama-qa",
  musicProvider,
  estimatedCostUsd: 0,
});

test("COST-B-2: primer intento con Beatoven → 1 llamada, pista persistida reutilizable y operación COMMITTED", async () => {
  const c = counters();
  const calls: MusicSelectionContext[] = [];
  const env = freshEnv();
  const artifacts = new Map<string, Buffer>();
  await run(env, c, planFor("economical"), { providersOverride: { musicProvider: fakeBeatoven(calls) }, artifacts });
  assert.equal(calls.length, 1);
  const ops = composeOps(env);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, "COMMITTED");
  assert.equal(ops[0].provider, "beatoven");
  assert.equal(ops[0].projectId, "req-panama-qa");
  assert.ok(ops[0].resultRef?.startsWith("req-panama-qa/paid/"), "durable fuera del prefijo de intento");
  const stored = await loadCommittedMusicTrack(musicDepsFor(env, fakeBeatoven([])), calls[0]);
  assert.equal(stored?.audioBuffer.toString(), "beatoven-track-1");
  assert.equal(artifacts.get("req-panama-qa/attempt-1/music.mp3")?.toString(), "beatoven-track-1");
});

test("COST-B-1: retry con la pista Beatoven ya persistida → 0 getTrack, 0 filas nuevas, la misma pista; otra identidad no la reutiliza", async () => {
  const c = counters();
  const calls: MusicSelectionContext[] = [];
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  const beatoven = fakeBeatoven(calls);
  const original = await run(env, c, planFor("economical"), { providersOverride: { musicProvider: beatoven } }).catch(() => null);
  assert.equal(original, null, "el intento original falló en la entrega, después de la música");
  assert.equal(calls.length, 1);
  const rowsBefore = env.ledger.ops.size;

  const artifacts = new Map<string, Buffer>();
  await run(env, c, planFor("economical"), { providersOverride: { musicProvider: beatoven }, artifacts });
  assert.equal(calls.length, 1, "getTrack = 0 en el retry");
  assert.equal(env.ledger.ops.size, rowsBefore, "0 filas nuevas de ledger");
  assert.equal(artifacts.get("req-panama-qa/attempt-1/music.mp3")?.toString(), "beatoven-track-1", "se reutiliza exactamente la pista pagada");

  // Mismo requestId, identidad musical distinta: no hay pista que reutilizar y pagarla es otra operación.
  const deps = musicDepsFor(env, beatoven);
  const ctx = calls[0];
  assert.equal((await loadCommittedMusicTrack(deps, ctx))?.audioBuffer.toString(), "beatoven-track-1");
  for (const other of [{ ...ctx, scriptText: `${ctx.scriptText} Epílogo.` }, { ...ctx, durationSeconds: ctx.durationSeconds + 30 }, { ...ctx, language: "en" as const }]) {
    assert.equal(await loadCommittedMusicTrack(deps, other), null);
  }
  const other = await gatedMusicTrack(deps, { ...ctx, scriptText: `${ctx.scriptText} Epílogo.` });
  assert.equal(other.reused, false);
  assert.equal(other.audioBuffer.toString(), "beatoven-track-2");
  assert.equal(composeOps(env).length, 2, "dos identidades → dos operaciones distintas");
});

test("COST-B-3: biblioteca curada y fixture siguen gratis — 0 operaciones de ledger, mismo comportamiento", async () => {
  const fixtureEnv = freshEnv();
  await run(fixtureEnv, counters(), planFor("economical"));
  assert.equal(composeOps(fixtureEnv).length, 0);

  const curatedCalls: MusicSelectionContext[] = [];
  const curated: MusicProvider = { ...fakeBeatoven(curatedCalls), name: "curated-library" };
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  await run(env, counters(), planFor("economical"), { providersOverride: { musicProvider: curated } }).catch(() => null);
  await run(env, counters(), planFor("economical"), { providersOverride: { musicProvider: curated } });
  assert.equal(curatedCalls.length, 2, "la biblioteca gratuita se consulta en cada intento, como antes");
  assert.equal(composeOps(env).length, 0, "sin fila de ledger pagada");
});

test("COST-B replay: la pista Beatoven solo se lee del resultado durable; si falta, error de replay sin generar", async () => {
  const calls: MusicSelectionContext[] = [];
  const env = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  await run(env, counters(), planFor("economical"), { providersOverride: { musicProvider: fakeBeatoven(calls) } }).catch(() => null);
  assert.equal(calls.length, 1);
  const artifacts = new Map<string, Buffer>();
  await run(env, counters(), planFor("economical"), { replayOnly: true, providersOverride: { musicProvider: fakeBeatoven(calls) }, artifacts });
  assert.equal(calls.length, 1, "replay: 0 llamadas a Beatoven");
  assert.equal(artifacts.get("req-panama-qa/attempt-1/music.mp3")?.toString(), "beatoven-track-1");

  // Sin pista pagada persistida (el original usó otra música): replay aborta, nunca genera ni sustituye.
  const missingCalls: MusicSelectionContext[] = [];
  const env2 = freshEnv({ durationSeconds: 180, transientUploadFailures: 1 });
  await run(env2, counters(), planFor("economical")).catch(() => null);
  const renders = { count: 0 };
  await assert.rejects(
    () => run(env2, counters(), planFor("economical"), { replayOnly: true, renders, providersOverride: { musicProvider: fakeBeatoven(missingCalls) } }),
    (err: unknown) => err instanceof Error && err.name === "LongFormReplayError" && /música/.test(err.message),
  );
  assert.equal(missingCalls.length, 0);
  assert.equal(renders.count, 0);
  assert.equal(composeOps(env2).length, 0);
});

test("COST-3: en el camino del job, cada envío al proveedor de video IA lleva metadata.shotId (nunca la rama sin clave de idempotencia)", async () => {
  const previous = process.env.LONG_FORM_AI_VIDEO_ENABLED;
  process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";
  try {
    const c = counters();
    const plan = computeProductionPlan({ ...documentary180sFixture(), strategy: "cinematic", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true });
    const veo = fakeVeo(c);
    const shotIds: (string | undefined)[] = [];
    const recording: VideoProvider = { ...veo, generateVideo: (req) => (shotIds.push(req.metadata?.shotId), veo.generateVideo(req)) };
    const env = freshEnv();
    await run(env, c, plan, { videoProvider: recording });
    assert.ok(shotIds.length > 0, "el plan cinematic envía clips de video IA");
    assert.ok(shotIds.every((id) => typeof id === "string" && id.length > 0), `envíos sin shotId: ${JSON.stringify(shotIds)}`);
    const videoOps = [...env.ledger.ops.values()].filter((op) => op.method === "generate_video");
    assert.equal(videoOps.length, shotIds.length, "cada envío pasó por el gate con su propia fila");
    assert.ok(videoOps.every((op) => op.shotId.startsWith("ai_video:") && op.projectId === "req-panama-qa"));
  } finally {
    if (previous === undefined) delete process.env.LONG_FORM_AI_VIDEO_ENABLED;
    else process.env.LONG_FORM_AI_VIDEO_ENABLED = previous;
  }
});
