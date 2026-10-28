import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import type { MaterialPreflight } from "./material-preflight";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { countingProviders, makeStorage } from "./cinematic-simulation";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { memoryBudgetStore } from "./production-budget";
import { memoryOutputDeps } from "./output-finalize";
import { generateLongFormVideoFromScript, type LongFormRuntime } from "./produce";

/**
 * ADVANCE 1 — preflight de disponibilidad de material ANTES de cualquier llamada pagada.
 * Código real de produce(); proveedores falsos que registran cada llamada; USD 0, sin red.
 * Solo usa API pública ya existente en la base (los nombres de error se comparan como texto),
 * para que el archivo compile y falle (ROJO) sobre la versión anterior.
 */
globalThis.fetch = (async () => { throw new Error("red prohibida"); }) as typeof fetch;

const TOPIC = "Auroras polares: la tormenta invisible";
const N1 = "La noche del 10 de mayo de 2024, millones de personas miraron hacia arriba y vieron algo que muchos solo conocían por fotografías. Cortinas de luz verde, rosa y violeta aparecieron sobre lugares donde casi nunca se ven. Hubo reportes desde el sur de Estados Unidos y el norte de la India.";
const N1_UNDATED = "Una noche de primavera, millones de personas miraron hacia arriba y vieron algo que muchos solo conocían por fotografías. Cortinas de luz verde, rosa y violeta aparecieron sobre lugares donde casi nunca se ven. Hubo reportes desde el sur de Estados Unidos y el norte de la India.";
const N2 = "Detrás de ese espectáculo había un fenómeno que no se ve a simple vista: una tormenta geomagnética extrema, la primera de nivel G5 desde 2003. Esta es la historia de esa tormenta invisible, y de la luz que la delata.";
const N3 = "Todo empieza a unos ciento cincuenta millones de kilómetros de aquí. El Sol no solo emite luz y calor. También expulsa sin descanso un flujo de partículas con carga eléctrica: el viento solar. A veces, el Sol hace algo más violento. En las regiones activas, donde los campos magnéticos se concentran y se enredan, pueden producirse fulguraciones y eyecciones de masa coronal: enormes nubes de plasma y campo magnético lanzadas al espacio.";

function auroraBeats(opts: { dated: boolean; evidence?: boolean }): ProductionPlanBeatInput[] {
  const hookQuote = opts.dated ? "La noche del 10 de mayo de 2024" : "Una noche de primavera";
  const hook = opts.evidence
    ? [
        { description: "fotografía de la aurora del 10 de mayo de 2024 sobre una ciudad", quote: hookQuote, subject: "aurora", era: "2024", beatClass: "EVIDENCE", evidence: { sourceIds: ["nasa-2024-may-storm"] }, motion: false },
        { description: "fotografía de la aurora rosa y violeta de mayo de 2024", quote: "Cortinas de luz verde, rosa y violeta", subject: "aurora", era: "2024", beatClass: "EVIDENCE", evidence: { sourceIds: ["hayakawa-2025"] }, motion: false },
        { description: "mapa de los avistamientos de aurora de mayo de 2024", quote: "Hubo reportes desde el sur", subject: "mapa", era: "2024", beatClass: "EVIDENCE", evidence: { sourceIds: ["nasa-2024-may-storm"] }, motion: false },
      ]
    : [
        { description: "green aurora curtains moving over a small town at night", quote: hookQuote, subject: "aurora", beatClass: "PLACE", motion: true },
        { description: "pink and violet aurora over dark hills", quote: "Cortinas de luz verde, rosa y violeta", subject: "aurora", beatClass: "PLACE", motion: false },
        { description: "green aurora above town rooftops at night", quote: "Hubo reportes desde el sur", subject: "aurora", beatClass: "PLACE", motion: false },
      ];
  return [
    { id: "b1", type: "hook", narration: opts.dated ? N1 : N1_UNDATED, visuals: hook as never },
    {
      id: "b2", type: "setup", narration: N2, visuals: [
        { description: "diagram of Earth magnetosphere hit by the solar wind", quote: "Detrás de ese espectáculo", subject: "magnetosphere", beatClass: "PROCESS", motion: false },
        { description: "green aurora curtains moving in the night sky", quote: "Esta es la historia de esa tormenta invisible", subject: "aurora", beatClass: "METAPHOR", motion: true },
      ] as never,
    },
    {
      id: "b3", type: "discovery", narration: N3, visuals: [
        { description: "surface of the Sun with moving granulation", quote: "Todo empieza a unos ciento cincuenta millones", subject: "sun surface", beatClass: "PLACE", motion: true },
        { description: "streams of solar wind particles leaving the Sun", quote: "el viento solar", subject: "solar wind", beatClass: "PROCESS", motion: false },
        { description: "Sun active region with dark sunspots", quote: "En las regiones activas", subject: "sunspots", beatClass: "PROCESS", motion: false },
        { description: "diagram of a coronal mass ejection traveling from the Sun to Earth", quote: "eyecciones de masa coronal", subject: "coronal mass ejection", beatClass: "PROCESS", motion: false },
      ] as never,
    },
  ] as ProductionPlanBeatInput[];
}

