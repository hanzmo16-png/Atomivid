import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import type { GenerativeAsset, VideoGenerationRequest, VideoProvider } from "@/lib/providers/types";

/** Mismo patrón que ai-video-storage.test.ts — fake mínimo de SupabaseClient en memoria. */
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
  return { fake, uploadCalls };
}

function makeCountingProvider(): { provider: VideoProvider; getCallCount: () => number } {
  let callCount = 0;
  const provider: VideoProvider = {
    name: "veo-fake",
    capabilities: { id: "veo-fake", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
      callCount++;
      const buf = Buffer.alloc(32);
      buf.write("ftyp", 4, "ascii");
      return {
        buffer: buf,
        mimeType: "video/mp4",
        extension: "mp4",
        durationSeconds: request.durationSeconds,
        width: 1920,
        height: 1080,
        model: "veo-3.1-fast",
        costUsd: 0.96,
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

const baseRequest: VideoGenerationRequest = {
  prompt: "gente construyendo una estructura de piedra",
  aspectRatio: "16:9",
  durationSeconds: 8,
  maxCostUsd: 1,
  metadata: { shotId: "shot-1" },
};

test("wrapDurableVideoProvider: primera llamada delega al proveedor real y persiste el resultado", async () => {
  const { fake, uploadCalls } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  const asset = await wrapped.generateVideo(baseRequest);

  assert.equal(getCallCount(), 1);
  assert.equal(asset.costUsd, 0.96);
  assert.ok(uploadCalls.length >= 2, "debe subir tanto el buffer del clip como el registro STARTED/COMPLETED");
});

test("wrapDurableVideoProvider: un segundo intento del MISMO requestId/shotId NUNCA vuelve a llamar al proveedor real", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingProvider();
  const first = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });
  await first.generateVideo(baseRequest);
  assert.equal(getCallCount(), 1);

  // Un retry real crea un NUEVO wrapper (nuevo render_attempt, nuevo
  // proceso de worker) sobre el MISMO scopeId — la durabilidad debe
  // sobrevivir eso, no depender de estado en memoria del wrapper anterior.
  const retry = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });
  const asset = await retry.generateVideo(baseRequest);

  assert.equal(getCallCount(), 1, "el proveedor real NUNCA se vuelve a llamar para el mismo shot ya completado");
  assert.equal(asset.costUsd, 0, "un clip reutilizado nunca se vuelve a contar como gasto nuevo");
  assert.equal(asset.mimeType, "video/mp4");
  assert.ok(asset.buffer.byteLength > 0);
});

test("wrapDurableVideoProvider: un shotId distinto en el MISMO scopeId sí genera de nuevo (sin colisión de claves)", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  await wrapped.generateVideo(baseRequest);
  await wrapped.generateVideo({ ...baseRequest, metadata: { shotId: "shot-2" } });

  assert.equal(getCallCount(), 2);
});

test("wrapDurableVideoProvider: dos scopeId distintos con el MISMO shotId no colisionan", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingProvider();
  const wrappedA = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-A" });
  const wrappedB = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-B" });

  await wrappedA.generateVideo(baseRequest);
  await wrappedB.generateVideo(baseRequest);

  assert.equal(getCallCount(), 2);
});

test("wrapDurableVideoProvider: sin metadata.shotId, delega sin envoltura (nunca inventa una clave de idempotencia)", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  await wrapped.generateVideo({ ...baseRequest, metadata: undefined });
  await wrapped.generateVideo({ ...baseRequest, metadata: undefined });

  assert.equal(getCallCount(), 2, "sin shotId no hay durabilidad posible, así que cada llamada pasa directo");
});

test("wrapDurableVideoProvider: preserva name/capabilities/isAvailable del proveedor interno", () => {
  const { fake } = makeFakeSupabase();
  const { provider } = makeCountingProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  assert.equal(wrapped.name, provider.name);
  assert.equal(wrapped.capabilities, provider.capabilities);
  assert.equal(wrapped.isAvailable(), true);
});
