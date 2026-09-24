import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateReferenceImageBuffer,
  computeReferenceImageChecksumSha256,
  referenceImageStoragePath,
  ingestApprovedReferenceImage,
  ReferenceImageInvalidError,
  REFERENCE_IMAGE_STORAGE_BUCKET,
} from "./ai-video-reference-image";

/** 1100 bytes (> MIN_BYTES=1024) con relleno — solo importan los encabezados en offsets fijos, el resto es padding inerte para pasar el chequeo de tamaño mínimo. */
function fakePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(1100);
  buf.write("89504e470d0a1a0a", 0, "hex");
  buf.writeUInt32BE(13, 8); // longitud del chunk IHDR
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeJpegBuffer(width: number, height: number): Buffer {
  // SOI + APP0 corto + SOF0 con height/width en offset fijo, con relleno para pasar MIN_BYTES.
  const buf = Buffer.alloc(1100);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf.writeUInt16BE(16, 4); // longitud del segmento APP0
  buf.write("JFIF\0", 6, "ascii");
  const sofOffset = 4 + 16;
  buf[sofOffset] = 0xff;
  buf[sofOffset + 1] = 0xc0; // SOF0
  buf.writeUInt16BE(8, sofOffset + 2); // longitud del segmento SOF0 (no relevante aquí)
  buf[sofOffset + 4] = 8; // precisión
  buf.writeUInt16BE(height, sofOffset + 5);
  buf.writeUInt16BE(width, sofOffset + 7);
  return buf;
}

function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const uploadCalls: string[] = [];
  const fake = {
    storage: {
      from() {
        return {
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            uploadCalls.push(path);
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files, uploadCalls };
}

test("valida el PNG real aprobado de Pillar Transport: 16:9 (con tolerancia), formato correcto, íntegro", () => {
  const imagePath = join(__dirname, "..", "..", "..", "..", "content/long-form/gobekli-tepe-001/reference-images/bench-v2-a-pillar-transport.png");
  const buffer = readFileSync(imagePath);
  const result = validateReferenceImageBuffer(buffer, "image/png");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.format, "png");
    assert.equal(result.widthPx, 1672);
    assert.equal(result.heightPx, 941);
    assert.ok(result.aspectRatioDeviationPercent! < 1);
  }
});

test("el checksum del PNG real aprobado coincide con el registrado en el benchmark (ai-video-benchmark-v2-active.ts)", async () => {
  const imagePath = join(__dirname, "..", "..", "..", "..", "content/long-form/gobekli-tepe-001/reference-images/bench-v2-a-pillar-transport.png");
  const buffer = readFileSync(imagePath);
  const { ACTIVE_BENCHMARK_SHOTS } = await import("./ai-video-benchmark-v2-active");
  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport")!;
  assert.equal(computeReferenceImageChecksumSha256(buffer), shot.referenceImageSpec.approval?.checksumSha256);
});

test("acepta un PNG 16:9 sintético bien formado", () => {
  const result = validateReferenceImageBuffer(fakePngBuffer(1920, 1080), "image/png");
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.format, "png");
});

test("acepta un JPEG 16:9 sintético bien formado", () => {
  const result = validateReferenceImageBuffer(fakeJpegBuffer(1920, 1080), "image/jpeg");
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.format, "jpeg");
    assert.equal(result.widthPx, 1920);
    assert.equal(result.heightPx, 1080);
  }
});

test("rechaza un tipo MIME no permitido", () => {
  const result = validateReferenceImageBuffer(fakePngBuffer(1920, 1080), "application/pdf");
  assert.equal(result.valid, false);
});

test("rechaza un buffer vacío/demasiado pequeño", () => {
  const result = validateReferenceImageBuffer(Buffer.alloc(4), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza cuando el mimeType declarado no coincide con el contenido real", () => {
  const result = validateReferenceImageBuffer(fakePngBuffer(1920, 1080), "image/jpeg");
  assert.equal(result.valid, false);
});

test("rechaza contenido que no coincide con ningún formato de imagen soportado", () => {
  const result = validateReferenceImageBuffer(Buffer.from("not an image at all, just padding text here"), "image/png");
  assert.equal(result.valid, false);
});

test("rechaza un aspect ratio fuera de tolerancia de 16:9 (p. ej. 1:1 cuadrado)", () => {
  const result = validateReferenceImageBuffer(fakePngBuffer(1000, 1000), "image/png");
  assert.equal(result.valid, false);
  if (!result.valid) assert.match(result.reason, /16:9/);
});

test("acepta una pequeña desviación de 16:9 (misma tolerancia que el PNG real aprobado, ~0.05%)", () => {
  const result = validateReferenceImageBuffer(fakePngBuffer(1672, 941), "image/png");
  assert.equal(result.valid, true);
});

test("computeReferenceImageChecksumSha256 es determinístico", () => {
  const buf = fakePngBuffer(1920, 1080);
  assert.equal(computeReferenceImageChecksumSha256(buf), computeReferenceImageChecksumSha256(Buffer.from(buf)));
});

test("referenceImageStoragePath produce una ruta determinística con benchmarkId/shotId/checksum truncado", () => {
  const path = referenceImageStoragePath("bench-1", "shot-a", "abc123def456abc123def456", "png");
  assert.equal(path, "long-form/bench-1/reference-images/shot-a-abc123def456abc1.png");
});

test("ingestApprovedReferenceImage sube un PNG válido y devuelve la referencia canónica", async () => {
  const { fake, files } = makeFakeSupabase();
  const buffer = fakePngBuffer(1920, 1080);
  const asset = await ingestApprovedReferenceImage(fake, buffer, { benchmarkId: "bench-1", shotId: "shot-a", declaredMimeType: "image/png" });
  assert.equal(asset.bucket, REFERENCE_IMAGE_STORAGE_BUCKET);
  assert.equal(asset.format, "png");
  assert.equal(asset.widthPx, 1920);
  assert.equal(asset.heightPx, 1080);
  assert.ok(files.has(asset.storagePath));
});

test("ingestApprovedReferenceImage lanza ReferenceImageInvalidError y NUNCA sube un archivo inválido", async () => {
  const { fake, uploadCalls } = makeFakeSupabase();
  await assert.rejects(
    () => ingestApprovedReferenceImage(fake, Buffer.alloc(4), { benchmarkId: "bench-1", shotId: "shot-a", declaredMimeType: "image/png" }),
    ReferenceImageInvalidError,
  );
  assert.equal(uploadCalls.length, 0);
});
