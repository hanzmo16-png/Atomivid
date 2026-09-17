import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoBeats, MIN_BEAT_SECONDS, MAX_BEAT_SECONDS } from "./scene-beats";

test("una escena corta (dentro del máximo) no se divide", () => {
  const beats = splitIntoBeats(0, 3);
  assert.deepEqual(beats, [{ start: 0, end: 3 }]);
});

test("una escena justo en el máximo no se divide", () => {
  const beats = splitIntoBeats(0, MAX_BEAT_SECONDS);
  assert.equal(beats.length, 1);
});

test("una escena larga se divide en varios beats dentro de los límites", () => {
  const beats = splitIntoBeats(10, 20); // 10s
  assert.ok(beats.length >= 2, `esperaba al menos 2 beats, dio ${beats.length}`);
  for (const beat of beats) {
    const duration = beat.end - beat.start;
    assert.ok(
      duration >= MIN_BEAT_SECONDS - 0.01 && duration <= MAX_BEAT_SECONDS + 0.01,
      `beat de ${duration}s fuera de [${MIN_BEAT_SECONDS}, ${MAX_BEAT_SECONDS}]`,
    );
  }
});

test("los beats son contiguos y cubren todo el rango exactamente", () => {
  const beats = splitIntoBeats(5, 17.5);
  assert.equal(beats[0].start, 5);
  assert.equal(beats[beats.length - 1].end, 17.5);
  for (let i = 1; i < beats.length; i++) {
    assert.equal(beats[i - 1].end, beats[i].start);
  }
});

test("un rango que dividido en partes iguales bajaría del mínimo usa menos beats en vez de violar el piso", () => {
  // 4.5s: dividir en 2 daría 2.25s cada uno (>= MIN_BEAT_SECONDS=1.8, ok),
  // pero un caso más ajustado (ej. justo arriba del máximo) debe preferir
  // un solo beat en vez de dos por debajo del mínimo.
  const beats = splitIntoBeats(0, MAX_BEAT_SECONDS + 0.3);
  for (const beat of beats) {
    assert.ok(beat.end - beat.start >= MIN_BEAT_SECONDS - 0.01);
  }
});

test("un rango de duración cero produce un solo beat sin longitud negativa", () => {
  const beats = splitIntoBeats(5, 5);
  assert.deepEqual(beats, [{ start: 5, end: 5 }]);
});
