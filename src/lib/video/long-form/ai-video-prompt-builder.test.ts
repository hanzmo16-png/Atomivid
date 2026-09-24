import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVideoGenerationRequest } from "./ai-video-prompt-builder";

test("compone prompt con visualIntent + motion + contexto, en orden estable", () => {
  const request = buildVideoGenerationRequest({
    visualIntent: "people building a structure",
    motionDescription: "slow push-in, handheld",
    contextNotes: ["Pre-Pottery Neolithic era", "no modern elements"],
    durationSeconds: 5,
    aspectRatio: "16:9",
    maxCostUsd: 0.5,
  });
  assert.equal(
    request.prompt,
    "people building a structure. Motion: slow push-in, handheld. Pre-Pottery Neolithic era. no modern elements",
  );
});

test("sin motionDescription/contextNotes, el prompt es solo visualIntent", () => {
  const request = buildVideoGenerationRequest({
    visualIntent: "a wide landscape shot",
    durationSeconds: 4,
    aspectRatio: "9:16",
    maxCostUsd: 0.2,
  });
  assert.equal(request.prompt, "a wide landscape shot");
  assert.equal(request.negativePrompt, undefined);
});

test("negativeSignals se combinan en negativePrompt; ausente si la lista está vacía", () => {
  const withNegatives = buildVideoGenerationRequest({
    visualIntent: "x",
    negativeSignals: ["text overlay", "watermark", ""],
    durationSeconds: 3,
    aspectRatio: "16:9",
    maxCostUsd: 0.1,
  });
  assert.equal(withNegatives.negativePrompt, "text overlay, watermark");

  const withoutNegatives = buildVideoGenerationRequest({
    visualIntent: "x",
    negativeSignals: [],
    durationSeconds: 3,
    aspectRatio: "16:9",
    maxCostUsd: 0.1,
  });
  assert.equal(withoutNegatives.negativePrompt, undefined);
});

test("aspectRatio/durationSeconds/maxCostUsd pasan sin transformar al VideoGenerationRequest", () => {
  const request = buildVideoGenerationRequest({
    visualIntent: "x",
    durationSeconds: 7.5,
    aspectRatio: "16:9",
    maxCostUsd: 1.23,
  });
  assert.equal(request.durationSeconds, 7.5);
  assert.equal(request.aspectRatio, "16:9");
  assert.equal(request.maxCostUsd, 1.23);
});

test("referenceImageUrl/seed/metadata solo aparecen cuando se pasan (nunca undefined explícito en el objeto)", () => {
  const withExtras = buildVideoGenerationRequest({
    visualIntent: "x",
    durationSeconds: 3,
    aspectRatio: "16:9",
    maxCostUsd: 0.1,
    referenceImageUrl: "https://example/img.png",
    seed: "seed-1",
    metadata: { shotId: "b2-s3" },
  });
  assert.equal(withExtras.referenceImageUrl, "https://example/img.png");
  assert.equal(withExtras.seed, "seed-1");
  assert.deepEqual(withExtras.metadata, { shotId: "b2-s3" });

  const withoutExtras = buildVideoGenerationRequest({
    visualIntent: "x",
    durationSeconds: 3,
    aspectRatio: "16:9",
    maxCostUsd: 0.1,
  });
  assert.equal("referenceImageUrl" in withoutExtras, false);
  assert.equal("seed" in withoutExtras, false);
  assert.equal("metadata" in withoutExtras, false);
});

test("visualIntent vacío lanza — nunca compone un prompt vacío", () => {
  assert.throws(
    () => buildVideoGenerationRequest({ visualIntent: "   ", durationSeconds: 3, aspectRatio: "16:9", maxCostUsd: 0.1 }),
    /visualIntent vacío/,
  );
});

test("durationSeconds <= 0 lanza", () => {
  assert.throws(
    () => buildVideoGenerationRequest({ visualIntent: "x", durationSeconds: 0, aspectRatio: "16:9", maxCostUsd: 0.1 }),
    /durationSeconds inválido/,
  );
  assert.throws(
    () => buildVideoGenerationRequest({ visualIntent: "x", durationSeconds: -1, aspectRatio: "16:9", maxCostUsd: 0.1 }),
    /durationSeconds inválido/,
  );
});

test("la narración NO aparece en el prompt visual (se DICE, no necesariamente se MUESTRA)", () => {
  const request = buildVideoGenerationRequest({
    narration: "Este es el texto narrado que el espectador escucha",
    visualIntent: "a wide landscape shot",
    durationSeconds: 3,
    aspectRatio: "16:9",
    maxCostUsd: 0.1,
  });
  assert.equal(request.prompt.includes("narrado"), false);
});
