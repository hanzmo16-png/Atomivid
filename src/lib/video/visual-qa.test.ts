import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateVisualQuality, simulateVisualQuality, nextFallbackStep } from "./visual-qa";
import { simulateStoryboard } from "./storyboard/simulate";
import type { GeneratedScript } from "@/lib/providers/types";
import type { GenerativeAsset } from "@/lib/providers/types";

function makeScene() {
  const script: GeneratedScript = { title: "t", segments: [{ text: "hola", visualQuery: "person" }] };
  return simulateStoryboard(script).scenes[0];
}

function makeAsset(overrides: Partial<GenerativeAsset> = {}): GenerativeAsset {
  return {
    buffer: Buffer.from("x"),
    mimeType: "image/png",
    extension: "png",
    width: 1080,
    height: 1920,
    model: "test",
    costUsd: 0,
    ...overrides,
  };
}

test("un asset con tamaño 0 falla el chequeo técnico y por lo tanto el reporte", () => {
  const report = evaluateVisualQuality(makeAsset({ buffer: Buffer.alloc(0) }), makeScene());
  assert.equal(report.technicalQuality.passed, false);
  assert.equal(report.passed, false);
});

test("un asset con dimensiones y tamaño correctos pasa los chequeos deterministas", () => {
  const report = evaluateVisualQuality(makeAsset(), makeScene());
  assert.equal(report.technicalQuality.passed, true);
  assert.equal(report.aspectRatioSafety.passed, true);
  assert.equal(report.passed, true);
});

test("correspondencia semántica, marcas de agua y riesgo de mala interpretación NUNCA se marcan como evaluados sin modelo multimodal", () => {
  const report = evaluateVisualQuality(makeAsset(), makeScene());
  assert.equal(report.semanticMatch.evaluated, false);
  assert.equal(report.watermarkFree.evaluated, false);
  assert.equal(report.misinterpretationRisk.evaluated, false);
});

test("un aspecto muy alejado de 9:16 falla el chequeo de seguridad de recorte", () => {
  const report = evaluateVisualQuality(makeAsset({ width: 1920, height: 1080 }), makeScene());
  assert.equal(report.aspectRatioSafety.passed, false);
});

test("el modo simulación nunca se presenta como evaluación real", () => {
  const report = simulateVisualQuality();
  assert.equal(report.mode, "simulated");
  assert.equal(report.technicalQuality.evaluated, false);
  assert.equal(report.aspectRatioSafety.evaluated, false);
  assert.equal(report.semanticMatch.evaluated, false);
  assert.equal(report.watermarkFree.evaluated, false);
  assert.equal(report.misinterpretationRisk.evaluated, false);
});

test("nextFallbackStep respeta el orden declarado y no repite pasos", () => {
  const scene = makeScene();
  const seen: string[] = [];
  let i = 0;
  let step = nextFallbackStep(scene, i);
  while (step) {
    seen.push(step);
    i += 1;
    step = nextFallbackStep(scene, i);
  }
  assert.deepEqual(seen, scene.fallbackStrategy);
});

test("nextFallbackStep nunca permite más pasos que los declarados (sin reintentos infinitos)", () => {
  const scene = makeScene();
  const step = nextFallbackStep(scene, scene.fallbackStrategy.length + 5);
  assert.equal(step, null);
});
