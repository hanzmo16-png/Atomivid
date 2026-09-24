import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImageProvider, ImageGenerationRequest, GenerativeAsset } from "@/lib/providers/types";
import {
  runVisualTestV2RealGeneration,
  VisualTestV2UncertainCostStateError,
  VISUAL_TEST_V2_REAL_SHOT_IDS,
  VISUAL_TEST_V2_REAL_CONFIRM_VALUE,
} from "./visual-test-v2-real";
import { writeVisualTestV2ShotRecord, uploadVisualTestV2Image, visualTestV2ImagePath, writeVisualTestV2Ledger } from "./visual-test-v2-storage";
import { VideoCostGuardExceededError, emptyLedger, recordSpend } from "./video-cost-guard";

const BUCKET = "videos";
const VIDEO_ID = "gobekli-tepe-001";

/** Fake mínimo de SupabaseClient — mismo patrón que visual-test-v2-storage.test.ts, un Map en memoria por test. */
function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
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
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files };
}

/** PNG mínimo válido para validateVisualAssetBuffer (magic bytes + tamaño mínimo, sin IHDR real — la validación de dimensiones se salta si no hay IHDR). */
function fakePngBuffer(tag: string): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf[0] = 0x89;
  buf.write("PNG", 1, "ascii");
  buf.write(tag, 40, "ascii");
  return buf;
}

function makeCountingImageProvider(options?: {
  available?: boolean;
  costUsd?: number;
  failAtCallIndex?: number;
  failError?: Error;
}) {
  let callCount = 0;
  const provider: ImageProvider = {
    name: "openai",
    capabilities: {
      id: "openai",
      models: ["gpt-image-2"],
      formats: ["image/png"],
      aspectRatios: ["landscape 3:2"],
      timeoutMs: 1000,
      maxRetries: 0,
    },
    isAvailable() {
      return options?.available ?? true;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
      callCount++;
      if (options?.failAtCallIndex === callCount) {
        throw options.failError ?? new Error("fallo simulado del proveedor");
      }
      return {
        buffer: fakePngBuffer(`call-${callCount}`),
        mimeType: "image/png",
        extension: "png",
        width: 1536,
        height: 1024,
        model: "gpt-image-2",
        costUsd: options?.costUsd ?? 0.05,
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

test("VISUAL_TEST_V2_REAL_SHOT_IDS es exactamente el cierre de 3 shots aprobados, en orden", () => {
  assert.deepEqual(VISUAL_TEST_V2_REAL_SHOT_IDS, ["b1-s4", "b4-s2", "b8-s5"]);
});

test("VISUAL_TEST_V2_REAL_CONFIRM_VALUE es un valor no trivial (no vacío, no genérico)", () => {
  assert.ok(VISUAL_TEST_V2_REAL_CONFIRM_VALUE.length > 10);
});

test("1. shots nuevos (sin registro previo) → genera los 3, sube, marca COMPLETED, actualiza el ledger, paidApisCalled true", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, provider);

  assert.equal(getCallCount(), 3);
  assert.equal(result.shots.length, 3);
  assert.deepEqual(
    result.shots.map((s) => s.shotId),
    ["b1-s4", "b4-s2", "b8-s5"],
  );
  assert.ok(result.shots.every((s) => s.status === "generated"));
  assert.equal(result.paidApisCalled, true);
  assert.equal(result.totalSpentThisRunUsd, 0.15);
  assert.equal(result.ledgerVisualTestV2SpentUsd, 0.15);
  assert.equal(result.maxTotalUsd, 0.5);
  assert.equal(result.hardStopUsd, 3);
});

test("2. segunda ejecución (mismo storage) → los 3 shots ya COMPLETED válidos se reutilizan, el proveedor NO se llama", async () => {
  const { fake } = makeFakeSupabase();
  const first = makeCountingImageProvider();
  await runVisualTestV2RealGeneration(fake, BUCKET, first.provider);
  assert.equal(first.getCallCount(), 3);

  const second = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, second.provider);

  assert.equal(second.getCallCount(), 0);
  assert.ok(result.shots.every((s) => s.status === "reused"));
  assert.equal(result.paidApisCalled, false);
  assert.equal(result.totalSpentThisRunUsd, 0);
});

test("3. un shot en estado STARTED sin COMPLETED (consumo incierto) → aborta TODO el lote antes de llamar al proveedor, incluso para los shots seguros", async () => {
  const { fake } = makeFakeSupabase();
  // Escribe un STARTED "a mano" para b4-s2 (simula un crash a mitad de una llamada anterior).
  const manifest = await import("./visual-test-v2").then((m) => m.buildVisualTestV2Manifest());
  const b4s2 = manifest.shots.find((s) => s.shotId === "b4-s2")!;
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: b4s2.idempotencyKey,
    shotId: "b4-s2",
    status: "STARTED",
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  });

  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => runVisualTestV2RealGeneration(fake, BUCKET, provider),
    (err: unknown) => err instanceof VisualTestV2UncertainCostStateError && err.shotIds.includes("b4-s2"),
  );
  assert.equal(getCallCount(), 0);
});

test("4. costo proyectado excedería el tope de $0.50 de Visual Test V2 → aborta ANTES de llamar al proveedor", async () => {
  const { fake } = makeFakeSupabase();
  let ledger = emptyLedger(VIDEO_ID);
  ledger = recordSpend(ledger, "visual_test_v2", 0.48, "gasto previo simulado");
  await writeVisualTestV2Ledger(fake, BUCKET, ledger);

  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => runVisualTestV2RealGeneration(fake, BUCKET, provider),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "visual_test_v2_cap",
  );
  assert.equal(getCallCount(), 0);
});

