import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProductionPlan,
  computeScriptHash,
  estimateNarrationSeconds,
  executionAllocation,
  isProductionPlan,
  planShotsFromScript,
  resolveExecutablePlan,
  strategyToAiVideoCostPreset,
  LongFormPlanNotExecutableError,
  PRODUCTION_PLAN_VERSION,
  REAL_LONG_FORM_PROVIDER_NAMES,
  VISUAL_STRATEGIES,
  type ProductionPlan,
  type VisualStrategy,
} from "./production-plan";
import { documentary180sFixture, documentary180sLegacyFixture } from "./test-fixtures";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Entorno con video IA habilitado (el interlock global del cost guard exige LONG_FORM_AI_VIDEO_ENABLED). */
function planFor(strategy: VisualStrategy, script = documentary180sFixture(), aiVideoEnabled = true): ProductionPlan {
  return withEnv({ LONG_FORM_AI_VIDEO_ENABLED: aiVideoEnabled ? "true" : "false" }, () =>
    computeProductionPlan({ beats: script.beats, topic: script.topic, strategy, providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled }),
  );
}

test("fixture de 180 s: la duración estimada es ~3 minutos", () => {
  const plan = planFor("balanced");
  assert.ok(plan.durationSeconds >= 170 && plan.durationSeconds <= 195, `duración ${plan.durationSeconds}s`);
});

test("economical: cero imagen IA y cero video IA (y costo = solo narración)", () => {
  const plan = planFor("economical");
  assert.equal(plan.aiImageCount, 0);
  assert.equal(plan.aiVideoClipCount, 0);
  assert.equal(plan.aiVideoSeconds, 0);
  assert.equal(plan.estimatedImageCostUsd, 0);
  assert.equal(plan.estimatedAiVideoCostUsd, 0);
  assert.equal(plan.estimatedProviderCostUsd, plan.estimatedVoiceCostUsd);
  assert.deepEqual(plan.allocation, { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 });
});

test("balanced: uso selectivo — imágenes IA > 0, sin video IA, menos generación que cinematic", () => {
  const balanced = planFor("balanced");
  const cinematic = planFor("cinematic");
  assert.ok(balanced.aiImageCount > 0);
  assert.equal(balanced.aiVideoClipCount, 0);
  assert.ok(balanced.aiImageCount < balanced.shotCount / 2, "balanced nunca es mayoritariamente IA");
  const generative = (p: ProductionPlan) => p.aiImageCount + p.aiVideoClipCount;
  assert.ok(generative(cinematic) > generative(balanced), "cinematic genera más que balanced");
});

test("cinematic: incluye clips de video IA cuando el entorno lo permite y el contenido lo justifica", () => {
  const plan = planFor("cinematic");
  assert.ok(plan.aiVideoClipCount > 0);
  assert.ok(plan.aiVideoSeconds > 0);
  assert.equal(plan.aiVideoBilledSeconds, plan.aiVideoClipCount * 8, "Veo factura clips de 8 s");
  assert.ok(plan.aiVideoSeconds <= plan.durationSeconds * 0.2 + 1e-6, "nunca más del 20% del tiempo con video IA (preset premium)");
});

test("las tres estrategias producen planes MATERIALMENTE distintos y costos crecientes", () => {
  const [e, b, c] = (["economical", "balanced", "cinematic"] as const).map((s) => planFor(s));
  assert.ok(e.estimatedProviderCostUsd < b.estimatedProviderCostUsd);
  assert.ok(b.estimatedProviderCostUsd < c.estimatedProviderCostUsd);
  assert.notDeepEqual([e.aiImageCount, e.aiVideoClipCount], [b.aiImageCount, b.aiVideoClipCount]);
  assert.notDeepEqual([b.aiImageCount, b.aiVideoClipCount], [c.aiImageCount, c.aiVideoClipCount]);
});

test("costos del plan salen de las tarifas reales configuradas (voz, imagen, Veo)", () => {
  const plan = planFor("cinematic");
  const imageGenerations = plan.aiImageCount + plan.aiVideoClipCount; // cada clip usa 1 imagen de referencia
  assert.equal(plan.allocation?.maxAiImageGenerations, imageGenerations);
  assert.equal(Math.round((plan.estimatedImageCostUsd ?? 0) * 1e4), Math.round(imageGenerations * 0.05 * 1e4));
  assert.equal(Math.round((plan.estimatedAiVideoCostUsd ?? 0) * 1e4), Math.round(plan.aiVideoClipCount * 8 * 0.12 * 1e4));
  const voice = (plan.voiceCharacters / 1000) * 0.1;
  assert.equal(Math.round((plan.estimatedVoiceCostUsd ?? 0) * 1e4), Math.round(voice * 1e4));
  assert.equal(
    Math.round(plan.estimatedProviderCostUsd * 1e4),
    Math.round(((plan.estimatedVoiceCostUsd ?? 0) + (plan.estimatedImageCostUsd ?? 0) + (plan.estimatedAiVideoCostUsd ?? 0)) * 1e4),
  );
});

test("cinematic sin video IA habilitado: 0 clips, lo indica (aiVideoAvailable=false) y usa imágenes IA en su lugar", () => {
  const plan = planFor("cinematic", documentary180sFixture(), false);
  assert.equal(plan.aiVideoClipCount, 0);
  assert.equal(plan.aiVideoAvailable, false);
  assert.ok(plan.aiImageCount > planFor("balanced").aiImageCount);
});

