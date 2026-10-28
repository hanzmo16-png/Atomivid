import { test } from "node:test";
import assert from "node:assert/strict";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { allocateShotTypes, getGenerativeUnitCosts, limitsWithinAllocation, planShotsFromScript, strategyLimits, type ProductionPlanBeatInput } from "./production-plan";
import { planMaterialPromotions, type VisualStrategy } from "./production-plan-types";
import { productPlan } from "./product-plan";
import { materialAvailabilityPreflight } from "./material-preflight";
import { configurePlansWithMaterial, createMaterialSearchCache, materialAwarePlan, withSearchDeadline } from "./material-plan";
import { materialBlockText } from "./material-gap-message";

/**
 * Incidente 2026-10-28 («Un día en la sabana africana»): el preflight de material corre AL CONFIGURAR.
 * Económico → impedimento visible; Equilibrado/Cinemático → escenas sin archivo promovidas a imagen IA, preciadas
 * en el plan, y el plan resultante pasa la MISMA guarda que produce() ejecuta antes de gastar. Sin red, USD 0.
 */
globalThis.fetch = (async () => { throw new Error("red prohibida"); }) as typeof fetch;

const TOPIC = "Un día en la sabana africana";
const N = (s: string) => `${s} ${"La luz cambia despacio sobre la hierba alta mientras la manada avanza y el calor empieza a subir desde la tierra seca hacia el horizonte abierto de la sabana africana.".repeat(2)}`;

const BEATS: ProductionPlanBeatInput[] = [
  { id: "beat-1", type: "hook", narration: N("Amanece en la sabana."), visuals: [
    { description: "african buffalo herd grazing at dawn", quote: "Amanece en la sabana", subject: "buffalo herd", beatClass: "PLACE", motion: true },
    { description: "researcher fitting a GPS collar on a lioness", quote: "La luz cambia despacio", subject: "GPS collar", beatClass: "PROCESS", motion: false },
  ] as never },
  { id: "beat-2", type: "setup", narration: N("El calor sube."), visuals: [
    { description: "heat haze shimmering over the dry plains", quote: "El calor sube", subject: "heat haze", beatClass: "PLACE", motion: false },
    { description: "giraffe eating acacia leaves", quote: "la manada avanza", subject: "giraffe", beatClass: "PLACE", motion: false },
  ] as never },
];

/** Catálogo sintético: búfalos y jirafas existen (muchos), el collar GPS y la calima no. Cuenta cada búsqueda. */
function catalog(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  let n = 0;
  const make = (query: string, media: "image" | "video"): FootageCandidate[] => {
    const q = query.toLowerCase();
    const subject = q.includes("buffalo") ? "african buffalo grazing in natural habitat" : q.includes("giraffe") ? "giraffe eating acacia leaves in the savanna" : null;
    if (!subject) return [{ url: `https://synthetic.invalid/x${n++}.jpg`, sourceId: `x${n}`, description: "city skyline at night", mediaType: media, mimeType: "image/jpeg", extension: "jpg" }];
    return Array.from({ length: 6 }, () => ({ url: `https://synthetic.invalid/${n}.jpg`, sourceId: `c${n++}`, description: subject, durationSeconds: 30, mediaType: media, mimeType: media === "video" ? "video/mp4" : "image/jpeg", extension: media === "video" ? "mp4" : "jpg" }));
  };
  const provider: FootageProvider = {
    name: "synthetic",
    async fetchFootage() { throw new Error("solo candidatos"); },
    async downloadFootage() { throw new Error("sin descargas"); },
    async searchVideoCandidates(query) { calls.push(`v:${query}`); if (opts.fail) throw new Error("HTTP 503"); return make(query, "video"); },
    async searchImageCandidates(query) { calls.push(`i:${query}`); if (opts.fail) throw new Error("HTTP 503"); return make(query, "image"); },
  };
  return { provider, calls };
}

