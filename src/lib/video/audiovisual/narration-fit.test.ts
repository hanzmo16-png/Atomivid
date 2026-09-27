/**
 * «Animación IA»: comprobación de que cada escena de la narración real
 * cabe en un clip ANTES de pagar imágenes y clips, y ajuste acotado de la
 * velocidad de la voz. Sin red ni gasto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WordTiming } from "@/lib/providers/types";
import { FIT_SAFETY_SECONDS, FIT_SPEED_RANGE, animatedNarrationFit, fitSpeedAdjustment } from "./narration-fit";

/** Escenas con `counts` palabras cada una (por defecto 4 × 15) a `wps` palabras por segundo, sin pausas. */
function narration(wps: number, counts = [15, 15, 15, 15]) {
  const segments = counts.map((n, s) => ({ text: Array.from({ length: n }, (_, w) => `p${s}x${w}`).join(" ") }));
  const words: WordTiming[] = segments
    .flatMap((seg) => seg.text.split(" "))
    .map((text, i) => ({ text, startSeconds: i / wps, endSeconds: (i + 1) / wps }));
  return { segments, words, narrationSeconds: words.length / wps };
}

const ENERGY = ["medium", "medium", "low", "medium"] as const;
const fitAt = (wps: number) => animatedNarrationFit({ ...narration(wps), intent: "action", sceneEnergy: [...ENERGY] });

test("ritmo típico (2,5 palabras/s): cabe; total 24,5 s < 25 → desacelera hasta el suelo 0,9 sin dejar de caber", () => {
  const fit = fitAt(2.5);
  assert.equal(fit.fits, true);
  assert.equal(fit.totalSeconds, 24.5);
  assert.ok(Math.max(...fit.neededSeconds) < 8);
  const speed = fitSpeedAdjustment(fit, { minTotalSeconds: 25, targetTotalSeconds: 28 });
  assert.equal(speed, FIT_SPEED_RANGE.min);
  // Con esa velocidad (duraciones ×1/0,9) cada escena sigue cabiendo en el clip.
  const slowed = fitAt(2.5 * 0.9);
  assert.equal(slowed.fits, true);
  assert.ok(slowed.totalSeconds >= 25 && slowed.totalSeconds <= 28);
});

test("ritmo pausado (2,1 palabras/s): total ≥ 25 s y todo cabe → sin ajuste", () => {
  const fit = fitAt(2.1);
  assert.equal(fit.fits, true);
  assert.equal(fitSpeedAdjustment(fit, { minTotalSeconds: 25, targetTotalSeconds: 28 }), null);
});

test("ritmo lento (1,8 palabras/s): una escena supera el clip → acelera lo justo, dentro del rango, y entonces cabe", () => {
  const fit = fitAt(1.8);
  assert.equal(fit.fits, false);
  assert.ok(fit.tooLong.length > 0);
  const speed = fitSpeedAdjustment(fit, { minTotalSeconds: 25, targetTotalSeconds: 28 });
  assert.ok(speed !== null && speed > 1 && speed <= FIT_SPEED_RANGE.max);
  // La cola final (0,5 s) no se acelera: el margen FIT_SAFETY_SECONDS la absorbe.
  const sped = fitAt(1.8 * speed!);
  assert.equal(sped.fits, true);
  assert.ok(Math.max(...sped.neededSeconds) <= 8 - FIT_SAFETY_SECONDS + 0.1);
});

test("demasiado lento (1,5 palabras/s): el ajuste necesario supera ×1,15 → se detiene antes de pagar", () => {
  assert.throws(() => fitSpeedAdjustment(fitAt(1.5), { minTotalSeconds: 25, targetTotalSeconds: 28 }), /supera el máximo.*Detenido antes de pagar/);
});

test("escena demasiado corta para su acción: se detiene (no se corrige con la velocidad)", () => {
  // La escena 3 (energía baja, necesita 2,8 s visibles) con solo 3 palabras (1,2 s).
  const fit = animatedNarrationFit({ ...narration(2.5, [15, 15, 3, 15]), intent: "action", sceneEnergy: [...ENERGY] });
  assert.deepEqual(fit.tooShort, [2]);
  assert.throws(() => fitSpeedAdjustment(fit, { minTotalSeconds: 25, targetTotalSeconds: 28 }), /demasiado cortas/);
});
