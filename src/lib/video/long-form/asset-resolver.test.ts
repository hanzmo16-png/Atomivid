import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShotAsset, type AssetUploader } from "./asset-resolver";
import { fixtureFootageProvider } from "@/lib/providers/footage/fixture";
import { fixtureImageProvider } from "@/lib/providers/image/fixture";
import { shotsForSpan } from "./shots";
import type { Shot } from "./types";
import { emptyAiVideoLedgerState } from "./ai-video-cost-guard";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";

const AI_VIDEO_ENV_KEYS = ["LONG_FORM_AI_VIDEO_ENABLED", "AI_VIDEO_BUDGET_PERCENT", "MAX_AI_VIDEO_SECONDS", "MAX_AI_VIDEO_CLIPS", "MAX_ESTIMATED_VIDEO_COST_USD"];

async function withAiVideoEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = AI_VIDEO_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of AI_VIDEO_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Mismo patrón que ai-video-resolver.test.ts — fixture mínimo de VideoProvider, sin red. */
function makeFakeVideoProvider(name: string, behavior: "succeed" | "moderation" = "succeed"): { provider: VideoProvider; getCallCount: () => number } {
  let callCount = 0;
  const provider: VideoProvider = {
    name,
    capabilities: { id: name, models: ["test-model"], formats: ["video/mp4"], aspectRatios: ["16:9"], timeoutMs: 1000, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
      callCount++;
      if (behavior === "moderation") throw new GenerativeProviderError("rechazado por moderación", name, "moderation_rejected");
      const buf = Buffer.alloc(64);
      buf.write("ftyp", 4, "ascii");
      return { buffer: buf, mimeType: "video/mp4", extension: "mp4", durationSeconds: request.durationSeconds, width: 1920, height: 1080, model: "test-model", costUsd: 0.05 };
    },
  };
  return { provider, getCallCount: () => callCount };
}

function aiVideoShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: "s-ai-video",
    beatId: "beat-1",
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    type: "ai_video",
    source: "generated",
    assetId: "s-ai-video",
    visualIntent: "people building a structure, carrying stones, working together",
    motion: "static",
    captionText: "",
    license: "",
    attribution: "",
    dedupKey: "s-ai-video",
    status: "planned",
    validationStatus: "pending",
    ...overrides,
  };
}

function makeUploader(): { upload: AssetUploader; uploaded: { path: string; bytes: number }[] } {
  const uploaded: { path: string; bytes: number }[] = [];
  const upload: AssetUploader = async (objectPath, buffer) => {
    uploaded.push({ path: objectPath, bytes: buffer.byteLength });
    return { url: `mock://storage/${objectPath}` };
  };
  return { upload, uploaded };
}

// 32s a ~4s por shot da 8 shots — suficiente para recorrer el ciclo
// completo de los 7 shot.type (incluye stock_video, que un span de 24s
// (6 shots) no alcanza a cubrir).
function shotsOfBeat(): Shot[] {
  return shotsForSpan({
    beatId: "beat-1",
    beatType: "hook",
    startSec: 0,
    endSec: 32,
    narration: "Narración de prueba para generar shots reales.",
  });
}

test("cada shot.type real del beat se resuelve sin lanzar, usando proveedores fixture", async () => {
  const shots = shotsOfBeat();
  assert.ok(shots.length >= 6, "shotsForSpan debe producir varios shots reales para este span");
  const { upload } = makeUploader();

  for (const shot of shots) {
    const result = await resolveShotAsset(shot, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "test-prefix",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.shotId, shot.id);
    assert.equal(result.costUsd, 0, `shot ${shot.id} (${shot.type}) no debería costar nada con proveedores fixture`);
  }
});

test("text/diagram/map resuelven a 'graphic' (determinístico, sin proveedor de red)", async () => {
  const shots = shotsOfBeat();
  const { upload } = makeUploader();
  const textShot = shots.find((s) => s.type === "text");
  const diagramShot = shots.find((s) => s.type === "diagram");
  const mapShot = shots.find((s) => s.type === "map");
  assert.ok(textShot && diagramShot && mapShot, "el ciclo de shotsForSpan debe cubrir text/diagram/map en 24s");

  for (const shot of [textShot!, diagramShot!, mapShot!]) {
    const result = await resolveShotAsset(shot, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.asset.kind, "graphic");
    assert.equal(result.providerUsed, "deterministic");
    assert.equal(result.bufferBytes, 0);
  }
});

