import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_MIX,
  computeNarrationGaps,
  musicVolumeAtSeconds,
  voiceVolumeAtSeconds,
} from "./audio-mix";

test("computeNarrationGaps ignora micro-pausas por debajo del umbral", () => {
  const words = [
    { startSeconds: 0, endSeconds: 0.5 },
    { startSeconds: 0.55, endSeconds: 1.0 }, // gap de 0.05s, no cuenta
  ];
  assert.deepEqual(computeNarrationGaps(words), []);
});

test("computeNarrationGaps detecta un silencio real", () => {
  const words = [
    { startSeconds: 0, endSeconds: 0.5 },
    { startSeconds: 2.0, endSeconds: 2.5 }, // gap de 1.5s
  ];
  const gaps = computeNarrationGaps(words);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].startSeconds, 0.5);
  assert.equal(gaps[0].endSeconds, 2.0);
});

test("voiceVolumeAtSeconds es dominante en el cuerpo del video", () => {
  const v = voiceVolumeAtSeconds(5, 30);
  assert.equal(v, AUDIO_MIX.VOICE_VOLUME);
});

test("voiceVolumeAtSeconds hace fade en los bordes absolutos, no en medio", () => {
  const start = voiceVolumeAtSeconds(0, 30);
  const end = voiceVolumeAtSeconds(30, 30);
  assert.equal(start, 0);
  assert.equal(end, 0);
  assert.ok(voiceVolumeAtSeconds(1, 30) > 0.9 * AUDIO_MIX.VOICE_VOLUME);
});

test("musicVolumeAtSeconds queda bajo la voz cuando no hay silencios", () => {
  const v = musicVolumeAtSeconds(10, 30, []);
  assert.equal(v, AUDIO_MIX.MUSIC_VOLUME_UNDER_VOICE);
});

test("musicVolumeAtSeconds sube durante un silencio de narración", () => {
  const gaps = [{ startSeconds: 5, endSeconds: 8 }];
  const midGap = musicVolumeAtSeconds(6.5, 30, gaps); // centro del gap, lejos de los bordes
  assert.ok(
    midGap > AUDIO_MIX.MUSIC_VOLUME_UNDER_VOICE,
    "se esperaba que la música suba durante el silencio",
  );
  assert.ok(midGap <= AUDIO_MIX.MUSIC_VOLUME_DURING_SILENCE + 1e-9);
});

test("musicVolumeAtSeconds nunca salta bruscamente al entrar/salir de un silencio", () => {
  const gaps = [{ startSeconds: 5, endSeconds: 8 }];
  const before = musicVolumeAtSeconds(4.9, 30, gaps);
  const justInside = musicVolumeAtSeconds(5.1, 30, gaps);
  // La diferencia entre un instante justo antes y justo después del borde
  // debe ser pequeña (transición suave), no un salto del nivel completo.
  const fullSwing = AUDIO_MIX.MUSIC_VOLUME_DURING_SILENCE - AUDIO_MIX.MUSIC_VOLUME_UNDER_VOICE;
  assert.ok(Math.abs(justInside - before) < fullSwing * 0.5);
});

test("musicVolumeAtSeconds hace fade-in/out en los bordes del video completo", () => {
  const start = musicVolumeAtSeconds(0, 30, []);
  const end = musicVolumeAtSeconds(30, 30, []);
  assert.equal(start, 0);
  assert.equal(end, 0);
});

test("los niveles de música nunca exceden el nivel de voz (protección contra clipping)", () => {
  const gaps = [{ startSeconds: 5, endSeconds: 8 }];
  for (let t = 0; t <= 30; t += 0.5) {
    const musicLevel = musicVolumeAtSeconds(t, 30, gaps);
    assert.ok(musicLevel <= AUDIO_MIX.VOICE_VOLUME);
  }
});
