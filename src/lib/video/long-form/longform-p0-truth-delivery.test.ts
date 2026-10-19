import { test } from "node:test";
import assert from "node:assert/strict";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES, type ProductionPlan, type ProductionPlanBeatInput } from "./production-plan";
import { cinematicQa, directCinematic, type CinematicQaScene, type DirectorInput } from "./cinematic-director";
import { LongFormVisualQualityError } from "./visual-report";
import { produceOffline } from "./cinematic-simulation";

/**
 * T-20261019-1553-chatgpt-01 — ROJO/VERDE de los dos P0 de Long Form (GROK-LONGFORM-QA-V6).
 * Mismos guion e intenciones que los fixtures `dry3-v3-en` (v3) y `out-v4` (v4) de la QA local;
 * material SINTÉTICO (catálogo en memoria), sin red, sin proveedores reales, USD 0.
 * Este archivo solo importa API que ya existía en 35fb212, para que falle (ROJO) sobre la base.
 */

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("P0 truth/delivery: red prohibida en las pruebas");
}) as typeof fetch;

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

const count = (events: string[], e: string) => events.filter((x) => x === e).length;
const spentNothing = (events: string[]) => {
  assert.equal(count(events, "voice"), 0, "0 llamadas de voz (TTS)");
  assert.equal(count(events, "stock"), 0, "0 búsquedas/descargas de stock");
  assert.equal(count(events, "image"), 0, "0 imágenes IA");
  assert.equal(count(events, "render"), 0, "sin render");
  assert.ok(!events.some((e) => e.startsWith("upload:")), "sin subidas");
};

// ---------------------------------------------------------------------------------------------
// P0-01 — v3 (ruta por defecto) con acontecimiento fechado: fallo cerrado ANTES de gastar
// ---------------------------------------------------------------------------------------------

test("P0-01 dry3-v3-en: v3 + «10 de mayo de 2024» ilustrado con stock → IMPEDIMENTO DE ENTREGA antes de cualquier gasto", async () => {
  const beats = auroraBeats({ dated: true });
  const plan = planOf(beats, 3);
  assert.equal(plan.version, 3);
  const { events, error } = await produceOffline(beats, plan, { topic: TOPIC, footageProvider: syntheticCatalog() });
  assert.ok(error, `debe fallar cerrado; eventos: ${events.join(",")}`);
  assert.ok(error instanceof LongFormVisualQualityError, `tipo: ${(error as Error)?.name}`);
  assert.match((error as Error).message, /IMPEDIMENTO DE ENTREGA/);
  assert.match((error as Error).message, /10 de mayo de 2024/);
  spentNothing(events);
});

test("P0-01 sin regresión: el mismo guion v3 SIN fecha de calendario se sigue produciendo", async () => {
  const beats = auroraBeats({ dated: false });
  const plan = planOf(beats, 3);
  const { events, error } = await produceOffline(beats, plan, { topic: TOPIC });
  assert.equal(error, null, `no debe fallar: ${(error as Error)?.message}`);
  assert.equal(count(events, "render"), 1);
  assert.ok(count(events, "voice") > 0);
});

test("P0-01 sin regresión: v4 con PRUEBA declarada y sin curaduría sigue bloqueando con su código (0 voz)", async () => {
  const beats = auroraBeats({ dated: true, evidence: true });
  const plan = planOf(beats);
  assert.ok(plan.version >= 4);
  const { events, error } = await produceOffline(beats, plan, { topic: TOPIC });
  assert.ok(error instanceof LongFormVisualQualityError, `tipo: ${(error as Error)?.name}`);
  assert.match((error as Error).message, /HERO_EVIDENCE_COVERAGE_MISSING/);
  assert.doesNotMatch((error as Error).message, /DATED_EVENT_EVIDENCE_REQUIRED/);
  spentNothing(events);
});

// ---------------------------------------------------------------------------------------------
// P0 entregabilidad — «Material pendiente» nunca es entregable
// ---------------------------------------------------------------------------------------------

function qaScene(over: Partial<CinematicQaScene> & { shotId: string; startSec: number; endSec: number }, input: Partial<DirectorInput> = {}): CinematicQaScene {
  const kind = over.display === "video" ? "video" : over.display === "card" ? "graphic" : "image";
  const decision = directCinematic([
    { startSec: over.startSec, endSec: over.endSec, durationSec: over.endSec - over.startSec, executedType: kind === "graphic" ? "text" : kind === "video" ? "stock_video" : "ken_burns_image", kind, ...input },
  ])[0];
  return { ...decision, executedType: kind === "graphic" ? "text" : "ken_burns_image", display: "image", relevance: "keyword_match", durationSec: over.endSec - over.startSec, ...over };
}