const planOf = (beats: ProductionPlanBeatInput[], version?: 3) =>
  ({ ...computeProductionPlan({ beats, topic: TOPIC, strategy: "economical", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false, ...(version ? { version } : {}) }), confirmedAt: "2026-10-19T15:10:00Z" }) as ProductionPlan;

/** Catálogo SINTÉTICO de la QA (mismas descripciones que gen_assets.py / aurora-director-sample.ts). */
const CATALOG: { id: string; description: string; media: "image" | "video" }[] = [
  { id: "aurora_cortinas_en_movimiento", description: "green aurora curtains moving over a small town at night (synthetic)", media: "video" },
  { id: "sol_superficie_granulacion", description: "surface of the Sun with moving granulation, solar disk (synthetic)", media: "video" },
  { id: "aurora_verde_sobre_pueblo", description: "green aurora above town rooftops at night (synthetic)", media: "image" },
  { id: "aurora_rosa_violeta_colinas", description: "pink and violet aurora over dark hills (synthetic)", media: "image" },
  { id: "sol_region_activa_manchas", description: "Sun with an active region and dark sunspots (synthetic)", media: "image" },
  { id: "eyeccion_masa_coronal_esquema", description: "diagram of a coronal mass ejection from the Sun toward Earth (synthetic)", media: "image" },
  { id: "tierra_magnetosfera_esquema", description: "diagram of Earth magnetosphere and the solar wind (synthetic)", media: "image" },
  { id: "viento_solar_particulas", description: "streams of solar wind particles leaving the Sun (synthetic)", media: "image" },
  { id: "sol_protuberancia_en_movimiento", description: "sun surface moving with a plasma prominence loop (synthetic)", media: "video" },
  { id: "aurora_rosa_violeta_pulsante", description: "pink and violet aurora moving over dark hills (synthetic)", media: "video" },
  { id: "aurora_verde_lago_reflejo", description: "green aurora reflected in a lake at night (synthetic)", media: "image" },
  { id: "aurora_corona_rayos_cenit", description: "green aurora curtains seen from below, corona of rays in the night sky (synthetic)", media: "image" },
  { id: "aurora_roja_verde_bosque", description: "green and red aurora over a forest at night (synthetic)", media: "image" },
  { id: "aurora_palida_simple_vista_pueblo", description: "faint pale aurora above town rooftops, naked eye view (synthetic)", media: "image" },
  { id: "magnetosfera_comprimida_tormenta_esquema", description: "diagram of Earth magnetosphere compressed by the solar wind (synthetic)", media: "image" },
  { id: "sol_limbo_protuberancias_primer_plano", description: "close-up of the sun surface with prominences (synthetic)", media: "image" },
  { id: "viento_solar_espiral_esquema", description: "diagram of the spiral solar wind leaving the Sun (synthetic)", media: "image" },
  { id: "region_activa_manchas_primer_plano", description: "close-up of a Sun active region with sunspots (synthetic)", media: "image" },
  { id: "eyeccion_masa_coronal_nube_plasma", description: "coronal mass ejection: plasma cloud launched into space from the Sun (synthetic)", media: "image" },
];
function syntheticCatalog(): FootageProvider {
  const as = (c: (typeof CATALOG)[number]): FootageCandidate => ({
    url: `https://synthetic.invalid/${c.id}.${c.media === "video" ? "mp4" : "png"}`,
    sourceId: `synthetic:${c.id}`,
    description: c.description,
    mediaType: c.media,
    mimeType: c.media === "video" ? "video/mp4" : "image/png",
    extension: c.media === "video" ? "mp4" : "png",
    width: c.media === "video" ? 1920 : 2400,
    height: c.media === "video" ? 1080 : 1600,
    durationSeconds: c.media === "video" ? 10 : undefined,
  });
  return {
    name: "synthetic-local-catalog",
    async fetchFootage() { throw new Error("solo búsqueda de candidatos"); },
    async searchVideoCandidates() { return CATALOG.filter((c) => c.media === "video").map(as); },
    async searchImageCandidates() { return CATALOG.filter((c) => c.media === "image").map(as); },
    async downloadFootage(url) { return Buffer.from(`synthetic-bytes:${url}`); },
  };
}


