import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImageProvider, ImageGenerationRequest, GenerativeAsset } from "@/lib/providers/types";
import type { Shot } from "./types";
import {
  buildProductionAiRecreationEntry,
  isApprovedVisualTestV2Shot,
  resolveProductionAiRecreationImages,
  ProductionApprovedAssetInvalidError,
  ProductionAiRecreationUncertainCostStateError,
} from "./production-ai-recreation";
import { buildVisualTestV2Manifest } from "./visual-test-v2";
import { writeVisualTestV2ShotRecord, uploadVisualTestV2Image, visualTestV2ImagePath, writeVisualTestV2Ledger, computeChecksumSha256 } from "./visual-test-v2-storage";
import { VideoCostGuardExceededError, emptyLedger, recordSpend } from "./video-cost-guard";

const BUCKET = "videos";
const VIDEO_ID = "gobekli-tepe-001";

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

function fakePngBuffer(tag: string): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf[0] = 0x89;
  buf.write("PNG", 1, "ascii");
  buf.write(tag, 40, "ascii");
  return buf;
}

function makeCountingImageProvider(options?: { available?: boolean; costUsd?: number }) {
  let callCount = 0;
  const provider: ImageProvider = {
    name: "openai",
    capabilities: { id: "openai", models: ["gpt-image-2"], formats: ["image/png"], aspectRatios: ["landscape 3:2"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable() {
      return options?.available ?? true;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset> {
      callCount++;
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

function makeShot(id: string, beatId: string, visualIntent: string, source: Shot["source"] = "generated"): Pick<Shot, "id" | "beatId" | "visualIntent" | "source"> {
  return { id, beatId, visualIntent, source };
}

async function seedApprovedShot(fake: ReturnType<typeof makeFakeSupabase>["fake"], shotId: string) {
  const manifest = buildVisualTestV2Manifest();
  const entry = manifest.shots.find((s) => s.shotId === shotId)!;
  const path = visualTestV2ImagePath(VIDEO_ID, shotId, entry.idempotencyKey, "png");
  const buffer = fakePngBuffer(`approved-${shotId}`);
  await uploadVisualTestV2Image(fake, BUCKET, path, buffer, "image/png");
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId,
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: computeChecksumSha256(buffer),
    mimeType: "image/png",
    extension: "png",
    costUsd: 0.056,
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

async function seedAllThreeApproved(fake: ReturnType<typeof makeFakeSupabase>["fake"]) {
  await seedApprovedShot(fake, "b1-s4");
  await seedApprovedShot(fake, "b4-s2");
  await seedApprovedShot(fake, "b8-s5");
}

// --- buildProductionAiRecreationEntry --------------------------------------

test("buildProductionAiRecreationEntry quita el marcador '— ESTILO COMPARTIDO...' antes de componer el prompt real", () => {
  const shot = makeShot("b2-s3", "beat-2", "cinematic aerial view, archaeological hill site — ESTILO COMPARTIDO");
  const entry = buildProductionAiRecreationEntry(shot);
  assert.equal(entry.prompt.includes("ESTILO COMPARTIDO"), false);
  assert.ok(entry.prompt.startsWith("cinematic aerial view, archaeological hill site"));
});

test("buildProductionAiRecreationEntry usa el negativo compartido (no hay negativo por shot en el storyboard)", () => {
  const shot = makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO");
  const entry = buildProductionAiRecreationEntry(shot);
  assert.ok(entry.negativePrompt.length > 0);
});

test("buildProductionAiRecreationEntry es determinístico: mismo shot → misma idempotencyKey", () => {
  const shot = makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO");
  const a = buildProductionAiRecreationEntry(shot);
  const b = buildProductionAiRecreationEntry(shot);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test("buildProductionAiRecreationEntry: shotId distinto con el mismo texto produce idempotencyKey distinto (la identidad incluye el shotId)", () => {
  const a = buildProductionAiRecreationEntry(makeShot("b2-s3", "beat-2", "misma escena — ESTILO COMPARTIDO"));
  const b = buildProductionAiRecreationEntry(makeShot("b5-s3", "beat-5", "misma escena — ESTILO COMPARTIDO"));
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("isApprovedVisualTestV2Shot identifica exactamente los 3 shots aprobados", () => {
  assert.equal(isApprovedVisualTestV2Shot("b1-s4"), true);
  assert.equal(isApprovedVisualTestV2Shot("b4-s2"), true);
  assert.equal(isApprovedVisualTestV2Shot("b8-s5"), true);
  assert.equal(isApprovedVisualTestV2Shot("b2-s3"), false);
});

// --- resolveProductionAiRecreationImages -----------------------------------

test("1. los 3 shots aprobados con registro válido → se reutilizan (costo 0), el proveedor no se llama para ellos", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  const shots = [makeShot("b1-s4", "beat-1", "x — ESTILO COMPARTIDO"), makeShot("b4-s2", "beat-4", "y — ESTILO COMPARTIDO"), makeShot("b8-s5", "beat-8", "z — ESTILO COMPARTIDO")];
  const { provider, getCallCount } = makeCountingImageProvider();
  const results = await resolveProductionAiRecreationImages(fake, shots, provider, BUCKET);
  assert.equal(getCallCount(), 0);
  assert.equal(results.size, 3);
  for (const shotId of ["b1-s4", "b4-s2", "b8-s5"]) {
    assert.equal(results.get(shotId)!.reused, true);
    assert.equal(results.get(shotId)!.costUsd, 0);
  }
});

test("2. si un shot ya aprobado NO tiene registro válido → ProductionApprovedAssetInvalidError, nunca intenta regenerarlo", async () => {
  const { fake } = makeFakeSupabase();
  await seedApprovedShot(fake, "b1-s4");
  await seedApprovedShot(fake, "b4-s2");
  // b8-s5 falta a propósito
  const shots = [makeShot("b1-s4", "beat-1", "x"), makeShot("b4-s2", "beat-4", "y"), makeShot("b8-s5", "beat-8", "z")];
  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => resolveProductionAiRecreationImages(fake, shots, provider, BUCKET),
    (err: unknown) => err instanceof ProductionApprovedAssetInvalidError && err.shotIds.includes("b8-s5"),
  );
  assert.equal(getCallCount(), 0);
});

test("3. shots nuevos sin registro previo → se generan, se marcan COMPLETED, el proveedor se llama una vez por shot", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  const shots = [
    makeShot("b1-s4", "beat-1", "x — ESTILO COMPARTIDO"),
    makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO"),
    makeShot("b5-s3", "beat-5", "cinematic communal meal — ESTILO COMPARTIDO"),
  ];
  const { provider, getCallCount } = makeCountingImageProvider();
  const results = await resolveProductionAiRecreationImages(fake, shots, provider, BUCKET);
  assert.equal(getCallCount(), 2); // b2-s3 y b5-s3 (b1-s4 se reutiliza)
  assert.equal(results.get("b1-s4")!.reused, true);
  assert.equal(results.get("b2-s3")!.reused, false);
  assert.equal(results.get("b5-s3")!.reused, false);
});

test("4. segunda llamada con los mismos shots nuevos ya generados → se reutilizan, el proveedor no se llama de nuevo", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  const shots = [makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO")];
  const first = makeCountingImageProvider();
  await resolveProductionAiRecreationImages(fake, shots, first.provider, BUCKET);
  assert.equal(first.getCallCount(), 1);

  const second = makeCountingImageProvider();
  const results = await resolveProductionAiRecreationImages(fake, shots, second.provider, BUCKET);
  assert.equal(second.getCallCount(), 0);
  assert.equal(results.get("b2-s3")!.reused, true);
});

test("5. un shot nuevo con registro STARTED (consumo incierto) → aborta todo el lote nuevo antes de llamar al proveedor", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  const shot = makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO");
  const entry = buildProductionAiRecreationEntry(shot);
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId: "b2-s3",
    status: "STARTED",
    createdAtIso: "x",
    updatedAtIso: "x",
  });
  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => resolveProductionAiRecreationImages(fake, [shot], provider, BUCKET),
    (err: unknown) => err instanceof ProductionAiRecreationUncertainCostStateError && err.shotIds.includes("b2-s3"),
  );
  assert.equal(getCallCount(), 0);
});

test("6. el costo proyectado de los shots nuevos respeta el hard stop TOTAL ya incluyendo el gasto previo (ledger compartido, no arranca en $0)", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  let ledger = emptyLedger(VIDEO_ID);
  ledger = recordSpend(ledger, "visual_test_v2", 0.1681, "gasto real ya confirmado");
  ledger = recordSpend(ledger, "production", 2.75, "gasto previo simulado, deja solo $0.0819 de margen");
  await writeVisualTestV2Ledger(fake, BUCKET, ledger);

  const shots = [makeShot("b2-s3", "beat-2", "cinematic aerial view — ESTILO COMPARTIDO"), makeShot("b5-s3", "beat-5", "otra escena — ESTILO COMPARTIDO")];
  const { provider, getCallCount } = makeCountingImageProvider();
  await assert.rejects(
    () => resolveProductionAiRecreationImages(fake, shots, provider, BUCKET),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "hard_stop",
  );
  assert.equal(getCallCount(), 0);
});

test("7. proveedor no disponible con shots nuevos pendientes → error explícito, cero llamadas", async () => {
  const { fake } = makeFakeSupabase();
  await seedAllThreeApproved(fake);
  const shots = [makeShot("b2-s3", "beat-2", "x — ESTILO COMPARTIDO")];
  const { provider, getCallCount } = makeCountingImageProvider({ available: false });
  await assert.rejects(() => resolveProductionAiRecreationImages(fake, shots, provider, BUCKET), /OPENAI_API_KEY/);
  assert.equal(getCallCount(), 0);
});

test("8. shots con source distinto de 'generated' se ignoran por completo (no son AI_RECREATION)", async () => {
  const { fake } = makeFakeSupabase();
  const shots = [makeShot("b1-s2", "beat-1", "stock query", "stock"), makeShot("b3-s1", "beat-3", "texto", "local")];
  const { provider, getCallCount } = makeCountingImageProvider();
  const results = await resolveProductionAiRecreationImages(fake, shots, provider, BUCKET);
  assert.equal(results.size, 0);
  assert.equal(getCallCount(), 0);
});
