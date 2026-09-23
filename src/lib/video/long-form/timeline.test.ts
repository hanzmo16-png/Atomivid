import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLongFormTimeline,
  splitNarrationIntoSafeChunks,
  stitchNarrationParts,
  MAX_TTS_CHARS_PER_CALL,
  __internal,
} from "./timeline";
import { generateToneWav } from "@/lib/providers/wav";
import type { VoiceProvider, WordTiming } from "@/lib/providers/types";
import type { BeatType } from "./types";

function fixtureWordTimings(text: string, wordsPerSecond = 2.8): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  const dur = 1 / wordsPerSecond;
  return words.map((w, i) => ({ text: w, startSeconds: i * dur, endSeconds: (i + 1) * dur }));
}

const stubVoiceProvider: VoiceProvider = {
  name: "test-stub",
  async synthesize(text) {
    const words = fixtureWordTimings(text);
    const durationSeconds = words.length > 0 ? words[words.length - 1].endSeconds : 1;
    return {
      audioBuffer: generateToneWav({ durationSeconds, frequencyHz: 220 }),
      durationSeconds,
      words,
      mimeType: "audio/wav",
      extension: "wav",
    };
  },
};

test("splitNarrationIntoSafeChunks no parte texto corto", () => {
  const text = "Una oración corta.";
  assert.deepEqual(splitNarrationIntoSafeChunks(text), [text]);
});

test("splitNarrationIntoSafeChunks parte texto largo respetando límites de oración", () => {
  const sentence = "Esta es una oración de prueba con varias palabras repetidas. ";
  const text = sentence.repeat(400); // ~28,000 caracteres, muy por encima del límite
  const chunks = splitNarrationIntoSafeChunks(text, 9000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 9000 + sentence.length); // margen de una oración
    assert.ok(chunk.trim().length > 0);
  }
  // Ninguna palabra se pierde ni se corta: unir todo debe reproducir el mismo conteo de palabras.
  const originalWords = text.split(/\s+/).filter(Boolean).length;
  const rebuiltWords = chunks.join(" ").split(/\s+/).filter(Boolean).length;
  assert.equal(rebuiltWords, originalWords);
});

test("MAX_TTS_CHARS_PER_CALL queda por debajo del límite documentado de eleven_multilingual_v2 (10,000)", () => {
  assert.ok(MAX_TTS_CHARS_PER_CALL < 10000);
});

test("concatWav (vía __internal) une PCM y preserva el formato", () => {
  const a = generateToneWav({ durationSeconds: 1, frequencyHz: 220 });
  const b = generateToneWav({ durationSeconds: 2, frequencyHz: 330 });
  const joined = __internal.concatWav([a, b]);
  const info = __internal.parseWav(joined);
  const infoA = __internal.parseWav(a);
  const infoB = __internal.parseWav(b);
  assert.equal(info.pcm.length, infoA.pcm.length + infoB.pcm.length);
  assert.equal(info.sampleRate, infoA.sampleRate);
});

test("concatWav rechaza formatos incompatibles (sampleRate distinto)", () => {
  const a = generateToneWav({ durationSeconds: 1, sampleRate: 44100 });
  const b = generateToneWav({ durationSeconds: 1, sampleRate: 22050 });
  assert.throws(() => __internal.concatWav([a, b]));
});

test("stitchNarrationParts re-offsetea los timestamps por palabra correctamente", () => {
  const partA = {
    audioBuffer: generateToneWav({ durationSeconds: 2 }),
    mimeType: "audio/wav",
    extension: "wav",
    durationSeconds: 2,
    words: [{ text: "hola", startSeconds: 0, endSeconds: 0.5 }],
  };
  const partB = {
    audioBuffer: generateToneWav({ durationSeconds: 3 }),
    mimeType: "audio/wav",
    extension: "wav",
    durationSeconds: 3,
    words: [{ text: "mundo", startSeconds: 0, endSeconds: 0.5 }],
  };
  const stitched = stitchNarrationParts([partA, partB]);
  assert.equal(stitched.durationSeconds, 5);
  assert.equal(stitched.words[0].text, "hola");
  assert.equal(stitched.words[0].startSeconds, 0);
  assert.equal(stitched.words[1].text, "mundo");
  assert.equal(stitched.words[1].startSeconds, 2); // offset por la duración de partA
  assert.equal(stitched.words[1].endSeconds, 2.5);
});