type Shared = ReturnType<typeof newShared>;
function newShared() {
  const storage = makeStorage();
  const out = memoryOutputDeps({ durationSeconds: 60 });
  return { storage, out, ledger: memoryLedgerStore(), results: memoryResultStore(), store: memoryShotAssetStore().store, budgetStore: memoryBudgetStore() };
}

async function run(beats: ProductionPlanBeatInput[], plan: ProductionPlan, opts: { footage?: FootageProvider; shared?: Shared; materialTextRatio?: number; onMaterial?: (m: MaterialPreflight) => void } = {}) {
  const events: string[] = [];
  const sh = opts.shared ?? newShared();
  const base = countingProviders(events);
  const footage = opts.footage
    ? { ...opts.footage, searchImageCandidates: async (q: string, o?: "portrait" | "landscape") => (events.push("stock"), (await opts.footage!.searchImageCandidates?.(q, o)) ?? []) }
    : base.footageProvider;
  const runtime: LongFormRuntime = {
    paidCalls: { ledger: sh.ledger, results: sh.results },
    store: sh.store,
    budgetStore: sh.budgetStore,
    observedUnitMax: {},
    videoProvider: null,
    aiVideoEnabled: false,
    recordCosts: false,
    resumeBackoffMs: 0,
    ...(opts.materialTextRatio !== undefined ? { materialTextRatio: opts.materialTextRatio } : {}),
    ...(opts.onMaterial ? { onMaterialPreflight: opts.onMaterial } : {}),
    output: sh.out.deps,
    uploadArtifact: async (p) => (events.push(`upload:${p.split("/").pop()}`), { path: p, url: `memory://${p}` }),
    identify: async (b) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" }),
    saveVisualReport: async () => { events.push("visual-report"); },
    render: async () => {
      events.push("render");
      const file = path.join(os.tmpdir(), `mp-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(file, "fake-mp4");
      return file;
    },
    renderThumbnail: async () => {
      const file = path.join(os.tmpdir(), `mp-thumb-${Date.now()}.jpg`);
      fs.writeFileSync(file, "fake-jpg");
      return file;
    },
  };
  type RunError = Error & { recoverable?: boolean; missing?: unknown[]; temporary?: unknown[] };
  let error = null as RunError | null;
  try {
    await generateLongFormVideoFromScript({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { storage: sh.storage } as any,
      requestId: "req-material-preflight",
      topic: TOPIC,
      beats: beats as never,
      language: "es",
      plan,
      providers: { ...base, footageProvider: footage },
      runtime,
    });
  } catch (err) {
    error = err as RunError;
  }
  const n = (e: string) => events.filter((x) => x === e).length;
  return { events, error, voice: n("voice"), image: n("image"), render: n("render"), sh };
}

/** Catálogo cuya disponibilidad se puede cambiar entre el preflight y la ejecución. */
function switchable(inner: FootageProvider) {
  const state = { mode: "ok" as "ok" | "empty" | "error", calls: 0 };
  const guard = async <T,>(fn: () => Promise<T>, empty: T): Promise<T> => {
    state.calls++;
    if (state.mode === "error") throw new Error("Pexels HTTP 503 (temporal)");
    if (state.mode === "empty") return empty;
    return fn();
  };
  const provider: FootageProvider = {
    name: "switchable-stock",
    fetchFootage: (q, d, o) => guard(() => inner.fetchFootage(q, d, o), Promise.reject(new Error("vacío")) as never),
    searchImageCandidates: (q, o) => guard(async () => (await inner.searchImageCandidates?.(q, o)) ?? [], [] as FootageCandidate[]),
    downloadFootage: (url) => inner.downloadFootage(url),
  };
  return { provider, state };
}

const plentiful = () => countingProviders([]).footageProvider;
const undated = () => auroraBeats({ dated: false });
const v3 = (b: ProductionPlanBeatInput[]) => planOf(b, 3);

test("A1-1 carencia inevitable (catálogo sin material pertinente y único) → se detiene ANTES de voz/imágenes: 0 llamadas pagadas", async () => {
  const beats = auroraBeats({ dated: true });
  const plan = planOf(beats);
  const r = await run(beats, plan, { footage: syntheticCatalog(), materialTextRatio: 0 });
  assert.ok(r.error, "debe negarse");
  assert.equal(r.error!.name, "LongFormMaterialUnavailableError", `nombre: ${r.error!.name}: ${r.error!.message.slice(0, 200)}`);
  assert.equal(r.voice, 0, "0 llamadas de voz");
  assert.equal(r.image, 0, "0 imágenes IA");
  assert.equal(r.render, 0, "sin render");
  assert.equal(r.sh.ledger.ops.size, 0, "0 operaciones en el ledger");
  assert.match(r.error!.message, /no existe material/i);
});

test("A1-1b pocas carencias sustituibles (≤ 15 % del archivo) → tarjeta del pasaje, registrada; más → se detiene a USD 0", async () => {
  const beats = auroraBeats({ dated: true });
  const plan = planOf(beats);
  let seen: MaterialPreflight | undefined;
  const r = await run(beats, plan, { footage: syntheticCatalog(), onMaterial: (m) => { seen = m; } });
  assert.ok(seen && seen.status === "unavoidable_gap");
  const stock = seen.shots.filter((v) => ["stock_video", "stock_image", "ken_burns_image"].includes(v.plannedType)).length;
  const fits = seen.missing.every((m) => m.promotable) && seen.missing.length <= Math.floor(stock * 0.15);
  if (fits) assert.notEqual(r.error?.name, "LongFormMaterialUnavailableError", "dentro del límite no se detiene por material");
  else {
    assert.equal(r.error?.name, "LongFormMaterialUnavailableError");
    assert.equal(r.voice, 0); assert.equal(r.sh.ledger.ops.size, 0, "0 operaciones en el ledger");
  }
});

test("A1-2 plan válido con material disponible → continúa y renderiza", async () => {
  const beats = undated();
  const r = await run(beats, v3(beats), { footage: plentiful() });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.render, 1);
  assert.ok(r.voice > 0);
});

test("A1-3 error temporal del proveedor de stock → estado recuperable claro, 0 gasto (no se confunde con «no existe»)", async () => {
  const beats = undated();
  const sw = switchable(plentiful());
  sw.state.mode = "error";
  const r = await run(beats, v3(beats), { footage: sw.provider });
  assert.ok(r.error);
  assert.equal(r.error!.name, "LongFormMaterialPreflightTemporaryError", `nombre: ${r.error!.name}: ${r.error!.message.slice(0, 200)}`);
  assert.equal(r.error!.recoverable, true);
  assert.match(r.error!.message, /temporal/i);
  assert.equal(r.voice, 0);
  assert.equal(r.sh.ledger.ops.size, 0);
  assert.equal(sw.state.calls, 1, "fallo rápido: no insiste escena por escena con el proveedor caído");
  // Recuperación: el proveedor vuelve → el mismo pedido se produce.
  sw.state.mode = "ok";
  const again = await run(beats, v3(beats), { footage: sw.provider, shared: r.sh });
  assert.equal(again.error, null, again.error?.message);
  assert.equal(again.render, 1);
});

test("A1-4 la disponibilidad cambia DESPUÉS del preflight → la puerta final sigue negando la entrega", async () => {
  const beats = undated();
  const plan = v3(beats);
  // El preflight consulta primero (catálogo lleno); en cuanto empieza la voz, el catálogo se vacía.
  const sh = newShared();
  const sw2 = switchable(plentiful());
  const events: string[] = [];
  const base = countingProviders(events);
  const voice = { ...base.voiceProvider, synthesize: async (...a: Parameters<typeof base.voiceProvider.synthesize>) => { sw2.state.mode = "empty"; return base.voiceProvider.synthesize(...a); } };
  let error: Error | null = null;
  try {
    await generateLongFormVideoFromScript({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { storage: sh.storage } as any, requestId: "req-material-preflight-late", topic: TOPIC, beats: beats as never, language: "es", plan,
      providers: { ...base, voiceProvider: voice, footageProvider: sw2.provider },
      runtime: { paidCalls: { ledger: sh.ledger, results: sh.results }, store: sh.store, budgetStore: sh.budgetStore, observedUnitMax: {}, videoProvider: null, aiVideoEnabled: false, recordCosts: false, resumeBackoffMs: 0, output: sh.out.deps,
        uploadArtifact: async (p) => ({ path: p, url: `memory://${p}` }), identify: async (b) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" }),
        saveVisualReport: async () => {}, render: async () => { events.push("render"); return path.join(os.tmpdir(), "never.mp4"); } },
    });
  } catch (err) { error = err as Error; }
  assert.ok(error, "debe negarse");
  assert.ok(/Material pendiente|LongFormQualityError|LongFormVisualQualityError/.test(`${error!.name} ${error!.message}`), `${error!.name}: ${error!.message.slice(0, 160)}`);
  assert.equal(events.filter((e) => e === "render").length, 0, "sin render");
});

