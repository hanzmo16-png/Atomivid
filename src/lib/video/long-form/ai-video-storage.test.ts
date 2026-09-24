import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiVideoClipStoragePath,
  computeAiVideoChecksumSha256,
  readAiVideoClipRecord,
  writeAiVideoClipRecord,
  validateExistingAiVideoClip,
  resolveAiVideoStorageAsset,
  AI_VIDEO_STORAGE_BUCKET,
  type AiVideoClipRecord,
} from "./ai-video-storage";
import type { ResolvedAiVideoClip } from "./ai-video-resolver";

/** Mismo patrón que visual-test-v2-storage.test.ts — fake mínimo de SupabaseClient en memoria. */
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
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

function fakeClip(overrides: Partial<ResolvedAiVideoClip> = {}): ResolvedAiVideoClip {
  return {
    shotId: "bench-a-stone-carving",
    buffer: Buffer.from("fake-mp4-bytes-for-testing-only-not-a-real-video-file"),
    mimeType: "video/mp4",
    extension: "mp4",
    durationSeconds: 5,
    provider: "fixture",
    model: "fixture-placeholder-clip",
    costUsd: 0,
    ...overrides,
  };
}

test("aiVideoClipStoragePath produce una ruta determinística que incluye scopeId/shotId/idempotencyKey", () => {
  const path = aiVideoClipStoragePath("bench-1", "bench-a", "abc123", "mp4");
  assert.equal(path, "long-form/bench-1/ai-video/bench-a-abc123.mp4");
});

test("computeAiVideoChecksumSha256 es determinístico", () => {
  const buf = Buffer.from("hello");
  assert.equal(computeAiVideoChecksumSha256(buf), computeAiVideoChecksumSha256(Buffer.from("hello")));
});

test("readAiVideoClipRecord devuelve undefined si no existe todavía (nunca lanza)", async () => {
  const { fake } = makeFakeSupabase();
  const record = await readAiVideoClipRecord(fake, "videos", "bench-1", "abc123");
  assert.equal(record, undefined);
});

test("writeAiVideoClipRecord + readAiVideoClipRecord: round-trip exacto", async () => {
  const { fake } = makeFakeSupabase();
  const record: AiVideoClipRecord = {
    idempotencyKey: "abc123",
    scopeId: "bench-1",
    shotId: "bench-a",
    status: "COMPLETED",
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  await writeAiVideoClipRecord(fake, "videos", record);
  const read = await readAiVideoClipRecord(fake, "videos", "bench-1", "abc123");
  assert.deepEqual(read, record);
});

test("validateExistingAiVideoClip devuelve false si falta storagePath/checksum", async () => {
  const { fake } = makeFakeSupabase();
  const record: AiVideoClipRecord = {
    idempotencyKey: "abc",
    scopeId: "bench-1",
    shotId: "s1",
    status: "STARTED",
    createdAtIso: "x",
    updatedAtIso: "x",
  };
  assert.equal(await validateExistingAiVideoClip(fake, "videos", record), false);
});

test("resolveAiVideoStorageAsset sube el clip, escribe el registro COMPLETED, y devuelve una referencia canónica con checksum", async () => {
  const { fake, files } = makeFakeSupabase();
  const clip = fakeClip();
  const ref = await resolveAiVideoStorageAsset(fake, clip, {
    scopeId: "bench-1",
    idempotencyKey: "key-1",
    executionMode: "simulation",
  });
  assert.equal(ref.bucket, AI_VIDEO_STORAGE_BUCKET);
  assert.equal(ref.storagePath, "long-form/bench-1/ai-video/bench-a-stone-carving-key-1.mp4");
  assert.equal(ref.checksumSha256, computeAiVideoChecksumSha256(clip.buffer));
  assert.ok(files.has(ref.storagePath));

  const record = await readAiVideoClipRecord(fake, AI_VIDEO_STORAGE_BUCKET, "bench-1", "key-1");
  assert.equal(record?.status, "COMPLETED");
  assert.equal(record?.provider, "fixture");
  assert.equal(record?.executionMode, "simulation");
});

test("resolveAiVideoStorageAsset es idempotente: una segunda llamada con el mismo idempotencyKey reutiliza sin volver a subir", async () => {
  const { fake, uploadCalls } = makeFakeSupabase();
  const clip = fakeClip();
  await resolveAiVideoStorageAsset(fake, clip, { scopeId: "bench-1", idempotencyKey: "key-2", executionMode: "simulation" });
  const uploadsAfterFirst = uploadCalls.length;
  const ref2 = await resolveAiVideoStorageAsset(fake, clip, { scopeId: "bench-1", idempotencyKey: "key-2", executionMode: "simulation" });
  assert.equal(uploadCalls.length, uploadsAfterFirst); // sin subida nueva (ni buffer ni record)
  assert.equal(ref2.checksumSha256, computeAiVideoChecksumSha256(clip.buffer));
});

test("un clip de un proveedor real (no fixture) también funciona — el storage es genérico, sin lógica específica de proveedor", async () => {
  const { fake } = makeFakeSupabase();
  const clip = fakeClip({ provider: "runway", model: "gen4_turbo", costUsd: 0.25, providerJobId: "task_abc" });
  const ref = await resolveAiVideoStorageAsset(fake, clip, { scopeId: "bench-1", idempotencyKey: "key-3", executionMode: "real" });
  const record = await readAiVideoClipRecord(fake, AI_VIDEO_STORAGE_BUCKET, "bench-1", "key-3");
  assert.equal(record?.provider, "runway");
  assert.equal(record?.providerJobId, "task_abc");
  assert.ok(ref.storagePath.includes("bench-a-stone-carving-key-3"));
});
