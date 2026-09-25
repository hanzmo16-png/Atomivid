import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AVATAR_PHOTO_BYTES, MAX_RECORDING_BYTES, recordingFormat } from "./recording";

/**
 * Regresión del QA blocker real (2026-09-25, Android/Samsung): un límite
 * combinado foto+audio <= 3 MB (MAX_AVATAR_FORM_BYTES, ya eliminado)
 * rechazaba una grabación real de ~45s recién terminada. Estos tests
 * fijan que los límites son ahora INDEPENDIENTES y realistas para audio
 * móvil sin comprimir hasta ~90s.
 */

test("MAX_AVATAR_PHOTO_BYTES y MAX_RECORDING_BYTES son límites independientes — ninguno depende del otro", () => {
  assert.equal(MAX_AVATAR_PHOTO_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_RECORDING_BYTES, 16 * 1024 * 1024);
  // Una foto grande (7 MB) y un audio grande (15 MB) caben cada uno por
  // separado, aunque combinados (22 MB) hubieran excedido el límite
  // combinado histórico de 3 MB por un margen enorme — nunca se suman.
  assert.ok(7 * 1024 * 1024 < MAX_AVATAR_PHOTO_BYTES);
  assert.ok(15 * 1024 * 1024 < MAX_RECORDING_BYTES);
});

test("MAX_RECORDING_BYTES cubre una grabación WAV sin comprimir de ~60-90s (44.1kHz/16-bit/stereo)", () => {
  const wavBytesFor = (seconds: number) => seconds * 44100 * 2 * 2;
  assert.ok(wavBytesFor(60) < MAX_RECORDING_BYTES, "60s de WAV debe caber");
  assert.ok(wavBytesFor(90) < MAX_RECORDING_BYTES, "90s de WAV (objetivo ideal de la misión) debe caber");
});

test("recordingFormat menciona el límite real (en MB) en su mensaje de error, no un '3 MB' obsoleto", () => {
  assert.throws(
    () => recordingFormat(new Uint8Array(0)),
    (err: unknown) => err instanceof Error && err.message.includes(`${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB`),
  );
});

test("recordingFormat sigue reconociendo WAV/M4A/MP3 sin cambios de comportamiento", () => {
  const wav = new Uint8Array(44);
  wav.set(Buffer.from("RIFF"), 0);
  wav.set(Buffer.from("WAVE"), 8);
  assert.equal(recordingFormat(wav).extension, "wav");

  const m4a = new Uint8Array(12);
  m4a.set(Buffer.from("ftyp"), 4);
  m4a.set(Buffer.from("M4A "), 8);
  assert.equal(recordingFormat(m4a).extension, "m4a");

  const mp3 = new Uint8Array(4);
  mp3.set(Buffer.from("ID3"), 0);
  assert.equal(recordingFormat(mp3).extension, "mp3");
});
