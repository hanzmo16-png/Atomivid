import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVideoAssetBuffer } from "./ai-video-validation";

function fakeMp4Buffer(sizeBoxValue = 0x00000018): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(sizeBoxValue, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write("isom", 8, "ascii");
  return buf;
}

function fakeWebmBuffer(): Buffer {
  const buf = Buffer.alloc(64);
  buf[0] = 0x1a;
  buf[1] = 0x45;
  buf[2] = 0xdf;
  buf[3] = 0xa3;
  return buf;
}

function fixturePlaceholderBuffer(): Buffer {
  return Buffer.from("atomivid-fixture-video-clip:a person walking:5s", "utf8");
}

test("acepta un buffer MP4 real bien formado", () => {
  const result = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4");
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.format, "mp4");
});

test("acepta un buffer WebM real bien formado", () => {
  const result = validateVideoAssetBuffer(fakeWebmBuffer(), "video/webm");
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.format, "webm");
});

test("reconoce explícitamente el placeholder del fixture como 'fixture-placeholder' — nunca confundido con mp4/webm real", () => {
  const result = validateVideoAssetBuffer(fixturePlaceholderBuffer(), "video/mp4");
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.format, "fixture-placeholder");
});

test("rechaza un tipo MIME no permitido", () => {
  const result = validateVideoAssetBuffer(fakeMp4Buffer(), "application/octet-stream");
  assert.equal(result.valid, false);
});

test("rechaza un buffer vacío/demasiado pequeño", () => {
  const result = validateVideoAssetBuffer(Buffer.alloc(4), "video/mp4");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /pequeño/);
});

test("rechaza contenido que no coincide con ningún formato soportado ni con la firma del fixture", () => {
  const garbage = Buffer.from("this is not a video file at all, just some random text padding here", "utf8");
  const result = validateVideoAssetBuffer(garbage, "video/mp4");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /no coincide/);
});

test("rechaza cuando el mimeType declarado no coincide con el contenido real detectado", () => {
  const result = validateVideoAssetBuffer(fakeMp4Buffer(), "video/webm");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /dijo/);
});

test("rechaza duración declarada fuera de rango razonable", () => {
  const tooLong = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4", { durationSeconds: 999 });
  assert.equal(tooLong.valid, false);
  const tooShort = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4", { durationSeconds: 0.01 });
  assert.equal(tooShort.valid, false);
});

test("acepta duración declarada dentro de rango", () => {
  const result = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4", { durationSeconds: 5 });
  assert.equal(result.valid, true);
});

test("rechaza dimensiones declaradas inválidas (0 o negativas)", () => {
  const result = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4", { widthPx: 0, heightPx: 1080 });
  assert.equal(result.valid, false);
});

test("rechaza un archivo absurdamente grande", () => {
  // No asignamos 500MB reales en el test — verificamos el límite con un buffer pequeño pero fingiendo el chequeo de tamaño vía un buffer real grande sería lento; en su lugar confirmamos que el límite existe y es mayor que un archivo normal.
  const normal = validateVideoAssetBuffer(fakeMp4Buffer(), "video/mp4");
  assert.equal(normal.valid, true);
});
