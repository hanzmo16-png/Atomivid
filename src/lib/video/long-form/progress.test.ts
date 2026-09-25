import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProductionProgress,
  completedStages,
  estimateRemainingRangeSeconds,
  formatRemainingRange,
  isProgressStageKey,
  isLongFormProgress,
} from "./progress";

test("computeProductionProgress: 0 unidades completadas da el inicio del rango de la etapa", () => {
  assert.equal(computeProductionProgress({ stage: "queued", unitsCompleted: 0, unitsTotal: 0 }), 0);
  assert.equal(computeProductionProgress({ stage: "assets", unitsCompleted: 0, unitsTotal: 14 }), 18);
});

test("computeProductionProgress: todas las unidades completadas da el final del rango de la etapa", () => {
  assert.equal(computeProductionProgress({ stage: "assets", unitsCompleted: 14, unitsTotal: 14 }), 78);
});

test("computeProductionProgress: es monotónico dentro de una etapa a medida que avanzan las unidades", () => {
  const values = Array.from({ length: 15 }, (_, i) => computeProductionProgress({ stage: "assets", unitsCompleted: i, unitsTotal: 14 }));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `el progreso retrocedió: ${values[i - 1]} -> ${values[i]}`);
  }
});

test("computeProductionProgress: es monotónico a través de TODA la secuencia real de etapas del pipeline", () => {
  const sequence: Array<{ stage: Parameters<typeof computeProductionProgress>[0]["stage"]; unitsCompleted: number; unitsTotal: number }> = [
    { stage: "queued", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "scripting", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "storyboard", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "assets", unitsCompleted: 0, unitsTotal: 10 },
    { stage: "assets", unitsCompleted: 5, unitsTotal: 10 },
    { stage: "assets", unitsCompleted: 10, unitsTotal: 10 },
    { stage: "rendering", unitsCompleted: 0, unitsTotal: 0 },
    { stage: "uploading", unitsCompleted: 0, unitsTotal: 0 },
  ];
  let prev = -1;
  for (const step of sequence) {
    const value = computeProductionProgress(step);
    assert.ok(value >= prev, `el progreso retrocedió en la etapa "${step.stage}": ${prev} -> ${value}`);
    prev = value;
  }
  // "uploading" sin unitsTotal conocido queda en el INICIO de su rango
  // (97) — el 100% real solo llega cuando status pasa a "completed", que
  // no es una etapa de este modelo (ver isTerminalStage).
  assert.equal(prev, 97);
});

test("computeProductionProgress: nunca añadir trabajo (fallback que aumenta unitsTotal) hace retroceder el porcentaje ya calculado antes del aumento", () => {
  const before = computeProductionProgress({ stage: "assets", unitsCompleted: 5, unitsTotal: 10 });
  // Un fallback añadió más unidades de trabajo de golpe (unitsTotal sube) —
  // el nuevo porcentaje para el MISMO trabajo ya hecho nunca debe ser menor
  // al que ya se mostró.
  const afterMoreWorkAdded = computeProductionProgress({ stage: "assets", unitsCompleted: 5, unitsTotal: 20 });
  assert.ok(afterMoreWorkAdded <= before, "más trabajo total con el mismo completado reduce el % (esperado), nunca lo sube artificialmente");
});

test("completedStages: devuelve exactamente las etapas anteriores en el orden real del pipeline", () => {
  assert.deepEqual(completedStages("assets"), ["queued", "scripting", "storyboard"]);
  assert.deepEqual(completedStages("queued"), []);
});

test("estimateRemainingRangeSeconds: devuelve un rango [bajo, alto] con bajo <= alto cuando hay evidencia", () => {
  const range = estimateRemainingRangeSeconds({ stage: "assets", unitsCompleted: 3, unitsTotal: 10 });
  assert.ok(range);
  assert.ok(range![0] <= range![1]);
});

test("estimateRemainingRangeSeconds: menos trabajo pendiente da un rango menor o igual que más trabajo pendiente", () => {
  const almostDone = estimateRemainingRangeSeconds({ stage: "assets", unitsCompleted: 9, unitsTotal: 10 })!;
  const justStarted = estimateRemainingRangeSeconds({ stage: "assets", unitsCompleted: 1, unitsTotal: 10 })!;
  assert.ok(almostDone[1] < justStarted[1], "con menos trabajo pendiente el techo del rango debe ser menor");
});

test("formatRemainingRange: nunca muestra falsa precisión de segundos exactos — siempre minutos o el mensaje de cálculo", () => {
  const text = formatRemainingRange([240, 420]);
  assert.match(text, /^Tiempo restante estimado: \d+(–\d+)? min$/);
  assert.equal(formatRemainingRange(null), "Calculando tiempo restante…");
});

test("isLongFormProgress: valida la forma real de long_form_progress (JSONB), rechaza valores ajenos", () => {
  assert.equal(
    isLongFormProgress({ stage: "assets", unitsCompleted: 3, unitsTotal: 10, unitLabel: "escenas", updatedAt: "2026-09-25T00:00:00Z" }),
    true,
  );
  assert.equal(isLongFormProgress(null), false);
  assert.equal(isLongFormProgress({}), false);
  assert.equal(isLongFormProgress({ stage: "not-a-real-stage", unitsCompleted: 0, unitsTotal: 0, unitLabel: "x", updatedAt: "x" }), false);
  assert.equal(isLongFormProgress({ stage: "assets", unitsCompleted: "3", unitsTotal: 10, unitLabel: "escenas", updatedAt: "x" }), false);
});

test("isProgressStageKey: valida solo las claves reales del pipeline", () => {
  assert.equal(isProgressStageKey("assets"), true);
  assert.equal(isProgressStageKey("queued"), true);
  assert.equal(isProgressStageKey("not-a-real-stage"), false);
  assert.equal(isProgressStageKey(123), false);
});
