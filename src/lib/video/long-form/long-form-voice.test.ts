import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FootageProvider } from "@/lib/providers/types";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { countingProviders, makeStorage } from "./cinematic-simulation";
import { memoryShotAssetStore } from "./durable-shot-assets";
import { memoryBudgetStore } from "./production-budget";
import { memoryOutputDeps } from "./output-finalize";
import { generateLongFormVideoFromScript, withChosenVoice, LONG_FORM_RENDER_JOB_TIMEOUT_MIN, type LongFormRuntime } from "./produce";
import type { VoiceProvider } from "@/lib/providers/types";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getPricingConfig } from "@/lib/billing/pricing";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";

/** Techo del render (fuera del ledger), reservado dentro del techo total. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const RENDER_USD = MAX_RENDER_ATTEMPTS * LONG_FORM_RENDER_JOB_TIMEOUT_MIN * getPricingConfig().renderUsdPerMinute;

/**
 * Voz elegida para Long Form (p. ej. «El Duro»): se narra con ESA voz o no se narra. produce() real.
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

type Shared = ReturnType<typeof newShared>;
function newShared() {
  const storage = makeStorage();
  const out = memoryOutputDeps({ durationSeconds: 60 });
  return { storage, out, ledger: memoryLedgerStore(), results: memoryResultStore(), store: memoryShotAssetStore().store, budgetStore: memoryBudgetStore() };
}

async function run(beats: ProductionPlanBeatInput[], plan: ProductionPlan, opts: { footage?: FootageProvider; shared?: Shared; requestBudget?: unknown; voiceId?: string; voice?: VoiceProvider } = {}) {
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
    output: sh.out.deps,
    ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
    ...(opts.requestBudget !== undefined ? ({ requestBudget: opts.requestBudget } as object) : {}),
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
      requestId: "req-total-budget",
      topic: TOPIC,
      beats: beats as never,
      language: "es",
      plan,
      providers: { ...base, footageProvider: footage, ...(opts.voice ? { voiceProvider: opts.voice } : {}) },
      runtime,
    });
  } catch (err) {
    error = err as RunError;
  }
  const n = (e: string) => events.filter((x) => x === e).length;
  return { events, error, voice: n("voice"), image: n("image"), render: n("render"), sh };
}



const DURO = "CeFSZuaHs4SxcBxb9nCr";
const beats = () => auroraBeats({ dated: false });
const plan3 = (b: ProductionPlanBeatInput[]) => planOf(b, 3);
const plentiful = () => countingProviders([]).footageProvider;
const voiceWith = (events: string[], voiceId?: string): VoiceProvider => ({ name: "elevenlabs", ...(voiceId ? { voiceId } : {}),
  synthesize: async (t, l, s) => (events.push(`voice:${voiceId ?? "default"}`), fixtureVoiceProvider.synthesize(t, l, s)) });
const ttsKeys = (sh: Shared) => [...sh.ledger.ops.values()].filter((o) => o.shotId.startsWith("tts:")).map((o) => o.shotId);

test("V1 voz elegida que el proveedor de narración no garantiza → se detiene ANTES de narrar (0 voz, 0 reservas, sin sustitución)", async () => {
  const b = beats();
  const ev: string[] = [];
  const r = await run(b, plan3(b), { footage: plentiful(), voiceId: DURO, voice: voiceWith(ev), requestBudget: false });
  assert.ok(r.error, "debe negarse");
  assert.equal(r.error!.name, "LongFormChosenVoiceUnavailableError");
  assert.equal(ev.length, 0, "ninguna narración con otra voz");
  assert.equal(r.sh.ledger.ops.size, 0, "ninguna reserva");
});

test("V2 voz elegida disponible → TODAS las narraciones con esa voz y la caché/ledger quedan ligadas a ella", async () => {
  const b = beats();
  const evChosen: string[] = [];
  const chosen = await run(b, plan3(b), { footage: plentiful(), voiceId: DURO, voice: voiceWith(evChosen, DURO), requestBudget: false });
  assert.equal(chosen.error, null, chosen.error?.message);
  assert.ok(evChosen.length >= b.length && evChosen.every((e) => e === `voice:${DURO}`), evChosen.join(","));
  const evDefault: string[] = [];
  const def = await run(b, plan3(b), { footage: plentiful(), voice: voiceWith(evDefault), requestBudget: false });
  assert.equal(def.error, null, def.error?.message);
  const a = ttsKeys(chosen.sh), d = ttsKeys(def.sh);
  assert.equal(a.length, d.length);
  assert.ok(a.every((k) => !d.includes(k)), "la identidad de voz entra en la clave: un audio de otra voz nunca se reutiliza");
});

test("V3 withChosenVoice: sin voz no cambia nada; proveedor real queda fijado a la voz; inyectado distinto se rechaza", () => {
  const base = countingProviders([]);
  assert.equal(withChosenVoice(base as never, undefined, true), base);
  assert.throws(() => withChosenVoice({ ...base, voiceProvider: voiceWith([], "otraVoz12345") } as never, DURO, true), /no está disponible/);
  const prev = { ...process.env };
  try {
    process.env.ELEVENLABS_API_KEY = "test-not-a-key"; process.env.VOICE_PROVIDER = "elevenlabs";
    const real = withChosenVoice(base as never, DURO, false);
    assert.equal(real.voiceProvider.name, "elevenlabs");
    assert.equal(real.voiceProvider.voiceId, DURO);
    assert.equal(getVoiceProvider().voiceId, undefined, "la predeterminada no cambia");
  } finally { process.env = prev; }
});