const build = (strategy: VisualStrategy) => (materialGapImages?: string[]) => productPlan({
  beats: BEATS, topic: TOPIC, strategy, providers: { voice: "elevenlabs", footage: "pexels-video-first", image: "openai", aiVideo: "veo", music: "curated-library" },
  cinematicV6: false, materialGapImages,
});

const STOCK = new Set(["stock_video", "stock_image", "ken_burns_image"]);

test("Económico: carencia inevitable visible ANTES de confirmar, con el número de escenas; el plan no cambia", async () => {
  const { provider } = catalog();
  const { result, material } = await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: provider, build: build("economical") });
  assert.equal(material.status, "unavoidable_gap");
  if (material.status !== "unavoidable_gap") return;
  assert.ok(material.missing > 0);
  assert.equal(material.missing, material.shotIds.length);
  assert.equal(result.plan.materialGapImages, undefined);
  assert.equal(result.plan.aiImageCount, 0);
  assert.match(materialBlockText(material, "economical")!, new RegExp(`${material.missing} escena\\(s\\)`));
  assert.match(materialBlockText(material, "economical")!, /Equilibrado o Cinemático/);
});

test("Equilibrado: cada escena sin archivo pasa a imagen IA, preciada EXACTAMENTE en el plan; la guarda de produce() pasa", async () => {
  const { provider } = catalog();
  const base = build("balanced")();
  const { result, material } = await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: provider, build: build("balanced") });
  assert.equal(material.status, "ok", JSON.stringify(material));
  if (material.status !== "ok") return;
  const plan = result.plan;
  const promoted = plan.materialGapImages ?? [];
  assert.ok(promoted.length > 0);
  assert.equal(material.promoted, promoted.length);
  const unit = getGenerativeUnitCosts(plan.providers.aiVideo, plan.providers.image).imageUsd;
  assert.equal(plan.aiImageCount, base.plan.aiImageCount + promoted.length);
  assert.equal(plan.allocation!.maxAiImageGenerations, base.plan.allocation!.maxAiImageGenerations + promoted.length);
  assert.ok(Math.abs(plan.estimatedImageCostUsd! - (base.plan.estimatedImageCostUsd! + promoted.length * unit)) < 1e-6);
  assert.ok(Math.abs(plan.estimatedProviderCostUsd - (base.plan.estimatedProviderCostUsd + promoted.length * unit)) < 1e-6);
  assert.equal(plan.shotCount, base.plan.shotCount);

  // Guarda final (produce): mismo preflight, con la allocation CONFIRMADA → sin carencias.
  const guard = await materialAvailabilityPreflight({ plan, allocation: plan.allocation!, beats: BEATS, topic: TOPIC, footageProvider: catalog().provider, aiVideoEnabled: false });
  assert.equal(guard.status, "ok", JSON.stringify(guard.missing));

  // Asignación del worker (limitsWithinAllocation + promoteToImage): exactamente esas escenas como imagen IA.
  const { shots, narrationSeconds } = planShotsFromScript(BEATS, TOPIC, "balanced", true, false);
  const limits = { ...limitsWithinAllocation(strategyLimits("balanced", plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled: false, units: getGenerativeUnitCosts(plan.providers.aiVideo, plan.providers.image) }), plan.allocation!),
    promoteToImage: planMaterialPromotions(plan) };
  const allocated = allocateShotTypes(shots, narrationSeconds, limits);
  for (const id of promoted) assert.equal(allocated.shots.find((s) => s.id === id)?.type, "generated_placeholder", id);
  assert.equal(allocated.aiImageGenerations, plan.allocation!.maxAiImageGenerations);
  // Ninguna escena con archivo disponible se promueve.
  assert.ok(promoted.every((id) => STOCK.has(shots.find((s) => s.id === id)?.type ?? "")), promoted.join(", "));
  // Las escenas con búfalos/jirafas (material pertinente) siguen siendo de archivo.
  assert.ok(allocated.shots.some((s) => STOCK.has(s.type)));
});

