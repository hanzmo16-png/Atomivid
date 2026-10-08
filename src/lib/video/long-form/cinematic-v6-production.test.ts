/**
 * Cinematic V6 en producción (plan v6): la versión la decide el servidor por cuenta,
 * el guion la propone el guionista (impact/impactReason) y el worker vuelve a comprobar
 * la cuenta. Todo offline: ninguna llamada pagada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertCinematicV6Account, CinematicV6AccessError, cinematicV6Enabled } from "./cinematic-v6-access";
import { productPlan } from "./product-plan";
import { sequencesFromScript } from "./script-sequences";
import { computeProductionPlan, getRealLongFormProviderNames, resolveExecutablePlan, type ProductionPlanBeatInput } from "./production-plan";
import { PRODUCT_DEFAULT_PLAN_VERSION, isExecutablePlanVersion } from "./production-plan-types";
import { confirmLongFormProduction } from "./confirm-production";
import { showcaseBeats, showcaseFootageProvider, showcaseRegistry, SHOWCASE_TOPIC } from "./showcase-fixtures";
import { produceOffline } from "./cinematic-simulation";
import type { ProductionPlan } from "./production-plan";
import { documentary180sFixture } from "./test-fixtures";

const OWNER = { email: "Owner@Example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const OTHER = { email: "someone@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const ENV = { CINEMATIC_V6_ENABLED_EMAILS: " owner@example.com , second@example.com" };
const providers = getRealLongFormProviderNames();

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls++;
  throw new Error("cinematic v6 production test: red prohibida");
}) as typeof fetch;
const BASE = "http://127.0.0.1:0";

const IMPACT: Record<string, [number, string]> = {
  "quiet street": [3, "opens the story in its place and year"],
  "Fixture Person portrait": [3, "introduces the protagonist"],
  "front page": [2, "the record that carries the event"],
  "the gazette headline": [3, "the reveal of the event"],
  schematic: [1, "the evidence explained calmly"],
};
function withImpact(beats: ProductionPlanBeatInput[], drop?: string): (ProductionPlanBeatInput & { purpose: string })[] {
  return beats.map((b) => ({
    ...b,
    purpose: `${b.type} purpose`,
    visuals: (b.visuals as Record<string, unknown>[]).map((v) => {
      const key = Object.keys(IMPACT).find((k) => String(v.description).startsWith(k));
      if (!key || key === drop) return v;
      return { ...v, impact: IMPACT[key][0], impactReason: IMPACT[key][1] };
    }),
  }));
}

test("cinematicV6Enabled: lista explícita, sin distinguir mayúsculas; email sin confirmar o vacío nunca", () => {
  assert.equal(cinematicV6Enabled(OWNER, ENV), true);
  assert.equal(cinematicV6Enabled(OTHER, ENV), false);
  assert.equal(cinematicV6Enabled({ ...OWNER, email_confirmed_at: null }, ENV), false);
  assert.equal(cinematicV6Enabled(null, ENV), false);
  assert.equal(cinematicV6Enabled(OWNER, {}), false);
  assert.equal(cinematicV6Enabled(OTHER, { CINEMATIC_V6_ALL_USERS: "true" }), true);
  assert.equal(cinematicV6Enabled({ ...OTHER, email_confirmed_at: null }, { CINEMATIC_V6_ALL_USERS: "true" }), false);
});

test("producto por defecto: cuenta sin V6 recibe v3, idéntico al plan v3 explícito (aunque el guion declare impacto)", () => {
  const beats = withImpact(showcaseBeats);
  for (const strategy of ["economical", "balanced", "cinematic"] as const) {
    const r = productPlan({ beats, topic: SHOWCASE_TOPIC, strategy, providers, cinematicV6: false });
    assert.equal(r.engine, "default");
    assert.equal(r.plan.version, PRODUCT_DEFAULT_PLAN_VERSION);
    assert.equal(r.plan.sequences, undefined);
    assert.deepEqual(r.plan, computeProductionPlan({ beats, topic: SHOWCASE_TOPIC, strategy, providers, version: 3 }));
  }
  // Un guion anterior (sin impacto) también es v3, y v3 no lee clase ni identidad.
  const legacy = productPlan({ beats: showcaseBeats, topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: false });
  assert.equal(legacy.plan.version, 3);
});

test("cuenta habilitada + guion con impacto en todas sus escenas: plan v6 con secuencias del guion", () => {
  const r = productPlan({ beats: withImpact(showcaseBeats), topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: true });
  assert.equal(r.engine, "cinematic-v6");
  assert.equal(r.plan.version, 6);
  assert.ok(r.plan.sequences && r.plan.sequences.length === 2);
  assert.ok(isExecutablePlanVersion(6));
  assert.equal(isExecutablePlanVersion(5), false, "v5 sigue sin ejecutarse en producción");
});

test("cuenta habilitada + impacto incompleto: se queda en v3 con el motivo", () => {
  const r = productPlan({ beats: withImpact(showcaseBeats, "front page"), topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: true });
  assert.equal(r.engine, "default");
  assert.equal(r.plan.version, 3);
  assert.match(r.reason, /impacto/);
});

test("sequencesFromScript: una secuencia por beat; la prueba de impacto 3 se sostiene y revela su titular", () => {
  const seqs = sequencesFromScript(withImpact(showcaseBeats));
  assert.ok(seqs);
  assert.deepEqual(seqs.map((s) => s.beatIds), [["s1"], ["s2"]]);
  assert.deepEqual(seqs[0].slots.map((s) => [s.role, s.scale, s.impact]), [["CONTEXT", "WIDE", 3], ["ANCHOR", "MEDIUM", 3]]);
  const roles = seqs[1].slots.map((s) => s.role);
  assert.deepEqual(roles, ["EVIDENCE", "EVIDENCE", "DETAIL", "EVIDENCE"]);
  const detail = seqs[1].slots[2];
  assert.deepEqual(detail.detail, { of: 1, region: "headline" });
  for (const s of seqs.flatMap((q) => q.slots)) assert.equal("impact" in (s.visual as object), false, "el contrato v4 de la escena no arrastra impact");
  assert.equal(sequencesFromScript(withImpact(showcaseBeats, "Fixture Person portrait")), null);
  assert.equal(sequencesFromScript([{ id: "x", narration: "No visuals here.", visuals: [] }]), null);
});

test("resolveExecutablePlan acepta el v6 confirmado y sigue rechazando versiones desconocidas", () => {
  const beats = withImpact(showcaseBeats);
  const { plan } = productPlan({ beats, topic: SHOWCASE_TOPIC, strategy: "balanced", providers, cinematicV6: true });
  assert.equal(resolveExecutablePlan({ confirmedAt: "2026-10-08T00:00:00Z", plan, beats }).version, 6);
  assert.throws(() => resolveExecutablePlan({ confirmedAt: "2026-10-08T00:00:00Z", plan: { ...plan, version: 5 }, beats }));
  assert.throws(() => resolveExecutablePlan({ confirmedAt: "2026-10-08T00:00:00Z", plan: { ...plan, version: 7 }, beats }));
});

test("worker: v1–v4 no consultan la cuenta; v5+ falla cerrado sin cuenta habilitada", async () => {
  let calls = 0;
  const load = (u: unknown) => async () => { calls += 1; return u as typeof OWNER; };
  for (const version of [1, 2, 3, 4]) await assertCinematicV6Account({ version }, load(OTHER), ENV);
  await assertCinematicV6Account(null, load(OTHER), ENV);
  assert.equal(calls, 0);
  await assertCinematicV6Account({ version: 6 }, load(OWNER), ENV);
  await assert.rejects(assertCinematicV6Account({ version: 6 }, load(OTHER), ENV), CinematicV6AccessError);
  await assert.rejects(assertCinematicV6Account({ version: 6 }, load(null), ENV), CinematicV6AccessError);
  await assert.rejects(assertCinematicV6Account({ version: 6 }, async () => { throw new Error("auth down"); }, ENV), CinematicV6AccessError);
  await assert.rejects(assertCinematicV6Account({ version: 6 }, load(OWNER), {}), CinematicV6AccessError, "sin variable en el worker no se ejecuta v6");
});

test("run-job.ts comprueba la cuenta V6 después del plan ejecutable y antes de reservar o llamar a proveedores", () => {
  const src = readFileSync(path.join(__dirname, "../run-job.ts"), "utf8");
  const resolved = src.indexOf("resolveExecutablePlan({");
  const check = src.indexOf("await assertCinematicV6Account(longFormPlan");
  const reserve = src.indexOf("await reserveJobSupply(");
  const produce = src.indexOf("await generateLongFormVideoFromScript(");
  assert.ok(resolved > 0 && check > resolved && reserve > check && produce > reserve);
  assert.match(src.slice(check, reserve), /service\.auth\.admin\.getUserById\(row\.user_id\)/);
});

function fakeService(initial: Record<string, unknown>) {
  const row = { ...initial };
  const builder = (kind: "select" | "update", values?: Record<string, unknown>) => {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), api),
      async maybeSingle() {
        const ok = filters.every((f) => f(row));
        if (kind === "select") return { data: ok ? { ...row } : null, error: null };
        if (!ok) return { data: null, error: null };
        Object.assign(row, values);
        return { data: { ...row }, error: null };
      },
    };
    return api;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: () => ({ select: () => builder("select"), update: (v: Record<string, unknown>) => builder("update", v) }) } as any, row };
}

test("confirm-production: v6 solo con cinematicV6 del servidor; sin él, v3; una confirmación existente nunca cambia de versión", async () => {
  const script = { topic: SHOWCASE_TOPIC, beats: withImpact(showcaseBeats) };
  const base = { id: "req-1", mode: "long_form", user_id: "user-1", status: "script_ready", topic: SHOWCASE_TOPIC, script_json: script, long_form_production_plan: null, long_form_confirmed_at: null };
  const owner = fakeService(base);
  const r6 = await confirmLongFormProduction(owner.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", cinematicV6: true });
  assert.equal(r6.ok && r6.plan.version, 6);
  const other = fakeService(base);
  const r3 = await confirmLongFormProduction(other.client, { requestId: "req-1", userId: "user-1", strategy: "balanced" });
  assert.equal(r3.ok && r3.plan.version, 3);
  // Ya confirmado en v3: activar V6 después no lo reescribe.
  const again = await confirmLongFormProduction(other.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", cinematicV6: true });
  assert.equal(again.ok && again.alreadyConfirmed && again.plan.version, 3);
  // Guion anterior (sin impacto) de una cuenta habilitada: v3.
  const legacy = fakeService({ ...base, script_json: documentary180sFixture(), topic: documentary180sFixture().topic });
  const rl = await confirmLongFormProduction(legacy.client, { requestId: "req-1", userId: "user-1", strategy: "balanced", cinematicV6: true });
  assert.equal(rl.ok && rl.plan.version, 3);
});

async function executeOffline(cinematicV6: boolean, registry: boolean) {
  const beats = withImpact(showcaseBeats);
  const { plan } = productPlan({ beats, topic: SHOWCASE_TOPIC, strategy: "economical", providers, cinematicV6 });
  const confirmed = resolveExecutablePlan({ confirmedAt: "2026-10-08T00:00:00Z", plan: { ...plan, confirmedAt: "2026-10-08T00:00:00Z" } as ProductionPlan, beats });
  const downloads: string[] = [];
  let scenes: { direction?: { shot?: { reveal?: boolean } } }[] = [];
  const run = await produceOffline(beats, confirmed, {
    topic: SHOWCASE_TOPIC,
    ...(registry ? { verifiedAssets: showcaseRegistry(BASE) } : {}),
    // v6 recibe el pool del registro; v3 usa el stock genérico de la simulación (búsqueda por palabras clave).
    ...(cinematicV6 ? { footageProvider: showcaseFootageProvider(BASE, async (u) => (downloads.push(u), Buffer.from(`bytes:${u}`))) } : {}),
    onRender: (i) => (scenes = (i as unknown as { scenes: typeof scenes }).scenes),
  });
  return { plan: confirmed, run, downloads, scenes };
}

test("ruta real de producción (offline): el plan v6 derivado del guion se ejecuta en produce.ts hasta el render, sin red ni gasto", async () => {
  const { plan, run, scenes } = await executeOffline(true, true);
  assert.equal(plan.version, 6);
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.events.includes("render"));
  assert.ok(scenes.some((s) => s.direction?.shot?.reveal === true), "la prueba de impacto 3 se revela (DETAIL headline)");
  assert.equal(networkCalls, 0);
});

test("ruta real de producción (offline): v6 sin material verificado y curado se detiene ANTES de descargar o renderizar", async () => {
  const { run, downloads } = await executeOffline(true, false);
  assert.match(String(run.error), /HERO_(EVIDENCE|IDENTITY)_COVERAGE_MISSING/);
  assert.equal(run.events.includes("render"), false);
  assert.deepEqual(downloads, []);
  assert.equal(networkCalls, 0);
});

test("ruta real de producción (offline): el v3 por defecto del producto se sigue ejecutando hasta el render", async () => {
  const { plan, run } = await executeOffline(false, false);
  assert.equal(plan.version, 3);
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.events.includes("render"));
  assert.equal(networkCalls, 0);
});

test("guion: sin V6 el plan visual pide el contrato de producción (sin clase ni impacto, sin personas reales identificables)", async () => {
  const { z } = await import("zod");
  const { ProductBeatVisualsSchema, ProductReferencedVisualsSchema } = await import("./documentary-script");
  for (const schema of [ProductBeatVisualsSchema, ProductReferencedVisualsSchema]) {
    const json = JSON.stringify(z.toJSONSchema(schema, { reused: "ref" }));
    for (const field of ["beatClass", "identity", "evidence", "impact", "impactReason"]) assert.equal(json.includes(`"${field}"`), false, field);
    assert.match(json, /ni personas reales identificables/);
  }
  const src = readFileSync(path.join(__dirname, "script-jobs.ts"), "utf8");
  assert.match(src, /cinematicV6:cinematicV6Enabled\(owner\.user\)/, "el worker de guiones decide V6 con la cuenta dueña del trabajo");
});

test("guion V6: un campo opcional inválido del guionista se descarta, nunca hace fallar el guion", async () => {
  const { dropInvalidOptionalVisualFields, VisualSchema } = await import("./documentary-script");
  const base = { description: "a quiet street", motion: false, quote: "the street was quiet that morning", subject: "street" };
  const bad = dropInvalidOptionalVisualFields({ ...base, beatClass: "identity", impact: 4, impactReason: "x".repeat(200), identity: "Maurizio", evidence: { sourceIds: ["s1"] } }) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bad).sort(), [...Object.keys(base), "evidence"].sort());
  assert.ok(VisualSchema.safeParse(bad).success);
  const good = dropInvalidOptionalVisualFields({ ...base, beatClass: "PLACE", impact: 2, impactReason: "sets the place" }) as Record<string, unknown>;
  assert.equal(good.impact, 2);
  assert.equal(good.beatClass, "PLACE");
});

test("render: v1–v3 (sin plano dirigido) conservan el movimiento lineal de producción; solo los planos dirigidos usan easing", async () => {
  const { cameraTransform, kenBurnsTransform } = await import("../../../../remotion/long-form-direction");
  const { interpolate } = await import("remotion");
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    assert.equal(cameraTransform("push", p, false), `scale(${1 + 0.08 * p})`);
    assert.equal(cameraTransform("pull", p, false), `scale(${1.08 - 0.08 * p})`);
    assert.equal(cameraTransform("left", p, false), `translateX(${2 - 4 * p}%) scale(1.08)`);
    assert.deepEqual(kenBurnsTransform(p, false, false), { scale: interpolate(p, [0, 1], [1, 1.08]), translateX: interpolate(p, [0, 1], [0, -14]) });
  }
  assert.equal(kenBurnsTransform(0.2, true, false).scale, 1.08);
  assert.notEqual(cameraTransform("push", 0.25, true), cameraTransform("push", 0.25, false));
  const doc = readFileSync(path.join(__dirname, "../../../../remotion/LongFormDoc.tsx"), "utf8");
  assert.match(doc, /const eased = scene\.direction\?\.shot !== undefined;/);
});
