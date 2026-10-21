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
import { generateLongFormVideoFromScript, LONG_FORM_RENDER_JOB_TIMEOUT_MIN, type LongFormRuntime } from "./produce";
import { getPricingConfig } from "@/lib/billing/pricing";
import { MAX_RENDER_ATTEMPTS } from "@/lib/video/limits";

/** Techo del render (fuera del ledger), reservado dentro del techo total. */
const RENDER_USD = MAX_RENDER_ATTEMPTS * LONG_FORM_RENDER_JOB_TIMEOUT_MIN * getPricingConfig().renderUsdPerMinute;

/**
 * ADVANCE 2 — presupuesto TOTAL del pedido aplicado por el servidor en produce() real.
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

async function run(beats: ProductionPlanBeatInput[], plan: ProductionPlan, opts: { footage?: FootageProvider; shared?: Shared; requestBudget?: unknown } = {}) {
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
      providers: { ...base, footageProvider: footage },
      runtime,
    });
  } catch (err) {
    error = err as RunError;
  }
  const n = (e: string) => events.filter((x) => x === e).length;
  return { events, error, voice: n("voice"), image: n("image"), render: n("render"), sh };
}


const plentiful = () => countingProviders([]).footageProvider;
const beats = () => auroraBeats({ dated: false });
const plan3 = (b: ProductionPlanBeatInput[]) => planOf(b, 3);
const SCRIPT_SCOPE = "documentary:user-1:script-hash";
const authStore = () => {
  const rows = new Map<string, unknown>();
  return { rows, async read(id: string) { return (rows.get(id) as never) ?? null; }, async create(a: { requestId: string }) { if (rows.has(a.requestId)) return false; rows.set(a.requestId, a); return true; } };
};
const voiceOps = (sh: Shared) => [...sh.ledger.ops.values()].filter((o) => o.projectId === "req-total-budget");
const exposure = (sh: Shared, scopes: string[]) =>
  [...sh.ledger.ops.values()].filter((o) => scopes.includes(o.projectId)).reduce((s, o) => s + (o.status === "COMMITTED" ? (o.committedUsd ?? 0) : o.status === "REFUNDED" && (o.resultRef ?? "").startsWith("released:") ? 0 : Math.max(o.reservedUsd, o.committedUsd ?? 0)), 0);

test("A2-P1 gasto previo del guion casi agota el techo → produce() no llama a la voz (0 llamadas pagadas nuevas)", async () => {
  const b = beats();
  const sh = newShared();
  await sh.ledger.insert({ idempotencyKey: "op_script", projectId: SCRIPT_SCOPE, shotId: "script:1", provider: "anthropic", model: "m", method: "script", attemptKind: "initial", reservedUsd: 11.99, committedUsd: 11.99, status: "COMMITTED", providerJobId: "j", resultRef: "r", updatedAt: "t" });
  const r = await run(b, plan3(b), { footage: plentiful(), shared: sh, requestBudget: { scriptScopes: [SCRIPT_SCOPE], store: authStore(), hardMaxUsd: 12 } });
  assert.ok(r.error, "debe negarse");
  assert.match(`${r.error!.name}`, /RequestBudget(Exceeded|NotAuthorized)Error/, r.error!.message.slice(0, 200));
  assert.equal(r.voice, 0, "0 llamadas de voz");
  assert.equal(r.render, 0);
  assert.ok(exposure(sh, ["req-total-budget", SCRIPT_SCOPE]) <= 12 + 1e-9);
});

test("A2-P2b una autorización NUEVA cuyas etapas no caben en el techo de producto se rechaza ANTES de cualquier gasto", async () => {
  const b = beats();
  const sh = newShared();
  const r = await run(b, plan3(b), { footage: plentiful(), shared: sh, requestBudget: { scriptScopes: [], store: authStore(), hardMaxUsd: Math.round((RENDER_USD + 0.01) * 10000) / 10000 } });
  assert.ok(r.error); assert.equal(r.error!.name, "RequestBudgetNotAuthorizedError", r.error!.message.slice(0, 200));
  assert.equal(r.voice, 0, "nothing narrated"); assert.equal(voiceOps(sh).length, 0, "no ledger row");
});

test("A2-P2 interrupción por techo + reintento con un techo de entorno mayor → NO se amplía, no se repaga lo hecho", async () => {
  const b = beats();
  // Medición: reservas de voz por beat con el mismo plan (sin techo efectivo).
  const probe = await run(b, plan3(b), { footage: plentiful(), requestBudget: { scriptScopes: [], store: authStore(), hardMaxUsd: 1000 } });
  assert.equal(probe.error, null, probe.error?.message);
  const reserved = voiceOps(probe.sh).map((o) => o.reservedUsd);
  assert.ok(reserved.length >= 2, "al menos dos operaciones de voz");
  const ceiling = Math.round((reserved[0] + reserved[1] / 2) * 10000) / 10000;

  const sh = newShared();
  const store = authStore();
  // An authorization saved earlier with a smaller ceiling (e.g. a stricter product ceiling at the time): the run is
  // interrupted at that ceiling mid-way. (A NEW authorization whose stages do not fit is refused before any spend: A2-10.)
  await store.create({ version: 1, requestId: "req-total-budget", ceilingUsd: Math.round((ceiling + RENDER_USD) * 10000) / 10000,
    stageCeilings: { research: 0, script: 0, style: 0, voice: null, images: 0, video: 0, music: 0, render: RENDER_USD }, contingencyPct: 20,
    ledgerScopes: ["req-total-budget"], authorizedAt: "2026-10-21T00:00:00.000Z" });
  const first = await run(b, plan3(b), { footage: plentiful(), shared: sh, requestBudget: { scriptScopes: [], store, hardMaxUsd: 1000 } });
  assert.ok(first.error, "el primer intento debe detenerse en el techo");
  assert.equal(first.error!.name, "RequestBudgetExceededError", first.error!.message.slice(0, 200));
  assert.equal(first.voice, 1, "solo la voz que cabía");
  assert.ok(exposure(sh, ["req-total-budget"]) <= ceiling + 1e-9, "nunca por encima del techo (proveedores = total − render)");

  const retry = await run(b, plan3(b), { footage: plentiful(), shared: sh, requestBudget: { scriptScopes: [], store, hardMaxUsd: 1000 } });
  assert.ok(retry.error, "el reintento no puede ampliar el techo autorizado");
  assert.equal(retry.error!.name, "RequestBudgetExceededError");
  assert.equal(retry.voice, 0, "lo ya pagado se reutiliza; nada nuevo cabe");
  assert.ok(exposure(sh, ["req-total-budget"]) <= ceiling + 1e-9);
  const keys = voiceOps(sh).filter((o) => o.status === "COMMITTED").map((o) => o.shotId);
  assert.equal(new Set(keys).size, keys.length, "sin duplicados");
});

test("A2-P3 dentro del techo → produce completo y el total del pedido queda bajo la autorización guardada", async () => {
  const b = beats();
  const store = authStore();
  let authorized = 0;
  const r = await run(b, plan3(b), { footage: plentiful(), requestBudget: { scriptScopes: [], store, hardMaxUsd: 12, onAuthorized: (a: { ceilingUsd: number }) => { authorized = a.ceilingUsd; } } });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.render, 1);
  assert.ok(authorized > 0 && authorized <= 12);
  assert.ok(exposure(r.sh, ["req-total-budget"]) <= authorized - RENDER_USD + 1e-9, "proveedores ≤ techo total − techo del render");
});
