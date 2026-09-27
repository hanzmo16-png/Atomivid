import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { framingStyle, reelMotionTransform, vignetteBackground, type ReelMotion } from "./reel-motion";
import { musicVolumeAtSeconds, AUDIO_MIX } from "./audio-mix";

const MOTIONS: ReelMotion[] = ["hook", "push_in", "push_in_slow", "pull_out", "pan_left", "pan_right", "punch_in", "hold"];

test("ningún movimiento deja bordes negros: con paneo la sobre-escala cubre el desplazamiento", () => {
  for (const m of MOTIONS) {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const { scale, translateX } = reelMotionTransform(m, p);
      assert.ok(scale >= 1, `${m}@${p}`);
      const overscanPx = ((scale - 1) * 1080) / 2;
      assert.ok(Math.abs(translateX) <= overscanPx + 1e-9, `${m}@${p}: ${translateX}px con ${overscanPx}px de margen`);
    }
  }
});

test("revelación: el impulso ocurre al principio del plano; acercamiento lento es más suave que el normal", () => {
  assert.ok(reelMotionTransform("punch_in", 0).scale > reelMotionTransform("punch_in", 0.3).scale);
  assert.equal(reelMotionTransform("punch_in", 0.3).scale, reelMotionTransform("punch_in", 1).scale);
  assert.ok(reelMotionTransform("push_in_slow", 1).scale < reelMotionTransform("push_in", 1).scale);
});

test("encuadre y viñeta: ausentes no cambian nada", () => {
  assert.deepEqual(framingStyle(undefined), { baseScale: 1 });
  assert.equal(vignetteBackground(0), undefined);
  assert.match(vignetteBackground(0.6)!, /radial-gradient/);
});

test("mezcla dirigida: nunca sube la música por encima de la mezcla estándar; sin niveles es idéntica", () => {
  const gaps = [{ startSeconds: 5, endSeconds: 7 }];
  for (const t of [0.5, 3, 6, 9]) {
    assert.equal(musicVolumeAtSeconds(t, 20, gaps), musicVolumeAtSeconds(t, 20, gaps, undefined));
    assert.ok(musicVolumeAtSeconds(t, 20, gaps, { underVoice: 5, duringSilence: 9 }) <= musicVolumeAtSeconds(t, 20, gaps) + 1e-12);
  }
  assert.ok(musicVolumeAtSeconds(6, 20, gaps, { duringSilence: 0.22 }) < AUDIO_MIX.MUSIC_VOLUME_DURING_SILENCE);
});

test("VerticalReel: sin campos dirigidos conserva el Ken Burns y el fundido de siempre (solicitudes antiguas)", () => {
  const src = readFileSync(path.join(__dirname, "VerticalReel.tsx"), "utf8");
  assert.match(src, /const fadeIn = isFirst \? 0 : \(scene\.transitionInFrames \?\? FADE_FRAMES\);/);
  assert.match(src, /const nextFade = isLast \? 0 : \(scenes\[i \+ 1\]\.transitionInFrames \?\? FADE_FRAMES\);/);
  assert.match(src, /const directed = scene\.motion \? reelMotionTransform\(scene\.motion, progress\) : null;/);
  assert.match(src, /interpolate\(progress, \[0, 1\], \[1, 1\.12\]\)/);
});