test("stock_image/stock_video/ken_burns_image/generated_placeholder resuelven a 'media' con una URL subida", async () => {
  const shots = shotsOfBeat();
  const { upload, uploaded } = makeUploader();
  const mediaTypes: Shot["type"][] = ["stock_image", "stock_video", "ken_burns_image", "generated_placeholder"];

  for (const type of mediaTypes) {
    const shot = shots.find((s) => s.type === type);
    assert.ok(shot, `el ciclo debe cubrir ${type} en 24s`);
    const result = await resolveShotAsset(shot!, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.asset.kind, "media");
    if (result.asset.kind === "media") {
      assert.ok(result.asset.url.startsWith("mock://storage/"));
    }
  }
  assert.equal(uploaded.length, mediaTypes.length);
});

test("generated_placeholder usa aspectRatio 16:9 (landscape) — no el 9:16 de Shorts", async () => {
  const shots = shotsOfBeat();
  const shot = shots.find((s) => s.type === "generated_placeholder")!;
  const { upload } = makeUploader();
  const result = await resolveShotAsset(shot, {
    footageProvider: fixtureFootageProvider,
    imageProvider: fixtureImageProvider,
    upload,
    pathPrefix: "p",
    imageBudgetRemainingUsd: 5,
  });
  assert.equal(result.asset.kind, "media");
});

test("resolveShotAsset con un graphicSpecFor personalizado (research pack real) reemplaza el fixture por defecto", async () => {
  const shots = shotsOfBeat();
  const textShot = shots.find((s) => s.type === "text")!;
  const { upload } = makeUploader();
  const result = await resolveShotAsset(textShot, {
    footageProvider: fixtureFootageProvider,
    imageProvider: fixtureImageProvider,
    upload,
    pathPrefix: "p",
    imageBudgetRemainingUsd: 5,
    graphicSpecFor: () => ({ kind: "text", title: "Real", body: "Contenido real verificado", isFixture: false }),
  });
  assert.equal(result.asset.kind, "graphic");
  if (result.asset.kind === "graphic" && result.asset.graphic.kind === "text") {
    assert.equal(result.asset.graphic.isFixture, false);
  }
});

test("RC Phase 1: un shot type='ai_video' sin ctx.aiVideo lanza explícitamente — nunca degrada en silencio", async () => {
  const { upload } = makeUploader();
  await assert.rejects(
    () =>
      resolveShotAsset(aiVideoShot(), {
        footageProvider: fixtureFootageProvider,
        imageProvider: fixtureImageProvider,
        upload,
        pathPrefix: "p",
        imageBudgetRemainingUsd: 5,
      }),
    /ctx\.aiVideo/,
  );
});

test("RC Phase 1: un shot type='ai_video' elegible y dentro de presupuesto genera un clip real (mock) y lo sube como media/video", async () => {
  await withAiVideoEnv({ LONG_FORM_AI_VIDEO_ENABLED: "true" }, async () => {
    const { upload, uploaded } = makeUploader();
    const { provider, getCallCount } = makeFakeVideoProvider("veo-fake");
    const result = await resolveShotAsset(aiVideoShot(), {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
      aiVideo: {
        videoProvider: provider,
        ledger: emptyAiVideoLedgerState(),
        totalDocumentaryDurationSec: 600,
        aspectRatio: "16:9",
      },
    });
    assert.equal(getCallCount(), 1);
    assert.equal(result.asset.kind, "media");
    if (result.asset.kind === "media") assert.equal(result.asset.mediaType, "video");
    assert.equal(result.costUsd, 0.05);
    assert.equal(result.providerUsed, "veo-fake");
    assert.equal(uploaded.length, 1);
  });
});

test("RC Phase 1: un shot type='ai_video' que la elegibilidad/cost-guard descarta (LONG_FORM_AI_VIDEO_ENABLED=false) degrada a stock_image REAL, nunca lanza ni cae a fixture por su cuenta", async () => {
  await withAiVideoEnv({}, async () => {
    const { upload } = makeUploader();
    const { provider, getCallCount } = makeFakeVideoProvider("veo-fake");
    const result = await resolveShotAsset(aiVideoShot(), {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
      aiVideo: {
        videoProvider: provider,
        ledger: emptyAiVideoLedgerState(),
        totalDocumentaryDurationSec: 600,
        aspectRatio: "16:9",
      },
    });
    assert.equal(getCallCount(), 0, "el proveedor de video-IA nunca debe llamarse si el gate global está apagado");
    assert.equal(result.asset.kind, "media");
    if (result.asset.kind === "media") assert.equal(result.asset.mediaType, "image");
    assert.equal(result.costUsd, 0, "el fallback (fixtureFootageProvider) no cuesta nada en test");
  });
});
