import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import { readAiVideoClipRecord, AI_VIDEO_STORAGE_BUCKET } from "./ai-video-storage";
import { ProductionBudget, memoryBudgetStore } from "./production-budget";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";

/** Storage en memoria con inyección de fallos de subida (compartido entre "intentos" = misma solicitud). */
function makeStorage(failUpload: (path: string) => boolean = () => false) {
  const files = new Map<string, Buffer>();
  const client = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                text: async () => buf.toString("utf8"),
                arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer) {
            if (failUpload(path)) return { error: { message: "storage 503" } };
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, files };
}

function clip(jobId: string): GenerativeAsset {
  const buffer = Buffer.alloc(64);
  buffer.write("ftyp", 4, "ascii");
  return { buffer, mimeType: "video/mp4", extension: "mp4", durationSeconds: 8, model: "veo-fake", costUsd: 0.96, providerJobId: jobId };
}

type Step = (request: VideoGenerationRequest, accept: (jobId: string) => Promise<void>) => Promise<GenerativeAsset>;

/** Proveedor con la semántica de Veo: "submit" = aceptar la operación (onProviderJobAccepted); resumeGeneration nunca reenvía. */
function veoLike(generateSteps: Step[], resumeSteps: Array<(jobId: string) => Promise<GenerativeAsset>> = []) {
  const counts = { generateCalls: 0, submits: 0, resumes: 0 };
  const provider: VideoProvider = {
    name: "veo",
    capabilities: { id: "veo", models: ["veo"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(request) {
      const step = generateSteps[counts.generateCalls++] ?? generateSteps[generateSteps.length - 1];
      return step(request, async (jobId) => {
        counts.submits += 1;
        await request.onProviderJobAccepted?.(jobId);
      });
    },
    async resumeGeneration(jobId) {
      const step = resumeSteps[counts.resumes++] ?? (async (id: string) => clip(id));
      return step(jobId);
    },
  };
  return { provider, counts };
}

const request = (shotId: string): VideoGenerationRequest => ({
  prompt: "p",
  aspectRatio: "16:9",
  durationSeconds: 8,
  maxCostUsd: 1,
  referenceImageUrl: "memory://ref",
  metadata: { shotId },
});

const wrap = (inner: VideoProvider, supabase: unknown, extra: Partial<Parameters<typeof wrapDurableVideoProvider>[1]> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapDurableVideoProvider(inner, { supabase: supabase as any, scopeId: "req-1", resumeBackoffMs: 0, ...extra });

test("A. fallo ANTES de que el proveedor acepte (sin operación) → el reintento puede enviar una vez", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async () => {
      throw new GenerativeProviderError("red caída antes del envío", "veo", "upstream_error");
    },
    async (_r, accept) => {
      await accept("op-A");
      return clip("op-A");
    },
  ]);
  await assert.rejects(wrap(provider, storage.client).generateVideo(request("s1")));
  assert.equal(counts.submits, 0);
  await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(counts.submits, 1);
});

test("B. operación aceptada + providerJobId persistido + el worker muere → el reintento SONDEA la misma operación, no reenvía", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-B");
      throw new Error("worker killed (SIGKILL simulado) mientras sondeaba");
    },
  ]);
  await assert.rejects(wrap(provider, storage.client).generateVideo(request("s1")));
  const record = await readAiVideoClipRecord(storage.client, AI_VIDEO_STORAGE_BUCKET, "req-1", "s1");
  assert.equal(record?.status, "STARTED");
  assert.equal(record?.providerJobId, "op-B");
  const asset = await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(asset.providerJobId, "op-B");
  assert.deepEqual(counts, { generateCalls: 1, submits: 1, resumes: 1 });
});

test("C. sondeo con 503 → reanudación acotada de la MISMA operación dentro del intento", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike(
    [
      async (_r, accept) => {
        await accept("op-C");
        throw new GenerativeProviderError("HTTP 503 al consultar", "veo", "upstream_error", undefined, "op-C");
      },
    ],
    [
      async () => {
        throw new GenerativeProviderError("HTTP 503 otra vez", "veo", "upstream_error", undefined, "op-C");
      },
      async (id) => clip(id),
    ],
  );
  const asset = await wrap(provider, storage.client, { maxInAttemptResumes: 2 }).generateVideo(request("s1"));
  assert.equal(asset.providerJobId, "op-C");
  assert.deepEqual(counts, { generateCalls: 1, submits: 1, resumes: 2 });
});