test("P0 out-v4 (unidad): 2 tarjetas TRUTHFUL_ABSTENTION con carencia → release.deliverable=false aunque el veredicto sea PASS", () => {
  // Misma forma que el informe out-v4: 16 escenas, 72,2 s, tarjetas en b2-shot-3 (editorial), b3-shot-2 y b3-shot-6 (carencia).
  const bounds = [0, 4.424, 8.849, 13.273, 17.698, 22.122, 26.29, 30.458, 34.626, 38.794, 43.57, 48.346, 53.122, 57.898, 62.674, 67.45, 72.226];
  const ids = ["b1-shot-1", "b1-shot-2", "b1-shot-3", "b1-shot-4", "b1-shot-5", "b2-shot-1", "b2-shot-2", "b2-shot-3", "b2-shot-4", "b3-shot-1", "b3-shot-2", "b3-shot-3", "b3-shot-4", "b3-shot-5", "b3-shot-6", "b3-shot-7"];
  const scenes = ids.map((shotId, i) => {
    const s = { shotId, startSec: bounds[i], endSec: bounds[i + 1] };
    if (shotId === "b2-shot-3") return qaScene({ ...s, display: "card", provenance: "text_card" });
    if (shotId === "b3-shot-2" || shotId === "b3-shot-6") return qaScene({ ...s, display: "card", provenance: "text_card", gap: true }, { gap: true });
    return qaScene({ ...s, display: "video", provenance: "stock_illustrative" }, { provenance: "stock_illustrative" });
  });
  const qa = cinematicQa(scenes);
  assert.deepEqual(qa.cards.filter((c) => c.reason === "TRUTHFUL_ABSTENTION").map((c) => c.shotId), ["b3-shot-2", "b3-shot-6"]);
  assert.deepEqual(qa.release.blockers, [], "la política de entrega (DELIVERY_POLICY) no cambia");
  assert.equal(qa.release.deliverable, false, "una salida con «Material pendiente» no es entregable");
  // Control: sin carencias, la misma secuencia sigue siendo entregable.
  const clean = cinematicQa(scenes.map((s) => ({ ...s, gap: false })));
  assert.equal(clean.release.deliverable, true);
});

test("P0 out-v4 (pipeline v4): con carencias en el catálogo sintético, el worker NO renderiza ni entrega el MP4", async () => {
  const beats = auroraBeats({ dated: true });
  const plan = planOf(beats);
  assert.ok(plan.version >= 4);
  let pending: string[] = [];
  let deliverable: boolean | undefined;
  const { events, error } = await produceOffline(beats, plan, {
    topic: TOPIC,
    footageProvider: syntheticCatalog(),
    onReport: (r) => {
      pending = r.summary.gaps.map((g) => g.shotId);
      deliverable = r.cinematic?.qa.release.deliverable;
    },
  });
  assert.ok(pending.length > 0, "el fixture debe reproducir al menos una carencia (como b3-shot-2 / b3-shot-6 en out-v4)");
  assert.equal(deliverable, false, "el informe visual no puede decir deliverable=true con carencias");
  assert.ok(error, `debe negarse a entregar; eventos: ${events.join(",")}`);
  assert.equal((error as Error).name, "LongFormPendingMaterialError");
  assert.match((error as Error).message, /IMPEDIMENTO DE ENTREGA/);
  assert.match((error as Error).message, /Material pendiente/);
  assert.equal(count(events, "render"), 0, "sin render");
  assert.ok(!events.some((e) => e.startsWith("upload:")), `sin subir voz/música para el render: ${events.join(",")}`);
  assert.ok(!events.includes("thumbnail"));
});

test("P0 entregabilidad (pipeline v3 sin fecha): la misma carencia también bloquea la entrega en la ruta por defecto", async () => {
  const beats = auroraBeats({ dated: false });
  const plan = planOf(beats, 3);
  let pending: string[] = [];
  const { events, error } = await produceOffline(beats, plan, { topic: TOPIC, footageProvider: syntheticCatalog(), onReport: (r) => { pending = r.summary.gaps.map((g) => g.shotId); } });
  assert.ok(pending.length > 0, "el fixture debe reproducir carencias");
  assert.equal((error as Error | null)?.name, "LongFormPendingMaterialError", `eventos: ${events.join(",")}`);
  assert.equal(count(events, "render"), 0);
});

test("ninguna prueba de este archivo tocó la red", () => {
  assert.equal(networkCalls, 0);
});
