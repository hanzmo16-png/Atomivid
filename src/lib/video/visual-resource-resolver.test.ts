import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGeneratedImageForScene, findExistingGeneratedImage } from "./visual-resource-resolver";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "./storyboard/types";

const BUCKET = "videos";

function makeFakeStorage(filesByPrefix: Record<string, { name: string }[]> = {}) {
  const uploads: Array<{ path: string; bytes: number; contentType: string }> = [];
  const signedPaths: string[] = [];
  const fake = {
    storage: {
      from() {
        return {
          async list(dir: string, opts?: { search?: string }) {
            const files = filesByPrefix[dir] ?? [];
            const filtered = opts?.search ? files.filter((f) => f.name.startsWith(opts.search as string)) : files;
            return { data: filtered, error: null };
          },
          async upload(objectPath: string, buffer: Buffer, opts: { contentType: string }) {
            uploads.push({ path: objectPath, bytes: buffer.byteLength, contentType: opts.contentType });
            return { error: null };
          },
          async createSignedUrl(objectPath: string) {
            signedPaths.push(objectPath);
            return { data: { signedUrl: `https://signed.example.test/${objectPath}` }, error: null };
          },
          // Marcadores durables (state/generated/*.json): en estas pruebas nunca existen previamente.
          async download() {
            return { data: null, error: { message: "Object not found", statusCode: "404" } };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, uploads, signedPaths };
}

function makeFakeImageProvider(overrides: Partial<ImageProvider> = {}): { provider: ImageProvider; callCount: () => number } {
  let calls = 0;
  const provider: ImageProvider = {
    name: "fake",
    capabilities: { id: "fake", models: ["fake-model"], formats: ["image/png"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      calls += 1;
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52]),
        (() => {
          const b = Buffer.alloc(8);
          b.writeUInt32BE(1024, 0);
          b.writeUInt32BE(1536, 4);
          return b;
        })(),
        Buffer.alloc(200, 0x20),
      ]);
      return { buffer: png, mimeType: "image/png", extension: "png", width: 1024, height: 1536, model: "fake-model", costUsd: 0.05 };
    },
    ...overrides,
  };
  return { provider, callCount: () => calls };
}

function buildScene(overrides: Partial<StoryboardScene> = {}): StoryboardScene {
  return {
    id: "scene-0",
    order: 0,
    narrationText: "x",
    estimatedDurationSeconds: 3,
    literalMeaning: "x",
    emotionalSubtext: "x",
    narrativeGoal: "x",
    dominantEmotion: "x",
    energy: "low",
    subject: "x",
    visibleAction: "x",
    environment: "x",
    timeOfDay: "x",
    shotType: "x",
    cameraMovement: "x",
    lighting: "x",
    colorPalette: "x",
    visualStyle: "x",
    imagePrompt: "a cinematic photo",
    negativePrompt: "text",
    stockQueries: ["a", "b"],
    resourceType: "generated_image",
    priority: 1,
    confidence: 0.8,
    selectionRationale: "x",
    continuityWithPrevious: "none",
    continuityWithNext: "none",
    maxCostUsd: 0.1,
    fallbackStrategy: ["retry_prompt"],
    ...overrides,
  };
}

test("findExistingGeneratedImage devuelve null cuando no hay ningún archivo previo", async () => {
  const { fake } = makeFakeStorage({});
  const result = await findExistingGeneratedImage(fake, BUCKET, "req-1", 0);
  assert.equal(result, null);
});

test("findExistingGeneratedImage encuentra un archivo existente por prefijo, sin importar la extensión", async () => {
  const { fake } = makeFakeStorage({ "req-1": [{ name: "scene-0-generated.png" }] });
  const result = await findExistingGeneratedImage(fake, BUCKET, "req-1", 0);
  assert.deepEqual(result, { path: "req-1/scene-0-generated.png" });
});

test("resolveGeneratedImageForScene reutiliza un archivo existente (idempotencia) — costo $0 y CERO llamadas al proveedor", async () => {
  const { fake, uploads } = makeFakeStorage({ "req-1": [{ name: "scene-2-generated.svg" }] });
  const { provider, callCount } = makeFakeImageProvider();

  const result = await resolveGeneratedImageForScene({
    supabase: fake,
    bucket: BUCKET,
    requestId: "req-1",
    sceneIndex: 2,
    scene: buildScene(),
    imageProvider: provider,
    remainingBudgetUsd: 1,
    signedUrlTtlSeconds: 3600,
  });

  assert.equal(result.status, "reused");
  assert.equal(result.costUsd, 0);
  assert.equal(result.path, "req-1/scene-2-generated.svg");
  assert.equal(callCount(), 0, "no debería haberse llamado al proveedor si ya existía el archivo");
  assert.equal(uploads.length, 0, "no debería haberse subido nada nuevo");
});

test("resolveGeneratedImageForScene genera y sube una imagen nueva cuando no existe todavía", async () => {
  const { fake, uploads } = makeFakeStorage({});
  const { provider, callCount } = makeFakeImageProvider();

  const result = await resolveGeneratedImageForScene({
    supabase: fake,
    bucket: BUCKET,
    requestId: "req-2",
    sceneIndex: 0,
    scene: buildScene(),
    imageProvider: provider,
    remainingBudgetUsd: 1,
    signedUrlTtlSeconds: 3600,
  });

  assert.equal(result.status, "generated");
  assert.equal(result.costUsd, 0.05);
  assert.equal(result.path, "req-2/scene-0-generated.png");
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1536);
  assert.equal(callCount(), 1);
  const images = uploads.filter((u) => !u.path.endsWith(".json"));
  assert.equal(images.length, 1);
  assert.equal(images[0].contentType, "image/png");
  // Marcador durable: «started» antes de pagar y «stored» al terminar.
  assert.deepEqual(uploads.filter((u) => u.path.endsWith(".json")).map((u) => u.path), ["req-2/state/generated/scene-0-generated.json", "req-2/state/generated/scene-0-generated.json"]);
});

test("resolveGeneratedImageForScene rechaza (sin subir nada) si el proveedor devuelve un archivo inválido", async () => {
  const { fake, uploads } = makeFakeStorage({});
  const { provider } = makeFakeImageProvider({
    async generateImage() {
      return { buffer: Buffer.alloc(0), mimeType: "image/png", extension: "png", model: "fake-model", costUsd: 0.05 };
    },
  });

  await assert.rejects(
    () =>
      resolveGeneratedImageForScene({
        supabase: fake,
        bucket: BUCKET,
        requestId: "req-3",
        sceneIndex: 0,
        scene: buildScene(),
        imageProvider: provider,
        remainingBudgetUsd: 1,
        signedUrlTtlSeconds: 3600,
      }),
    /archivo inválido/,
  );
  assert.equal(uploads.filter((u) => !u.path.endsWith(".json")).length, 0, "ninguna imagen subida (solo el marcador durable)");
});

test("resolveGeneratedImageForScene propaga el error del proveedor tal cual (nunca cae a otro proveedor de pago por su cuenta)", async () => {
  const { fake } = makeFakeStorage({});
  const { provider } = makeFakeImageProvider({
    async generateImage() {
      throw new Error("upstream_error simulado");
    },
  });

  await assert.rejects(
    () =>
      resolveGeneratedImageForScene({
        supabase: fake,
        bucket: BUCKET,
        requestId: "req-4",
        sceneIndex: 0,
        scene: buildScene(),
        imageProvider: provider,
        remainingBudgetUsd: 1,
        signedUrlTtlSeconds: 3600,
      }),
    /upstream_error simulado/,
  );
});
