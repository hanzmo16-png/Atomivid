import assert from "node:assert/strict";
import test from "node:test";

import { validateAudioBuffer } from "./validate";
import { generateToneWav } from "../wav";

test("acepta un WAV real generado por generateToneWav", () => {
  const buffer = generateToneWav({ durationSeconds: 1 });
  const result = validateAudioBuffer(buffer);
  assert.equal(result.valid, true);
  assert.ok(result.valid && result.format === "wav");
  assert.ok(result.valid && result.sampleRate === 44100);
  assert.ok(result.valid && result.channels === 1);
});

test("rechaza un archivo demasiado pequeño", () => {
  const result = validateAudioBuffer(Buffer.from("hola"));
  assert.equal(result.valid, false);
});

test("rechaza una respuesta HTML guardada como si fuera audio (fallo común de descarga)", () => {
  const html = Buffer.from(`<!DOCTYPE html><html><body>${"x".repeat(3000)}</body></html>`);
  const result = validateAudioBuffer(html);
  assert.equal(result.valid, false);
});

test("reconoce un MP3 por su tag ID3", () => {
  const fakeMp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3000, 1)]);
  const result = validateAudioBuffer(fakeMp3);
  assert.equal(result.valid, true);
  assert.ok(result.valid && result.format === "mp3");
});

test("reconoce un MP3 por su frame sync sin tag ID3", () => {
  const fakeMp3 = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(3000, 1)]);
  const result = validateAudioBuffer(fakeMp3);
  assert.equal(result.valid, true);
  assert.ok(result.valid && result.format === "mp3");
});

test("reconoce un OGG por su magic bytes", () => {
  const fakeOgg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(3000, 1)]);
  const result = validateAudioBuffer(fakeOgg);
  assert.equal(result.valid, true);
  assert.ok(result.valid && result.format === "ogg");
});