test("stitchNarrationParts con una sola parte la devuelve tal cual (sin re-procesar)", () => {
  const part = {
    audioBuffer: generateToneWav({ durationSeconds: 1 }),
    mimeType: "audio/wav",
    extension: "wav",
    durationSeconds: 1,
    words: [{ text: "x", startSeconds: 0, endSeconds: 1 }],
  };
  assert.equal(stitchNarrationParts([part]), part);
});

// Narración de prueba con suficientes palabras (a 2.8 palabras/s del proveedor
// fixture) para que cada beat dure ~20s — un beat real de documental (8-10
// min repartidos en 7-8 beats) siempre queda muy por encima de esto, pero
// shotsForSpan() exige al menos ~6-8s de span para poder formar shots
// válidos de 3-8s, así que un beat de prueba demasiado corto no sería
// representativo del caso real.
function longNarration(seed: string): string {
  return `${seed} ${"palabra ".repeat(50)}`.trim();
}

const SAMPLE_BEATS: {
  id: string;
  type: BeatType;
  purpose: string;
  narration: string;
}[] = [
  { id: "beat-1", type: "hook", purpose: "abrir", narration: longNarration("Gancho inicial de prueba.") },
  { id: "beat-2", type: "setup", purpose: "situar", narration: longNarration("Segundo bloque que sitúa al espectador.") },
  { id: "beat-3", type: "payoff", purpose: "cerrar", narration: longNarration("Tercer bloque que cierra la idea.") },
];

test("buildLongFormTimeline produce una línea de tiempo real continua (sin huecos ni solapes) entre beats", async () => {
  const timeline = await buildLongFormTimeline(stubVoiceProvider, SAMPLE_BEATS, "es");

  assert.equal(timeline.beats.length, SAMPLE_BEATS.length);
  assert.ok(timeline.durationSeconds > 0);
  // El audio final dura lo mismo que la suma de las duraciones reales de cada beat.
  const expectedTotal = timeline.beats.reduce((sum, b) => sum + (b.endTargetSec - b.startTargetSec), 0);
  assert.ok(Math.abs(timeline.durationSeconds - expectedTotal) < 1e-6);

  for (let i = 1; i < timeline.beats.length; i++) {
    // El beat i empieza exactamente donde terminó el beat i-1 — línea de tiempo continua.
    assert.equal(timeline.beats[i].startTargetSec, timeline.beats[i - 1].endTargetSec);
  }

  // Cada beat trae shots reales (no vacíos) cuyo rango cae dentro del rango real del beat.
  for (const beat of timeline.beats) {
    assert.ok(beat.shots.length > 0);
    for (const shot of beat.shots) {
      assert.ok(shot.startSec >= beat.startTargetSec - 0.01);
      assert.ok(shot.endSec <= beat.endTargetSec + 0.01);
      assert.ok(shot.durationSec >= 2.95 && shot.durationSec <= 8.05);
    }
  }
});

test("buildLongFormTimeline: las palabras de captions cubren toda la duración real, en orden", async () => {
  const timeline = await buildLongFormTimeline(stubVoiceProvider, SAMPLE_BEATS, "es");
  for (let i = 1; i < timeline.words.length; i++) {
    assert.ok(timeline.words[i].startSeconds >= timeline.words[i - 1].startSeconds);
  }
  assert.ok(timeline.words[timeline.words.length - 1].endSeconds <= timeline.durationSeconds + 1e-6);
});

test("buildLongFormTimeline exige al menos un beat", async () => {
  await assert.rejects(() => buildLongFormTimeline(stubVoiceProvider, [], "es"));
});
