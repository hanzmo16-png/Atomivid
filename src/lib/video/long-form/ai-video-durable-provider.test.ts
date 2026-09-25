import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";

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

/**
 * Simula el escenario real de P2B: generateVideo() envía la operación
 * (submitCallCount++) pero el sondeo termina en un error que YA trae
 * providerJobId (timeout/fallo transitorio agotado, ver veo.ts) — nunca
 * llega a completar. resumeGeneration() reanuda esa MISMA operación
 * (resumeCallCount++) y sí termina con éxito.
 */
function makeFailThenResumeProvider(): {
  provider: VideoProvider;
  getSubmitCallCount: () => number;
  getResumeCallCount: () => number;
} {
  let submitCallCount = 0;
  let resumeCallCount = 0;
  const OPERATION_ID = "operations/op-fail-then-resume";
  function makeAsset(request: VideoGenerationRequest): GenerativeAsset {
    const buf = Buffer.alloc(32);
    buf.write("ftyp", 4, "ascii");
    return {
      buffer: buf,
      mimeType: "video/mp4",
      extension: "mp4",
      durationSeconds: request.durationSeconds,
      model: "veo-3.1-fast",
      costUsd: 0.96,
      providerJobId: OPERATION_ID,
    };
  }
  const provider: VideoProvider = {
    name: "veo-fake",
    capabilities: { id: "veo-fake", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(): Promise<GenerativeAsset> {
      submitCallCount++;
      throw new GenerativeProviderError(
        "Se agotaron los intentos de sondeo",
        "veo-fake",
        "timeout",
        undefined,
        OPERATION_ID,
      );
    },
    async resumeGeneration(operationName: string, request: VideoGenerationRequest): Promise<GenerativeAsset> {
      resumeCallCount++;
      assert.equal(operationName, OPERATION_ID);
      return makeAsset(request);
    },
  };
  return { provider, getSubmitCallCount: () => submitCallCount, getResumeCallCount: () => resumeCallCount };
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

test("wrapDurableVideoProvider (RC mission Fase 5): un fallo tras el envío persiste un registro STARTED con el providerJobId, sin fingir éxito", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getSubmitCallCount } = makeFailThenResumeProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  await assert.rejects(() => wrapped.generateVideo(baseRequest), GenerativeProviderError);
  assert.equal(getSubmitCallCount(), 1);
});

test("wrapDurableVideoProvider (RC mission Fase 5): un intento posterior REANUDA la operación STARTED en vez de enviar una segunda", async () => {
  const { fake } = makeFakeSupabase();
  const { provider, getSubmitCallCount, getResumeCallCount } = makeFailThenResumeProvider();

  const first = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });
  await assert.rejects(() => first.generateVideo(baseRequest));
  assert.equal(getSubmitCallCount(), 1);
  assert.equal(getResumeCallCount(), 0);

  // Nuevo wrapper (nuevo render_attempt/worker) sobre el MISMO scopeId.
  const retry = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });
  const asset = await retry.generateVideo(baseRequest);

  assert.equal(getSubmitCallCount(), 1, "NUNCA debe volver a enviar submitGeneration para el mismo shot");
  assert.equal(getResumeCallCount(), 1);
  assert.equal(asset.providerJobId, "operations/op-fail-then-resume");

  // Y un tercer intento reutiliza el clip ya COMPLETED (sin reanudar de nuevo).
  const third = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });
  const asset3 = await third.generateVideo(baseRequest);
  assert.equal(getResumeCallCount(), 1, "una vez COMPLETED, ya no hace falta reanudar");
  assert.equal(asset3.costUsd, 0);
});

test("wrapDurableVideoProvider (RC mission Fase 5): sin resumeGeneration en el proveedor, un registro STARTED con providerJobId lanza en vez de reintentar a ciegas", async () => {
  const { fake } = makeFakeSupabase();
  const OPERATION_ID = "operations/op-no-resume-support";
  let submitCallCount = 0;
  const noResumeProvider: VideoProvider = {
    name: "veo-fake",
    capabilities: { id: "veo-fake", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(): Promise<GenerativeAsset> {
      submitCallCount++;
      throw new GenerativeProviderError("timeout de sondeo", "veo-fake", "timeout", undefined, OPERATION_ID);
    },
    // Sin resumeGeneration — como Runway/Kling hoy.
  };

  const first = wrapDurableVideoProvider(noResumeProvider, { supabase: fake, scopeId: "req-1" });
  await assert.rejects(() => first.generateVideo(baseRequest));
  assert.equal(submitCallCount, 1);

  const retry = wrapDurableVideoProvider(noResumeProvider, { supabase: fake, scopeId: "req-1" });
  await assert.rejects(
    () => retry.generateVideo(baseRequest),
    (err: unknown) => err instanceof Error && err.message.includes("no admite reanudar sondeo"),
  );
  assert.equal(submitCallCount, 1, "sin soporte de reanudación, NUNCA se envía una segunda generación en su lugar");
});

test("wrapDurableVideoProvider: preserva name/capabilities/isAvailable del proveedor interno", () => {
  const { fake } = makeFakeSupabase();
  const { provider } = makeCountingProvider();
  const wrapped = wrapDurableVideoProvider(provider, { supabase: fake, scopeId: "req-1" });

  assert.equal(wrapped.name, provider.name);
  assert.equal(wrapped.capabilities, provider.capabilities);
  assert.equal(wrapped.isAvailable(), true);
});