test("las tres estrategias comparten UNA caché de búsquedas (menos búsquedas que por separado)", async () => {
  const { provider, calls } = catalog();
  const { results, material } = await configurePlansWithMaterial({ script: { topic: TOPIC, beats: BEATS as never }, topic: TOPIC, durationSeconds: null, cinematicV6: false, footageProvider: provider });
  assert.equal(material.economical.status, "unavoidable_gap");
  assert.equal(material.balanced.status, "ok");
  assert.equal(material.cinematic.status, "ok");
  assert.equal(results.economical.plan.materialGapImages, undefined);
  assert.ok((results.balanced.plan.materialGapImages ?? []).length > 0);
  assert.equal(new Set(calls.filter((c) => c.startsWith("v:"))).size, calls.filter((c) => c.startsWith("v:")).length, "un video por consulta");
  // Sin la caché compartida, cada estrategia repetiría las mismas búsquedas.
  let separate = 0;
  for (const strategy of ["economical", "balanced", "cinematic"] as const) {
    const own = catalog();
    await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: own.provider, build: build(strategy) });
    separate += own.calls.length;
  }
  assert.ok(calls.length < separate, `${calls.length} con caché compartida vs ${separate} por separado`);
});

test("sin capacidad de imágenes IA la escena vuelve a archivo y queda como carencia (los topes de gasto deciden)", async () => {
  const prev = process.env.LONG_FORM_MAX_IMAGE_USD;
  process.env.LONG_FORM_MAX_IMAGE_USD = "0.0001";
  try {
    const { result, material } = await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: catalog().provider, build: build("balanced") });
    assert.equal(material.status, "unavoidable_gap", JSON.stringify(material));
    assert.equal(result.plan.allocation!.maxAiImageGenerations, 0);
  } finally {
    if (prev === undefined) delete process.env.LONG_FORM_MAX_IMAGE_USD;
    else process.env.LONG_FORM_MAX_IMAGE_USD = prev;
  }
});

test("proveedor de archivo caído: «no se pudo comprobar», nada se promueve", async () => {
  const { result, material } = await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: catalog({ fail: true }).provider, build: build("balanced") });
  assert.equal(material.status, "temporary_error");
  assert.equal(result.plan.materialGapImages, undefined);
});

test("sin proveedor de archivo en el entorno: no aplica (la guarda del inicio decide)", async () => {
  const { material } = await materialAwarePlan({ beats: BEATS, topic: TOPIC, footageProvider: null, build: build("economical") });
  assert.equal(material.status, "not_applicable");
});

test("plazo de las búsquedas: pasado el plazo, la búsqueda falla como error temporal (no espera la ventana del límite)", async () => {
  const slow: FootageProvider = {
    name: "slow",
    async fetchFootage() { throw new Error("x"); },
    async downloadFootage() { throw new Error("x"); },
    searchImageCandidates: () => new Promise(() => undefined),
  };
  const wrapped = withSearchDeadline(slow, Date.now() + 20);
  await assert.rejects(wrapped.searchImageCandidates!("q", "landscape"), /tiempo de comprobación/);
  const expired = withSearchDeadline(slow, Date.now() - 1);
  await assert.rejects(expired.searchImageCandidates!("q", "landscape"), /tiempo de comprobación/);
  const cache = createMaterialSearchCache();
  assert.equal(cache.size, 0);
});

test("promoteToImage nunca toca una escena que no es de archivo ni en Económico (sin imágenes IA)", () => {
  const { shots, narrationSeconds } = planShotsFromScript(BEATS, TOPIC, "economical", true, false);
  const ids = new Set(shots.map((s) => s.id));
  const econ = allocateShotTypes(shots, narrationSeconds, { ...strategyLimits("economical", 0, { aiVideoEnabled: false }), promoteToImage: ids });
  assert.equal(econ.aiImageGenerations, 0);
  assert.equal(build("economical")(shots.map((s) => s.id)).plan.materialGapImages, undefined);
  const text = shots.filter((s) => s.type === "text").map((s) => s.id);
  const balanced = build("balanced")([...text, "no-such-shot"]).plan;
  assert.equal(balanced.materialGapImages, undefined);
});
