import { test } from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_STEPS, clampStep } from "./steps";

test("ONBOARDING_STEPS tiene exactamente 5 pasos (máximo pedido)", () => {
  assert.equal(ONBOARDING_STEPS.length, 5);
});

test("ONBOARDING_STEPS: cada paso tiene título y cuerpo no vacíos", () => {
  for (const step of ONBOARDING_STEPS) {
    assert.ok(step.title.trim().length > 0);
    assert.ok(step.body.trim().length > 0);
  }
});

test("clampStep no permite bajar de 0", () => {
  assert.equal(clampStep(-1, 5), 0);
  assert.equal(clampStep(-100, 5), 0);
});

test("clampStep no permite pasar del último índice", () => {
  assert.equal(clampStep(10, 5), 4);
  assert.equal(clampStep(5, 5), 4);
});

test("clampStep deja pasar índices válidos sin cambiarlos", () => {
  assert.equal(clampStep(0, 5), 0);
  assert.equal(clampStep(2, 5), 2);
  assert.equal(clampStep(4, 5), 4);
});

test("clampStep maneja longitud 0 sin lanzar", () => {
  assert.equal(clampStep(0, 0), 0);
  assert.equal(clampStep(3, 0), 0);
});
