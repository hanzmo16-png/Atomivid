import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVisualAssetBuffer } from "./visual-asset-validation";

const PADDING = Buffer.alloc(200, 0x20);

function buildPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.write("\x89PNG\r\n\x1a\n", 0, "ascii");
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, PADDING]);
}

function buildSvg(): Buffer {
  return Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1080' height='1920'></svg>");
}

test("acepta un PNG válido con dimensiones dentro de rango", () => {
  const result = validateVisualAssetBuffer(buildPng(1024, 1536), "image/png");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.format, "png");
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1536);
  }
});

test("acepta un SVG válido (salida del fixture, sin verificar dimensiones)", () => {
  const result = validateVisualAssetBuffer(buildSvg(), "image/svg+xml");
  assert.equal(result.valid, true);
});

test("rechaza un MIME no permitido", () => {
  const result = validateVisualAssetBuffer(buildPng(1024, 1536), "application/octet-stream");
  assert.equal(result.valid, false);
});

test("rechaza un buffer vacío", () => {
  const result = validateVisualAssetBuffer(Buffer.alloc(0), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza un PNG cuyo contenido real no coincide con el MIME declarado", () => {
  const result = validateVisualAssetBuffer(buildSvg(), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza dimensiones fuera de rango (muy pequeña o muy grande)", () => {
  assert.equal(validateVisualAssetBuffer(buildPng(50, 50), "image/png").valid, false);
  assert.equal(validateVisualAssetBuffer(buildPng(9000, 9000), "image/png").valid, false);
});

test("rechaza un buffer demasiado grande", () => {
  const huge = Buffer.concat([buildPng(1024, 1536), Buffer.alloc(11 * 1024 * 1024)]);
  const result = validateVisualAssetBuffer(huge, "image/png");
  assert.equal(result.valid, false);
});
