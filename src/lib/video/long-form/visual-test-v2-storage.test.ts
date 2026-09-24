import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readVisualTestV2Ledger,
  writeVisualTestV2Ledger,
  readVisualTestV2ShotRecord,
  writeVisualTestV2ShotRecord,
  validateExistingVisualTestV2Image,
  uploadVisualTestV2Image,
  visualTestV2ImagePath,
  computeChecksumSha256,
  type ImageGenRecord,
} from "./visual-test-v2-storage";
import type { CostLedger } from "./video-cost-guard";

/**
 * Fake mínimo de SupabaseClient (solo storage.from().download()/upload())
 * — mismo patrón que src/lib/video/avatar/pipeline.test.ts. Un Map en
 * memoria simula el bucket, compartido entre llamadas dentro de un mismo
 * test, para poder probar round-trips reales de lectura/escritura.
 */
function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const uploadCalls: string[] = [];
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            const bytes = buf;
            return {
              data: {
                async text() {
                  return bytes.toString("utf8");
                },
                async arrayBuffer() {
                  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                },
              },
              error: null,
            };
          },
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

test("visualTestV2ImagePath produce una ruta determinística que incluye shotId e idempotencyKey", () => {
  const path = visualTestV2ImagePath("gobekli-tepe-001", "b1-s4", "abc123", "png");
  assert.equal(path, "long-form/gobekli-tepe-001/visual-test-v2/b1-s4-abc123.png");
});

test("readVisualTestV2Ledger devuelve un ledger vacío si no existe el archivo todavía (nunca lanza)", async () => {
  const { fake } = makeFakeSupabase();
  const ledger = await readVisualTestV2Ledger(fake, "videos", "gobekli-tepe-001");
  assert.equal(ledger.videoId, "gobekli-tepe-001");
  assert.deepEqual(ledger.entries, []);
});

test("writeVisualTestV2Ledger + readVisualTestV2Ledger: round-trip exacto", async () => {
  const { fake } = makeFakeSupabase();
  const ledger: CostLedger = {
    videoId: "gobekli-tepe-001",
    entries: [{ timestampIso: "2026-01-01T00:00:00.000Z", category: "visual_test_v2", amountUsd: 0.05, note: "test" }],
  };
  await writeVisualTestV2Ledger(fake, "videos", ledger);
  const read = await readVisualTestV2Ledger(fake, "videos", "gobekli-tepe-001");
  assert.deepEqual(read, ledger);
});

test("readVisualTestV2ShotRecord devuelve undefined si no existe registro (beat/shot nuevo)", async () => {
  const { fake } = makeFakeSupabase();
  const record = await readVisualTestV2ShotRecord(fake, "videos", "gobekli-tepe-001", "clave-inexistente");
  assert.equal(record, undefined);
});

test("writeVisualTestV2ShotRecord + readVisualTestV2ShotRecord: round-trip exacto", async () => {
  const { fake } = makeFakeSupabase();
  const record: ImageGenRecord = {
    idempotencyKey: "clave-1",
    shotId: "b1-s4",
    status: "STARTED",
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  await writeVisualTestV2ShotRecord(fake, "videos", "gobekli-tepe-001", record);
  const read = await readVisualTestV2ShotRecord(fake, "videos", "gobekli-tepe-001", "clave-1");
  assert.deepEqual(read, record);
});

test("validateExistingVisualTestV2Image: false si el record no tiene storagePath/checksum", async () => {
  const { fake } = makeFakeSupabase();
  const record: ImageGenRecord = {
    idempotencyKey: "k",
    shotId: "b1-s4",
    status: "COMPLETED",
    createdAtIso: "x",
    updatedAtIso: "x",
  };
  assert.equal(await validateExistingVisualTestV2Image(fake, "videos", record), false);
});

test("validateExistingVisualTestV2Image: false si el archivo no existe en Storage (faltante)", async () => {
  const { fake } = makeFakeSupabase();
  const record: ImageGenRecord = {
    idempotencyKey: "k",
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: "long-form/gobekli-tepe-001/visual-test-v2/b1-s4-k.png",
    checksumSha256: "deadbeef",
    createdAtIso: "x",
    updatedAtIso: "x",
  };
  assert.equal(await validateExistingVisualTestV2Image(fake, "videos", record), false);
});

test("validateExistingVisualTestV2Image: true si el archivo existe y el checksum coincide", async () => {
  const { fake } = makeFakeSupabase();
  const path = "long-form/gobekli-tepe-001/visual-test-v2/b1-s4-k.png";
  const buffer = Buffer.from("contenido-de-imagen-real");
  await uploadVisualTestV2Image(fake, "videos", path, buffer, "image/png");
  const record: ImageGenRecord = {
    idempotencyKey: "k",
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: computeChecksumSha256(buffer),
    createdAtIso: "x",
    updatedAtIso: "x",
  };
  assert.equal(await validateExistingVisualTestV2Image(fake, "videos", record), true);
});

test("validateExistingVisualTestV2Image: false si el archivo está corrupto (checksum no coincide) — nunca reutiliza un archivo dañado", async () => {
  const { fake } = makeFakeSupabase();
  const path = "long-form/gobekli-tepe-001/visual-test-v2/b1-s4-k.png";
  await uploadVisualTestV2Image(fake, "videos", path, Buffer.from("contenido-original"), "image/png");
  const record: ImageGenRecord = {
    idempotencyKey: "k",
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: computeChecksumSha256(Buffer.from("contenido-original")),
    createdAtIso: "x",
    updatedAtIso: "x",
  };
  // Simula corrupción: el archivo en Storage cambia después de escribirse el registro.
  await uploadVisualTestV2Image(fake, "videos", path, Buffer.from("contenido-corrupto-distinto"), "image/png");
  assert.equal(await validateExistingVisualTestV2Image(fake, "videos", record), false);
});

test("uploadVisualTestV2Image sube exactamente los bytes dados a la ruta dada", async () => {
  const { fake, files } = makeFakeSupabase();
  const path = "long-form/gobekli-tepe-001/visual-test-v2/b4-s2-k2.png";
  const buffer = Buffer.from("otra-imagen");
  await uploadVisualTestV2Image(fake, "videos", path, buffer, "image/png");
  assert.deepEqual(files.get(path), buffer);
});

test("computeChecksumSha256 es determinístico y sensible a cualquier cambio de bytes", () => {
  const a = computeChecksumSha256(Buffer.from("x"));
  const b = computeChecksumSha256(Buffer.from("x"));
  const c = computeChecksumSha256(Buffer.from("y"));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
