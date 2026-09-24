import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";
import {
  resolveAiVideoForShot,
  resolveAiVideoForShots,
  AiVideoProductionFixtureError,
} from "./ai-video-resolver";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "./ai-video-cost-guard";

const ENV_KEYS = [
  "LONG_FORM_AI_VIDEO_ENABLED",
  "LONG_FORM_AI_VIDEO_COST_PRESET",
  "AI_VIDEO_BUDGET_PERCENT",
  "MAX_AI_VIDEO_SECONDS",
  "MAX_AI_VIDEO_CLIPS",
  "MAX_ESTIMATED_VIDEO_COST_USD",
  "AI_VIDEO_COST_PER_SECOND_USD",
  "AI_IMAGE_MOTION_COST_PER_SECOND_USD",
];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fakeMp4Buffer(): Buffer {
  const buf = Buffer.alloc(64);
  buf.write("ftyp", 4, "ascii");
  return buf;
}

function makeCountingProvider(name: string, behavior: "succeed" | "moderation" | "invalid" | "throw-generic"): { provider: VideoProvider; getCallCount: () => number } {
  let callCount = 0;
  const provider: VideoProvider = {
    name,
    capabilities: { id: name, models: ["test-model"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable() {
      return true;
    },
    async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
      callCount++;
      if (behavior === "moderation") {
        throw new GenerativeProviderError("rechazado por moderación", name, "moderation_rejected");
      }
      if (behavior === "throw-generic") {
        throw new Error("network exploded");
      }
      if (behavior === "invalid") {
        return {
          buffer: Buffer.from("not a real video file", "utf8"),
          mimeType: "video/mp4",
          extension: "mp4",
          durationSeconds: request.durationSeconds,
          model: "test-model",
          costUsd: 0.05,
        };
      }
      return {
        buffer: fakeMp4Buffer(),
        mimeType: "video/mp4",
        extension: "mp4",
        durationSeconds: request.durationSeconds,
        width: 1920,
        height: 1080,
        model: "test-model",
        costUsd: 0.05,
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

const HIGH_MOTION_SHOT = { id: "s1", visualIntent: "people building a structure, carrying stones, working together", durationSec: 5 };
const LOW_MOTION_SHOT = { id: "s2", visualIntent: "a static archival photograph of an inscription", durationSec: 4 };

test("1. VideoProvider contract: el fixture cumple la interfaz completa (name/capabilities/isAvailable/generateVideo) y produce un resultado normalizado", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("fixture-like", "succeed");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "generated");
    if (outcome.status === "generated") {
      assert.equal(outcome.clip.shotId, "s1");
      assert.ok(outcome.clip.buffer.byteLength > 0);
      assert.equal(outcome.clip.provider, "fixture-like");
    }
  });
});

test("2. shot NO elegible (bajo score) nunca llama al proveedor — se salta con el fallback recomendado", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider, getCallCount } = makeCountingProvider("test", "succeed");
    const outcome = await resolveAiVideoForShot({
      shot: LOW_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(getCallCount(), 0);
    if (outcome.status === "skipped") assert.equal(outcome.recommendedFallback, "ai_image");
  });
});

test("3. feature flag OFF (default) rechaza TODO, incluso un shot con score alto — cero llamadas al proveedor", async () => {
  await withEnv({}, async () => {
    const { provider, getCallCount } = makeCountingProvider("test", "succeed");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(getCallCount(), 0);
    if (outcome.status === "skipped") assert.match(outcome.reason, /LONG_FORM_AI_VIDEO_ENABLED=false/);
  });
});

test("4. cost guard rechaza por presupuesto (Cost Guard: Budget rejection) — nunca llama al proveedor", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", MAX_ESTIMATED_VIDEO_COST_USD: "0.001" }, async () => {
    const { provider, getCallCount } = makeCountingProvider("test", "succeed");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(getCallCount(), 0);
    if (outcome.status === "skipped") assert.match(outcome.reason, /MAX_ESTIMATED_VIDEO_COST_USD/);
  });
});

test("5. fallo del proveedor (moderación) nunca se finge como éxito — se registra el motivo y se recomienda el fallback permitido", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider, getCallCount } = makeCountingProvider("test", "moderation");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(getCallCount(), 1);
    if (outcome.status === "skipped") {
      assert.match(outcome.reason, /moderation_rejected/);
      assert.equal(outcome.recommendedFallback, "ai_image_motion");
    }
  });
});

test("6. un error NO tipado (crash genuino, no un fallo normalizado del proveedor) SIGUE lanzando — nunca se traga silenciosamente", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("test", "throw-generic");
    await assert.rejects(
      () =>
        resolveAiVideoForShot({
          shot: HIGH_MOTION_SHOT,
          totalDocumentaryDurationSec: 1000,
          ledger: emptyAiVideoLedgerState(),
          videoProvider: provider,
          aspectRatio: "16:9",
        }),
      /network exploded/,
    );
  });
});

test("7. producción (requireReal=true) NUNCA acepta un resultado del proveedor 'fixture' en silencio — lanza", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("fixture", "succeed");
    await assert.rejects(
      () =>
        resolveAiVideoForShot({
          shot: HIGH_MOTION_SHOT,
          totalDocumentaryDurationSec: 1000,
          ledger: emptyAiVideoLedgerState(),
          videoProvider: provider,
          aspectRatio: "16:9",
          requireReal: true,
        }),
      AiVideoProductionFixtureError,
    );
  });
});

test("7b. simulation (requireReal=false/ausente) SÍ acepta el proveedor 'fixture' normalmente", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("fixture", "succeed");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "generated");
  });
});

test("8. un archivo inválido devuelto por el proveedor se rechaza (validación) — nunca se acepta como generado", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("test", "invalid");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
    });
    assert.equal(outcome.status, "skipped");
    if (outcome.status === "skipped") assert.match(outcome.reason, /inválido/);
  });
});

test("9. resolveAiVideoForShots procesa un lote respetando generationPriority y acumula el ledger entre shots", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true", MAX_AI_VIDEO_CLIPS: "1" }, async () => {
    const { provider, getCallCount } = makeCountingProvider("test", "succeed");
    const shots = [
      { ...HIGH_MOTION_SHOT, id: "low-priority", generationPriority: 5 },
      { ...HIGH_MOTION_SHOT, id: "high-priority", generationPriority: 1 },
    ];
    const result = await resolveAiVideoForShots(
      shots,
      { totalDocumentaryDurationSec: 1000, videoProvider: provider, aspectRatio: "16:9" },
      emptyAiVideoLedgerState(),
    );
    // MAX_AI_VIDEO_CLIPS=1 -> solo el primero en orden de prioridad se genera, el segundo se salta por presupuesto.
    assert.equal(getCallCount(), 1);
    assert.equal(result.outcomes[0].shotId, "high-priority");
    assert.equal(result.outcomes[0].status, "generated");
    assert.equal(result.outcomes[1].shotId, "low-priority");
    assert.equal(result.outcomes[1].status, "skipped");
    assert.equal(result.finalLedger.usedClips, 1);
  });
});

test("10. costConfig explícito (preset 'economic') se respeta en vez del default", async () => {
  await withEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { provider } = makeCountingProvider("test", "succeed");
    const economicConfig = getAiVideoCostConfig("economic");
    const outcome = await resolveAiVideoForShot({
      shot: HIGH_MOTION_SHOT,
      totalDocumentaryDurationSec: 1000,
      ledger: emptyAiVideoLedgerState(),
      videoProvider: provider,
      aspectRatio: "16:9",
      costConfig: economicConfig,
    });
    assert.equal(outcome.status, "generated");
  });
});
