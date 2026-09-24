import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVisualTestV2Manifest,
  computeIdempotencyKey,
  shouldGenerate,
  toImageGenerationRequest,
  VIDEO_001_VISUAL_STYLE,
  VISUAL_TEST_V2_MAX_USD,
} from "./visual-test-v2";

test("buildVisualTestV2Manifest produce exactamente 3 shots, los seleccionados en el handoff", () => {
  const manifest = buildVisualTestV2Manifest();
  assert.equal(manifest.videoId, "gobekli-tepe-001");
  assert.equal(manifest.shots.length, 3);
  assert.deepEqual(
    manifest.shots.map((s) => s.shotId),
    ["b1-s4", "b4-s2", "b8-s5"],
  );
});

test("buildVisualTestV2Manifest: el costo estimado total no excede el tope autorizado ($0.50)", () => {
  const manifest = buildVisualTestV2Manifest();
  assert.equal(manifest.maxTotalUsd, VISUAL_TEST_V2_MAX_USD);
  assert.ok(manifest.estimatedTotalUsd <= manifest.maxTotalUsd, `estimado ${manifest.estimatedTotalUsd} debe ser <= ${manifest.maxTotalUsd}`);
  assert.equal(manifest.estimatedTotalUsd, 0.15);
});

test("cada shot trae model=gpt-image-2, size=1536x1024 (16:9), quality=medium, aspectRatio=16:9", () => {
  const manifest = buildVisualTestV2Manifest();
  for (const shot of manifest.shots) {
    assert.equal(shot.model, "gpt-image-2");
    assert.equal(shot.size, "1536x1024");
    assert.equal(shot.quality, "medium");
    assert.equal(shot.aspectRatio, "16:9");
  }
});

test("computeIdempotencyKey es determinístico: la misma entrada produce siempre la misma clave", () => {
  const input = { shotId: "x", model: "gpt-image-2", size: "1536x1024", quality: "medium", prompt: "p", negativePrompt: "n" };
  assert.equal(computeIdempotencyKey(input), computeIdempotencyKey({ ...input }));
});

test("computeIdempotencyKey cambia si cambia CUALQUIER campo (prompt, negativo, tamaño, calidad, modelo)", () => {
  const base = { shotId: "x", model: "gpt-image-2", size: "1536x1024", quality: "medium", prompt: "p", negativePrompt: "n" };
  const baseKey = computeIdempotencyKey(base);
  assert.notEqual(computeIdempotencyKey({ ...base, prompt: "p2" }), baseKey);
  assert.notEqual(computeIdempotencyKey({ ...base, negativePrompt: "n2" }), baseKey);
  assert.notEqual(computeIdempotencyKey({ ...base, size: "1024x1536" }), baseKey);
  assert.notEqual(computeIdempotencyKey({ ...base, quality: "high" }), baseKey);
  assert.notEqual(computeIdempotencyKey({ ...base, model: "gpt-image-3" }), baseKey);
});

test("outputPath de cada shot incluye su idempotencyKey — cambiar el prompt cambiaría el path, nunca sobrescribe en silencio", () => {
  const manifest = buildVisualTestV2Manifest();
  for (const shot of manifest.shots) {
    assert.ok(shot.outputPath.includes(shot.idempotencyKey));
  }
});

test("shouldGenerate: true si el archivo de salida no existe todavía", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-visual-test-v2-"));
  try {
    const manifest = buildVisualTestV2Manifest(dir);
    for (const shot of manifest.shots) {
      assert.equal(shouldGenerate(shot), true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("los 3 prompts finales comparten el bloque de estilo (misma serie visual) pero difieren en el texto de escena", () => {
  const manifest = buildVisualTestV2Manifest();
  for (const shot of manifest.shots) {
    assert.ok(shot.prompt.includes(VIDEO_001_VISUAL_STYLE.cinematography));
    assert.ok(shot.prompt.includes(VIDEO_001_VISUAL_STYLE.colorTreatment));
    assert.ok(shot.negativePrompt.includes(VIDEO_001_VISUAL_STYLE.sharedNegative));
  }
  const prompts = manifest.shots.map((s) => s.prompt);
  assert.equal(new Set(prompts).size, 3, "los 3 prompts deben ser distintos entre sí (texto de escena distinto)");
});

test("toImageGenerationRequest produce el objeto exacto que espera ImageProvider.generateImage()", () => {
  const manifest = buildVisualTestV2Manifest();
  const req = toImageGenerationRequest(manifest.shots[0]);
  assert.equal(req.prompt, manifest.shots[0].prompt);
  assert.equal(req.negativePrompt, manifest.shots[0].negativePrompt);
  assert.equal(req.aspectRatio, "16:9");
  assert.equal(req.maxCostUsd, VISUAL_TEST_V2_MAX_USD);
});

test("shouldGenerate: false si el archivo YA existe en el path derivado — nunca se regenera/re-cobra el mismo shot+parámetros", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-visual-test-v2-"));
  try {
    const manifest = buildVisualTestV2Manifest(dir);
    const [first, ...rest] = manifest.shots;
    writeFileSync(first.outputPath, "contenido de prueba");
    assert.equal(shouldGenerate(first), false);
    for (const shot of rest) {
      assert.equal(shouldGenerate(shot), true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
