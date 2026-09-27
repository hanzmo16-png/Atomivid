import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_SHOT_SECONDS,
  coverScenes,
  minimumClipSeconds,
  mixLevelsFor,
  planReelMontage,
  revealScenes,
  splitSceneIntoShots,
  validateTimeline,
  type WordTime,
} from "./montage";
import type { SceneEnergy } from "./direction";

/** Palabras sintéticas de 0.35 s con 0.1 s entre ellas y un silencio de 0.9 s entre escenas. */
function fakeVoice(sceneWordCounts: number[]) {
  const words: WordTime[] = [];
  const timings: { start: number; end: number }[] = [];
  let t = 0.12;
  for (const count of sceneWordCounts) {
    const start = t;
    for (let i = 0; i < count; i++) {
      words.push({ startSeconds: t, endSeconds: t + 0.35 });
      t += 0.45;
    }
    timings.push({ start, end: t - 0.1 });
    t += 0.9;
  }
  return { words, timings, voiceEnd: t };
}

const plan = (intent: Parameters<typeof planReelMontage>[0]["intent"], pace: Parameters<typeof planReelMontage>[0]["pace"], energy: SceneEnergy[], counts: number[]) => {
  const v = fakeVoice(counts);
  const total = v.voiceEnd + 1.5;
  return { shots: planReelMontage({ intent, pace, sceneEnergy: energy, sceneTimings: v.timings, words: v.words, totalSeconds: total }), total, words: v.words };
};

test("aceptación 4: el montaje cubre exactamente el audio (sin huecos ni solapes, de 0 al final)", () => {
  for (const intent of ["suspense", "humor", "uplifting", "informative", "reflective", "action"] as const) {
    for (const pace of ["slow", "balanced", "dynamic"] as const) {
      const { shots, total } = plan(intent, pace, ["low", "medium", "high", "low", "high"], [14, 9, 20, 5, 12]);
      assert.deepEqual(validateTimeline(shots, total), [], `${intent}/${pace}`);
      assert.ok(shots.every((s) => s.endSeconds - s.startSeconds >= MIN_SHOT_SECONDS - 1e-9));
    }
  }
});

test("los silencios entre escenas se cubren con la escena anterior (antes quedaban fotogramas negros)", () => {
  const covered = coverScenes([{ start: 0.2, end: 2 }, { start: 2.9, end: 5 }], 6.5);
  assert.deepEqual(covered, [{ start: 0, end: 2.9 }, { start: 2.9, end: 6.5 }]);
  assert.deepEqual(validateTimeline([{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 2.9, endSeconds: 6.5 }], 6.5).map((i) => i.code), ["gap"]);
});

test("los cortes internos caen en el hueco entre dos palabras, no a mitad de palabra", () => {
  const v = fakeVoice([30]);
  const parts = splitSceneIntoShots(0, v.timings[0].end, { min: 1.8, max: 3.8 }, v.words);
  assert.ok(parts.length > 1);
  for (const cut of parts.slice(1).map((p) => p.start)) {
    const insideWord = v.words.some((w) => cut > w.startSeconds + 1e-9 && cut < w.endSeconds - 1e-9);
    assert.equal(insideWord, false, `corte en ${cut} dentro de una palabra`);
  }
});

test("suspenso = anticipación y revelación: plano sostenido con acercamiento lento y revelación por corte seco", () => {
  const energy: SceneEnergy[] = ["low", "low", "medium", "high"];
  assert.deepEqual([...revealScenes(energy)], [3]);
  const { shots } = plan("suspense", "slow", energy, [10, 10, 10, 8]);
  const reveal = shots.find((s) => s.role === "reveal")!;
  assert.equal(reveal.sceneIndex, 3);
  assert.equal(reveal.transitionInFrames, 0, "la revelación entra por corte seco");
  assert.equal(reveal.motion, "punch_in");
  const anticipation = shots.find((s) => s.role === "anticipation")!;
  assert.equal(anticipation.sceneIndex, 2);
  assert.equal(anticipation.motion, "push_in_slow");
  // No todo es lento: la revelación dura menos que el plano de anticipación.
  assert.ok(reveal.endSeconds - reveal.startSeconds < anticipation.endSeconds - anticipation.startSeconds);
});

test("el ritmo cambia con la intención: humor corta más seguido que suspenso con el mismo audio", () => {
  const energy: SceneEnergy[] = ["medium", "medium", "medium", "medium"];
  const suspense = plan("suspense", "slow", energy, [16, 16, 16, 16]).shots;
  const humor = plan("humor", "dynamic", energy, [16, 16, 16, 16]).shots;
  assert.ok(humor.length > suspense.length, `${humor.length} vs ${suspense.length}`);
  const avgFade = (xs: typeof humor) => xs.reduce((n, s) => n + s.transitionInFrames, 0) / xs.length;
  assert.ok(avgFade(humor) < avgFade(suspense));
});

test("una escena de una palabra no produce un plano de medio segundo", () => {
  const { shots, total } = plan("informative", "balanced", ["medium", "medium", "medium"], [10, 1, 10]);
  assert.deepEqual(validateTimeline(shots, total), []);
});

test("clip mínimo = plano + fundido del siguiente + margen (evita congelados)", () => {
  const { shots } = plan("reflective", "slow", ["low", "low"], [12, 12]);
  const expected = shots[0].endSeconds - shots[0].startSeconds + shots[1].transitionInFrames / 30 + 0.3;
  assert.ok(Math.abs(minimumClipSeconds(shots, 0) - expected) < 1e-9);
});

test("mezcla: suspenso sube menos la música en silencios; otras intenciones usan la mezcla de siempre", () => {
  assert.ok((mixLevelsFor("suspense")?.duringSilence ?? 1) < 0.35);
  assert.equal(mixLevelsFor("informative"), undefined);
});