test("5. costo proyectado excedería el hard stop de $3.00 de VIDEO #001 → aborta ANTES de llamar al proveedor", async () => {
  const { fake } = makeFakeSupabase();
  let ledger = emptyLedger(VIDEO_ID);
  ledger = recordSpend(ledger, "production", 2.9, "gasto previo simulado de producción");
  await writeVisualTestV2Ledger(fake, BUCKET, ledger);

  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => runVisualTestV2RealGeneration(fake, BUCKET, provider),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "hard_stop",
  );
  assert.equal(getCallCount(), 0);
});

test("6. proveedor no disponible (sin OPENAI_API_KEY) con shots pendientes → lanza error explícito, nunca llama a generateImage", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingImageProvider({ available: false });
  await assert.rejects(() => runVisualTestV2RealGeneration(fake, BUCKET, provider), /OPENAI_API_KEY/);
  assert.equal(getCallCount(), 0);
});

test("7. reuso parcial: 1 shot ya completado y válido, 2 pendientes → el proveedor se llama exactamente 2 veces", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = await import("./visual-test-v2").then((m) => m.buildVisualTestV2Manifest());
  const b1s4 = manifest.shots.find((s) => s.shotId === "b1-s4")!;
  const path = visualTestV2ImagePath(VIDEO_ID, "b1-s4", b1s4.idempotencyKey, "png");
  const buffer = fakePngBuffer("preexistente");
  await uploadVisualTestV2Image(fake, BUCKET, path, buffer, "image/png");
  const { computeChecksumSha256 } = await import("./visual-test-v2-storage");
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: b1s4.idempotencyKey,
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: computeChecksumSha256(buffer),
    mimeType: "image/png",
    extension: "png",
    costUsd: 0.05,
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  });

  const { provider, getCallCount } = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, provider);

  assert.equal(getCallCount(), 2);
  const b1 = result.shots.find((s) => s.shotId === "b1-s4")!;
  assert.equal(b1.status, "reused");
  assert.equal(result.shots.filter((s) => s.status === "generated").length, 2);
  assert.equal(result.totalSpentThisRunUsd, 0.1);
});

test("8. archivo corrupto (checksum no coincide con un COMPLETED existente) → NO reutiliza, regenera ese shot", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = await import("./visual-test-v2").then((m) => m.buildVisualTestV2Manifest());
  const b8s5 = manifest.shots.find((s) => s.shotId === "b8-s5")!;
  const path = visualTestV2ImagePath(VIDEO_ID, "b8-s5", b8s5.idempotencyKey, "png");
  const { computeChecksumSha256 } = await import("./visual-test-v2-storage");
  const originalBuffer = fakePngBuffer("original");
  await uploadVisualTestV2Image(fake, BUCKET, path, originalBuffer, "image/png");
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: b8s5.idempotencyKey,
    shotId: "b8-s5",
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: computeChecksumSha256(originalBuffer),
    createdAtIso: "x",
    updatedAtIso: "x",
  });
  // Corrompe el archivo después de que el registro ya apunta a él.
  await uploadVisualTestV2Image(fake, BUCKET, path, fakePngBuffer("corrupto"), "image/png");

  const { provider, getCallCount } = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, provider);

  assert.equal(getCallCount(), 3); // los 3 se regeneran: b8-s5 por corrupción, los otros 2 por no tener registro
  const b8 = result.shots.find((s) => s.shotId === "b8-s5")!;
  assert.equal(b8.status, "generated");
});

test("9. record COMPLETED cuyo archivo nunca se subió (faltante) → se trata como pendiente de generar", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = await import("./visual-test-v2").then((m) => m.buildVisualTestV2Manifest());
  const b1s4 = manifest.shots.find((s) => s.shotId === "b1-s4")!;
  const path = visualTestV2ImagePath(VIDEO_ID, "b1-s4", b1s4.idempotencyKey, "png");
  // Escribe el registro COMPLETED pero nunca sube el archivo.
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: b1s4.idempotencyKey,
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: "no-importa",
    createdAtIso: "x",
    updatedAtIso: "x",
  });

  const { provider, getCallCount } = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, provider);
  assert.equal(getCallCount(), 3);
  assert.ok(result.shots.every((s) => s.status === "generated"));
});

test("10. cost guard contabiliza correctamente solo los shots nuevos — un reintento con 1 pendiente solo suma su costo, no el de los ya reutilizados", async () => {
  const { fake } = makeFakeSupabase();
  const first = makeCountingImageProvider();
  await runVisualTestV2RealGeneration(fake, BUCKET, first.provider);
  assert.equal(first.getCallCount(), 3);

  // Borra (simulando pérdida del registro) solo el de b8-s5 para forzar una regeneración parcial.
  const manifest = await import("./visual-test-v2").then((m) => m.buildVisualTestV2Manifest());
  const b8s5 = manifest.shots.find((s) => s.shotId === "b8-s5")!;
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: b8s5.idempotencyKey,
    shotId: "b8-s5",
    status: "COMPLETED",
    storagePath: "ruta-que-no-existe.png",
    checksumSha256: "x",
    createdAtIso: "x",
    updatedAtIso: "x",
  });

  const second = makeCountingImageProvider();
  const result = await runVisualTestV2RealGeneration(fake, BUCKET, second.provider);
  assert.equal(second.getCallCount(), 1);
  assert.equal(result.totalSpentThisRunUsd, 0.05);
  // Ledger acumulado: 0.15 de la primera corrida + 0.05 de esta = 0.20.
  assert.equal(result.ledgerVisualTestV2SpentUsd, 0.2);
});