test("el plan nunca excede el tope global LONG_FORM_MAX_TOTAL_USD — degrada en vez de exceder", () => {
  const plan = withEnv({ LONG_FORM_MAX_TOTAL_USD: "2", LONG_FORM_AI_VIDEO_ENABLED: "true" }, () =>
    computeProductionPlan({ ...documentary180sFixture(), strategy: "cinematic", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: true }),
  );
  assert.ok(plan.estimatedProviderCostUsd <= 2 + 1e-9, `costo ${plan.estimatedProviderCostUsd}`);
  assert.ok(plan.aiVideoClipCount < planFor("cinematic").aiVideoClipCount, "con $2 caben menos clips que sin tope");
});

test("determinístico: mismo guion + estrategia => mismo plan", () => {
  assert.deepEqual(planFor("cinematic"), planFor("cinematic"));
});

test("shots de producto: nunca intención de fixture, nunca diagrama/mapa de fixture", () => {
  for (const script of [documentary180sFixture(), documentary180sLegacyFixture()]) {
    for (const strategy of VISUAL_STRATEGIES) {
      const { shots } = planShotsFromScript(script.beats, script.topic, strategy);
      for (const shot of shots) {
        assert.doesNotMatch(shot.visualIntent, /\bfor (hook|setup|discovery|escalation|twist|insight|payoff|next_curiosity)\b/);
        assert.doesNotMatch(shot.visualIntent, /generated_placeholder|stock_video|ken_burns|fixture/);
        assert.ok(!["diagram", "map"].includes(shot.type), `${shot.id} es ${shot.type}`);
        assert.notEqual(shot.source, "fixture");
      }
    }
  }
});

test("guion sin `visuals` (anterior a este campo): intenciones derivadas del tema + narración, y 0 video IA", () => {
  const legacy = documentary180sLegacyFixture();
  const { shots } = planShotsFromScript(legacy.beats, legacy.topic, "balanced");
  assert.ok(shots.every((s) => s.visualIntent.startsWith(legacy.topic)));
  assert.equal(planFor("cinematic", legacy).aiVideoClipCount, 0, "sin escenas de movimiento declaradas, el contenido no justifica video IA");
});

test("scriptHash: estable y sensible a cualquier cambio de narración", () => {
  const script = documentary180sFixture();
  const hash = computeScriptHash(script.beats);
  assert.equal(hash, computeScriptHash(documentary180sFixture().beats));
  const edited = script.beats.map((b, i) => (i === 2 ? { ...b, narration: b.narration + " Extra." } : b));
  assert.notEqual(hash, computeScriptHash(edited));
});

test("resolveExecutablePlan: sin confirmación, plan inválido, versión desconocida o guion cambiado => no ejecuta", () => {
  const script = documentary180sFixture();
  const plan = planFor("balanced");
  assert.throws(() => resolveExecutablePlan({ confirmedAt: null, plan, beats: script.beats }), LongFormPlanNotExecutableError);
  assert.throws(() => resolveExecutablePlan({ confirmedAt: "2026-09-25T00:00:00Z", plan: null, beats: script.beats }), LongFormPlanNotExecutableError);
  assert.throws(
    () => resolveExecutablePlan({ confirmedAt: "2026-09-25T00:00:00Z", plan: { ...plan, version: 99 }, beats: script.beats }),
    /versión \(99\)/,
  );
  const edited = script.beats.map((b, i) => (i === 0 ? { ...b, narration: "Otro texto." } : b));
  assert.throws(() => resolveExecutablePlan({ confirmedAt: "2026-09-25T00:00:00Z", plan, beats: edited }), /guion cambió/);
  assert.equal(resolveExecutablePlan({ confirmedAt: "2026-09-25T00:00:00Z", plan, beats: script.beats }), plan);
});

test("resolveExecutablePlan: un plan v1 (anterior) se ejecuta de forma compatible y CONSERVADORA (0 video IA)", () => {
  const script = documentary180sFixture();
  const chars = script.beats.reduce((s, b) => s + b.narration.length, 0);
  const v1 = {
    version: 1,
    strategy: "cinematic" as const,
    durationSeconds: 180,
    shotCount: 45,
    stockVideoCount: 10,
    stockImageCount: 10,
    aiImageCount: 9,
    aiVideoClipCount: 6,
    aiVideoSeconds: 30,
    deterministicCount: 10,
    voiceCharacters: chars,
    providers: REAL_LONG_FORM_PROVIDER_NAMES,
    estimatedProviderCostUsd: 2.4,
    estimatedCredits: null,
    confirmedAt: null,
  };
  const plan = resolveExecutablePlan({ confirmedAt: "2026-09-25T00:00:00Z", plan: v1, beats: script.beats });
  assert.deepEqual(executionAllocation(plan), { maxAiImageGenerations: 9, maxAiVideoClips: 0, maxGenerativeUsd: 2.4 });
});

test("PRODUCTION_PLAN_VERSION es 2 e isProductionPlan valida la forma", () => {
  const plan = planFor("balanced");
  assert.equal(plan.version, PRODUCTION_PLAN_VERSION);
  assert.equal(PRODUCTION_PLAN_VERSION, 2);
  assert.equal(isProductionPlan(plan), true);
  assert.equal(isProductionPlan({ ...plan, strategy: "otro" }), false);
  assert.equal(isProductionPlan(null), false);
});

test("estimatedCredits siempre null (no hay sistema de créditos real) y confirmedAt null al calcular", () => {
  for (const s of VISUAL_STRATEGIES) {
    const plan = planFor(s);
    assert.equal(plan.estimatedCredits, null);
    assert.equal(plan.confirmedAt, null);
  }
});

test("estimateNarrationSeconds / strategyToAiVideoCostPreset", () => {
  assert.ok(estimateNarrationSeconds("una dos tres cuatro cinco seis siete ocho") < 5);
  assert.equal(strategyToAiVideoCostPreset("economical"), "economic");
  assert.equal(strategyToAiVideoCostPreset("balanced"), "balanced");
  assert.equal(strategyToAiVideoCostPreset("cinematic"), "premium");
});