test("A1-5 reintento tras una carencia sobrevenida → reutiliza lo pagado (0 voz nueva, sin duplicados en el ledger)", async () => {
  const beats = undated();
  const plan = v3(beats);
  const sw = switchable(plentiful());
  const sh = newShared();
  const events: string[] = [];
  const base = countingProviders(events);
  const voice = { ...base.voiceProvider, synthesize: async (...a: Parameters<typeof base.voiceProvider.synthesize>) => { sw.state.mode = "empty"; return base.voiceProvider.synthesize(...a); } };
  const rt = (): LongFormRuntime => ({ paidCalls: { ledger: sh.ledger, results: sh.results }, store: sh.store, budgetStore: sh.budgetStore, observedUnitMax: {}, videoProvider: null, aiVideoEnabled: false, recordCosts: false, resumeBackoffMs: 0, output: sh.out.deps,
    uploadArtifact: async (p) => ({ path: p, url: `memory://${p}` }), identify: async (b) => ({ sha256: createHash("sha256").update(b).digest("hex"), dhashUnavailable: "test" }),
    saveVisualReport: async () => {}, render: async () => { events.push("render"); const f = path.join(os.tmpdir(), `mp5-${Date.now()}.mp4`); fs.writeFileSync(f, "x"); return f; },
    renderThumbnail: async () => { const f = path.join(os.tmpdir(), `mp5t-${Date.now()}.jpg`); fs.writeFileSync(f, "x"); return f; } });
  const go = (v: typeof voice) => generateLongFormVideoFromScript({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { storage: sh.storage } as any, requestId: "req-material-retry", topic: TOPIC, beats: beats as never, language: "es", plan,
    providers: { ...base, voiceProvider: v, footageProvider: sw.provider }, runtime: rt() }).then(() => null, (e: Error) => e);
  const first = await go(voice);
  assert.ok(first, "el primer intento debe fallar por la carencia sobrevenida");
  const voiceAfterFirst = events.filter((e) => e === "voice").length;
  assert.ok(voiceAfterFirst > 0);
  const opsAfterFirst = [...sh.ledger.ops.keys()].sort();
  sw.state.mode = "ok";
  const plainVoice = base.voiceProvider;
  const second = await go(plainVoice as typeof voice);
  assert.equal(second, null, second?.message);
  assert.equal(events.filter((e) => e === "voice").length, voiceAfterFirst, "el reintento no vuelve a pagar la voz");
  const opsAfterSecond = [...sh.ledger.ops.keys()].sort();
  assert.deepEqual(opsAfterSecond.filter((k) => !opsAfterFirst.includes(k)).filter((k) => /voice|tts|eleven/i.test(k)), [], "sin operaciones de voz nuevas");
  assert.equal(new Set(opsAfterSecond).size, opsAfterSecond.length);
  assert.equal(events.filter((e) => e === "render").length, 1);
});

