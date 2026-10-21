import assert from "node:assert/strict";
import test from "node:test";
import {
  PILOT_COST_STAGES,
  pilotBudgetEnvelope,
  type PilotStageEstimate,
} from "./pilot-budget-envelope";

const complete = (overrides: Partial<Record<PilotStageEstimate["stage"], number | null>> = {}): PilotStageEstimate[] =>
  PILOT_COST_STAGES.map((stage) => ({
    stage,
    ceilingUsd: Object.prototype.hasOwnProperty.call(overrides, stage) ? overrides[stage]! : 0,
    retryPolicy: "reuse_paid_results" as const,
  }));

test("suma todas las etapas y propone un techo conservador redondeado hacia arriba", () => {
  const result = pilotBudgetEnvelope(complete({ research: 0.8, script: 1.2, style: 1, voice: 0.93, images: 1, video: 7, music: 0.5, render: 0.57 }), 20);
  assert.equal(result.ready, true);
  assert.equal(result.subtotalUsd, 13);
  assert.equal(result.proposedAuthorizationCeilingUsd, 15.6);
});

test("falla cerrado si falta una etapa o su costo no está verificado", () => {
  const missing = pilotBudgetEnvelope(complete().filter((item) => item.stage !== "style"));
  assert.deepEqual(missing.blockers, ["missing_stage:style"]);
  assert.equal(missing.proposedAuthorizationCeilingUsd, null);

  const unknown = pilotBudgetEnvelope(complete({ style: null }));
  assert.ok(unknown.blockers.includes("unverified_cost:style"));
  assert.equal(unknown.ready, false);
});

test("un costo negativo, infinito o contingencia inválida nunca produce techo", () => {
  const stages = complete();
  stages.find((item) => item.stage === "voice")!.ceilingUsd = -1;
  stages.find((item) => item.stage === "video")!.ceilingUsd = Number.POSITIVE_INFINITY;
  const result = pilotBudgetEnvelope(stages, 101);
  assert.ok(result.blockers.includes("unverified_cost:voice"));
  assert.ok(result.blockers.includes("unverified_cost:video"));
  assert.ok(result.blockers.includes("invalid_contingency"));
  assert.equal(result.subtotalUsd, null);
});

test("un reintento que puede volver a cobrar bloquea la propuesta", () => {
  const stages = complete({ voice: 1 });
  stages.find((item) => item.stage === "voice")!.retryPolicy = "may_rebill";
  const result = pilotBudgetEnvelope(stages);
  assert.ok(result.blockers.includes("retry_may_rebill:voice"));
  assert.equal(result.proposedAuthorizationCeilingUsd, null);
});

test("reutilizar resultados pagados no multiplica el techo por número de intentos", () => {
  const once = pilotBudgetEnvelope(complete({ voice: 1, images: 2, video: 3 }), 0);
  assert.equal(once.ready, true);
  assert.equal(once.subtotalUsd, 6);
});
