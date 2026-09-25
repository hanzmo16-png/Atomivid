import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VISIBLE_PROGRESS_STAGES,
  completedStages,
  computeProductionProgress,
  estimateRemainingRangeSeconds,
  formatRemainingRange,
  isLongFormProgress,
  isProgressStageKey,
  nextDisplayedProgress,
  MIN_UNITS_FOR_ETA,
  type ProgressStageKey,
} from "./progress";

test("computeProductionProgress: 0 unidades = inicio de la etapa; todas = fin (nunca 100 mientras procesa)", () => {
  assert.equal(computeProductionProgress({ stage: "queued", unitsCompleted: 0, unitsTotal: 0 }), 0);
  assert.equal(computeProductionProgress({ stage: "assets", unitsCompleted: 0, unitsTotal: 14 }), 14);
  assert.equal(computeProductionProgress({ stage: "assets", unitsCompleted: 14, unitsTotal: 14 }), 72);
  assert.equal(computeProductionProgress({ stage: "rendering", unitsCompleted: 5400, unitsTotal: 5400 }), 97);
  assert.ok(computeProductionProgress({ stage: "uploading", unitsCompleted: 1, unitsTotal: 1 }) <= 99);
});

test("computeProductionProgress: monotónico a lo largo de la secuencia REAL que emite produce.ts", () => {
  type Step = { stage: ProgressStageKey; unitsCompleted: number; unitsTotal: number };
  const sequence: Step[] = [
    { stage: "queued", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "scripting", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "storyboard", unitsCompleted: 0, unitsTotal: 5 },
    ...Array.from({ length: 5 }, (_, i) => ({ stage: "storyboard", unitsCompleted: i + 1, unitsTotal: 5 })),
    { stage: "assets", unitsCompleted: 0, unitsTotal: 45 },
    ...Array.from({ length: 45 }, (_, i) => ({ stage: "assets", unitsCompleted: i + 1, unitsTotal: 45 })),
    { stage: "rendering", unitsCompleted: 0, unitsTotal: 0 },
    ...Array.from({ length: 50 }, (_, i) => ({ stage: "rendering", unitsCompleted: (i + 1) * 108, unitsTotal: 5400 })),
  ] as Step[];
  let prev = -1;
  for (const step of sequence) {
    const value = computeProductionProgress(step);
    assert.ok(value >= prev, `retrocedió en ${step.stage}: ${prev} -> ${value}`);
    assert.ok(value < 100, "nunca 100% mientras la solicitud sigue procesando");
    prev = value;
  }
});

test("el antiguo salto assets → ai_video → assets ya no existe: ai_video no es una fase visible", () => {
  assert.ok(!VISIBLE_PROGRESS_STAGES.includes("ai_video"));
  assert.deepEqual(VISIBLE_PROGRESS_STAGES, ["scripting", "storyboard", "assets", "rendering"]);
});

test("nextDisplayedProgress: un fallback que añade trabajo nunca hace retroceder lo mostrado", () => {
  const shown = computeProductionProgress({ stage: "assets", unitsCompleted: 5, unitsTotal: 10 });
  const recomputed = computeProductionProgress({ stage: "assets", unitsCompleted: 5, unitsTotal: 20 });
  assert.ok(recomputed < shown);
  assert.equal(nextDisplayedProgress(shown, recomputed), shown);
  assert.equal(nextDisplayedProgress(null, 30), 30);
});

test("ETA: sin evidencia observada (pocas unidades, sin stageStartedAt o sin unidades) => null", () => {
  const now = Date.parse("2026-09-25T12:10:00Z");
  assert.equal(estimateRemainingRangeSeconds({ stage: "assets", unitsCompleted: 5, unitsTotal: 45 }, now), null);
  assert.equal(
    estimateRemainingRangeSeconds({ stage: "assets", unitsCompleted: MIN_UNITS_FOR_ETA - 1, unitsTotal: 45, stageStartedAt: "2026-09-25T12:00:00Z" }, now),
    null,
  );
  assert.equal(estimateRemainingRangeSeconds({ stage: "rendering", unitsCompleted: 0, unitsTotal: 0, stageStartedAt: "2026-09-25T12:00:00Z" }, now), null);
  assert.equal(formatRemainingRange(null), "Calculando tiempo restante…");
});

test("ETA: derivado SOLO del ritmo observado (10 escenas en 5 min => 35 restantes ~ 17.5 min) y como rango", () => {
  const range = estimateRemainingRangeSeconds(
    { stage: "assets", unitsCompleted: 10, unitsTotal: 45, stageStartedAt: "2026-09-25T12:00:00Z", updatedAt: "2026-09-25T12:05:00Z" },
    Date.parse("2026-09-25T12:05:10Z"),
  );
  assert.ok(range);
  const [low, high] = range!;
  assert.equal(low, Math.round(35 * 30 * 0.8));
  assert.equal(high, Math.round(35 * 30 * 1.5));
  assert.match(formatRemainingRange(range), /^Tiempo restante de esta etapa: \d+–\d+ min$/);
});

test("ETA: nunca precisión de segundos exactos", () => {
  assert.doesNotMatch(formatRemainingRange([240, 263]), /\d+:\d{2}/);
});

test("isLongFormProgress valida la forma persistida (incluido stageStartedAt opcional)", () => {
  const base = { stage: "assets", unitsCompleted: 3, unitsTotal: 10, unitLabel: "escenas", updatedAt: "2026-09-25T00:00:00Z" };
  assert.equal(isLongFormProgress(base), true);
  assert.equal(isLongFormProgress({ ...base, stageStartedAt: "2026-09-25T00:00:00Z" }), true);
  assert.equal(isLongFormProgress({ ...base, stageStartedAt: 5 }), false);
  assert.equal(isLongFormProgress({ ...base, stage: "nope" }), false);
  assert.equal(isLongFormProgress(null), false);
});

test("completedStages / isProgressStageKey", () => {
  assert.deepEqual(completedStages("assets"), ["queued", "scripting", "storyboard"]);
  assert.deepEqual(completedStages("queued"), []);
  assert.equal(isProgressStageKey("rendering"), true);
  assert.equal(isProgressStageKey(1), false);
});