test("tarjeta del pasaje: pocas carencias sustituibles (≤ 15 % del archivo) se cubren; más, o una de identidad, detienen", async () => {
  const { materialTextFallback, MAX_MATERIAL_TEXT_RATIO } = await import("./material-preflight");
  assert.equal(MAX_MATERIAL_TEXT_RATIO, 0.15);
  const shots = Array.from({ length: 20 }, (_, i) => ({ shotId: `s${i}`, plannedType: "stock_video", status: "available" as const, reason: "ok" }));
  const gap = (ids: number[], promotable = true) => {
    const missing = ids.map((i) => ({ shotId: `s${i}`, plannedType: "stock_video", status: "nonexistent" as const, reason: "no existe", promotable }));
    return { status: "unavoidable_gap" as const, shots: [...shots.filter((_, i) => !ids.includes(i)), ...missing], missing, temporary: [], searches: 1 };
  };
  assert.deepEqual([...materialTextFallback(gap([1, 2, 3]))!], ["s1", "s2", "s3"], "3 de 20 = 15 %");
  assert.equal(materialTextFallback(gap([1, 2, 3, 4])), null, "4 de 20 supera el 15 %");
  assert.equal(materialTextFallback(gap([1], false)), null, "una escena de identidad/prueba sin contrato nunca se sustituye");
  assert.equal(materialTextFallback({ status: "ok", shots, missing: [], temporary: [], searches: 1 }), null);
});
