import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePhotoBuffer } from "./photo-validation";

// El validador exige un mínimo de 4096 bytes para considerar que algo
// "parece una foto real" — los fixtures se rellenan con datos de más
// para superar ese umbral, igual que un archivo real lo haría.
const PADDING = Buffer.alloc(5000, 0xaa);

function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from("IHDR", "ascii");
  const w = Buffer.alloc(4);
  w.writeUInt32BE(width, 0);
  const h = Buffer.alloc(4);
  h.writeUInt32BE(height, 0);
  const rest = Buffer.from([8, 6, 0, 0, 0]); // bit depth, color type, compression, filter, interlace
  const crc = Buffer.alloc(4); // no se verifica
  return Buffer.concat([signature, length, type, w, h, rest, crc, PADDING]);
}

function buildJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.from([0xff, 0xc0]);
  const length = Buffer.from([0x00, 0x0b]); // 11 bytes tras el marcador
  const precision = Buffer.from([0x08]);
  const h = Buffer.alloc(2);
  h.writeUInt16BE(height, 0);
  const w = Buffer.alloc(2);
  w.writeUInt16BE(width, 0);
  const numComponents = Buffer.from([0x01]);
  return Buffer.concat([soi, sof, length, precision, h, w, numComponents, PADDING]);
}

test("acepta un PNG válido dentro del rango de dimensiones", () => {
  const result = validatePhotoBuffer(buildPng(1024, 1024), "image/png");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.format, "png");
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1024);
  }
});

test("acepta un JPEG válido dentro del rango de dimensiones", () => {
  const result = validatePhotoBuffer(buildJpeg(800, 1200), "image/jpeg");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.format, "jpeg");
    assert.equal(result.width, 800);
    assert.equal(result.height, 1200);
  }
});

test("rechaza un PNG demasiado pequeño en dimensiones (< 200px)", () => {
  const result = validatePhotoBuffer(buildPng(50, 50), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza un PNG con dimensiones absurdamente grandes", () => {
  const result = validatePhotoBuffer(buildPng(20000, 20000), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza un tipo MIME no permitido (p. ej. svg)", () => {
  const result = validatePhotoBuffer(buildPng(1024, 1024), "image/svg+xml");
  assert.equal(result.valid, false);
});

test("rechaza cuando el Content-Type declarado NO coincide con los bytes reales (archivo disfrazado)", () => {
  // Bytes reales de PNG, pero declarado como JPEG — debe rechazarse
  // aunque el tipo MIME declarado esté en la lista permitida.
  const result = validatePhotoBuffer(buildPng(1024, 1024), "image/jpeg");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /pero su contenido real es/);
});

test("rechaza un archivo demasiado pequeño para ser una foto real", () => {
  const result = validatePhotoBuffer(Buffer.from("no soy una foto"), "image/jpeg");
  assert.equal(result.valid, false);
});

test("rechaza contenido que no coincide con ningún formato soportado", () => {
  const result = validatePhotoBuffer(Buffer.alloc(5000, 0x00), "image/jpeg");
  assert.equal(result.valid, false);
});

test("rechaza un archivo por encima del tamaño máximo (10 MB)", () => {
  const oversized = Buffer.concat([buildJpeg(800, 1200), Buffer.alloc(11 * 1024 * 1024, 0)]);
  const result = validatePhotoBuffer(oversized, "image/jpeg");
  assert.equal(result.valid, false);
});