test("C'. reanudaciones agotadas → error visible (nunca silencioso), STARTED conservado, sin reenvío", async () => {
  const storage = makeStorage();
  const fail503 = async () => {
    throw new GenerativeProviderError("HTTP 503", "veo", "upstream_error", undefined, "op-C2");
  };
  const { provider, counts } = veoLike(
    [
      async (_r, accept) => {
        await accept("op-C2");
        throw new GenerativeProviderError("HTTP 503", "veo", "upstream_error", undefined, "op-C2");
      },
    ],
    [fail503, fail503, fail503],
  );
  await assert.rejects(wrap(provider, storage.client, { maxInAttemptResumes: 2 }).generateVideo(request("s1")), /503/);
  assert.equal(counts.submits, 1);
  assert.equal(counts.resumes, 2, "acotado: nunca reintento infinito");
  assert.equal((await readAiVideoClipRecord(storage.client, AI_VIDEO_STORAGE_BUCKET, "req-1", "s1"))?.providerJobId, "op-C2");
});

test("D. el proveedor completó pero la descarga falla → el reintento descarga de la misma operación; NUNCA una generación nueva", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-D");
      throw new GenerativeProviderError("descarga HTTP 500", "veo", "download_failed", undefined, "op-D");
    },
  ]);
  await assert.rejects(wrap(provider, storage.client).generateVideo(request("s1")));
  const asset = await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(asset.providerJobId, "op-D");
  assert.equal(counts.submits, 1);
});

test("E. Storage falla al guardar el clip → se usa el buffer en memoria; el reintento reanuda (no reenvía) y el registro conserva el providerJobId", async () => {
  let storageDown = true;
  const storage = makeStorage((path) => storageDown && path.includes("/ai-video/") && path.endsWith(".mp4"));
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-E");
      return clip("op-E");
    },
  ]);
  const first = await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(first.providerJobId, "op-E");
  const record = await readAiVideoClipRecord(storage.client, AI_VIDEO_STORAGE_BUCKET, "req-1", "s1");
  assert.equal(record?.status, "STARTED");
  assert.equal(record?.providerJobId, "op-E", "el STARTED previo a la subida conserva el id — antes de esta fase se perdía");
  storageDown = false;
  await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(counts.submits, 1);
  assert.equal(counts.resumes, 1);
  assert.equal((await readAiVideoClipRecord(storage.client, AI_VIDEO_STORAGE_BUCKET, "req-1", "s1"))?.status, "COMPLETED");
});

test("F. fallo TERMINAL del proveedor (moderación) → registro FAILED; el reintento nunca reenvía ni reanuda", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-F");
      throw new GenerativeProviderError("rechazado por política", "veo", "moderation_rejected", undefined, "op-F");
    },
  ]);
  await assert.rejects(wrap(provider, storage.client, { maxInAttemptResumes: 2 }).generateVideo(request("s1")));
  assert.equal((await readAiVideoClipRecord(storage.client, AI_VIDEO_STORAGE_BUCKET, "req-1", "s1"))?.status, "FAILED");
  await assert.rejects(wrap(provider, storage.client).generateVideo(request("s1")), GenerativeProviderError);
  assert.deepEqual(counts, { generateCalls: 1, submits: 1, resumes: 0 });
});

test("COMPLETED persistido → reuso con costo 0, cero llamadas al proveedor", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-R");
      return clip("op-R");
    },
  ]);
  await wrap(provider, storage.client).generateVideo(request("s1"));
  const reused = await wrap(provider, storage.client).generateVideo(request("s1"));
  assert.equal(reused.costUsd, 0);
  assert.deepEqual(counts, { generateCalls: 1, submits: 1, resumes: 0 });
});

test("presupuesto: sin reserva disponible (beforeSubmit=false) nunca se envía — budget_exceeded", async () => {
  const storage = makeStorage();
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      await accept("op-X");
      return clip("op-X");
    },
  ]);
  await assert.rejects(
    wrap(provider, storage.client, { beforeSubmit: async () => false }).generateVideo(request("s1")),
    (err: unknown) => err instanceof GenerativeProviderError && err.reason === "budget_exceeded",
  );
  assert.equal(counts.generateCalls, 0);
});

test("allocation del plan confirmado: envíos a Veo NUNCA > allocation, sumando varios intentos con fallos", async () => {
  const storage = makeStorage();
  const budgetStore = memoryBudgetStore();
  let n = 0;
  const { provider, counts } = veoLike([
    async (_r, accept) => {
      n += 1;
      await accept(`op-${n}`);
      if (n === 1) throw new Error("worker killed");
      return clip(`op-${n}`);
    },
  ]);
  const allocation = { maxAiImageGenerations: 10, maxAiVideoClips: 2, maxGenerativeUsd: 10 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = await ProductionBudget.open(budgetStore, allocation);
    const video = wrap(provider, storage.client, { beforeSubmit: () => budget.reserveAiVideoSubmit(0.96) });
    for (const shot of ["s1", "s2", "s3", "s4"]) {
      await video.generateVideo(request(shot)).catch(() => undefined);
    }
  }
  assert.ok(counts.submits <= allocation.maxAiVideoClips, `envíos=${counts.submits}`);
  assert.equal(budgetStore.current()?.used.aiVideoSubmits, counts.submits);
});
