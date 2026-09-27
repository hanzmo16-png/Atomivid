import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SAMPLE_HARD_PER_SAMPLE_USD, SAMPLE_HARD_TOTAL_USD, estimateSample, parseSampleManifest, resolveCaps, sampleBudgetDecision } from "./sample-plan";
import { voiceCostUsd } from "./paid-costs";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const manifest = parseSampleManifest(JSON.parse(readFileSync(path.join(ROOT, "docs/quality/audiovisual-samples/manifest.json"), "utf8")));
const rates = { imageTypicalUsd: 0.0558, voiceTypicalUsd: voiceCostUsd, scriptTypicalUsd: 0.03 };

test("muestras: topes duros US$1 total (autorizado) y US$0,75 por muestra; las entradas solo pueden bajarlos", () => {
  assert.deepEqual(resolveCaps({}), { totalUsd: 1, perSampleUsd: 0.75 });
  assert.deepEqual(resolveCaps({ totalUsd: "0.90", perSampleUsd: "0.5" }), { totalUsd: 0.9, perSampleUsd: 0.5 });
  assert.throws(() => resolveCaps({ totalUsd: "1.01" }), /supera el máximo/);
  assert.throws(() => resolveCaps({ totalUsd: "3.50" }), /supera el máximo/, "la propuesta original no está autorizada");
  assert.throws(() => resolveCaps({ perSampleUsd: "0.80" }), /supera el máximo/);
  assert.throws(() => resolveCaps({ totalUsd: "-1" }), /inválido/);
});

test("muestras: el peor caso de cada muestra cabe en su tope y la primera tanda cabe en el total autorizado aun con los US$0,08 inciertos", () => {
  assert.equal(manifest.samples.length, 6);
  const estimates = manifest.samples.map((s) => estimateSample(s, rates));
  for (const e of estimates) assert.ok(e.reserveUsd <= SAMPLE_HARD_PER_SAMPLE_USD, `${e.id}: ${e.reserveUsd}`);
  const firstBatch = estimates.filter((e) => e.id === "horror" || e.id === "comic-mystery").reduce((a, e) => a + e.reserveUsd, 0);
  assert.ok(0.08 + firstBatch <= SAMPLE_HARD_TOTAL_USD, `0,08 + ${firstBatch}`);
  // Las seis NO caben en US$1: requieren una nueva autorización.
  assert.ok(estimates.reduce((a, e) => a + e.reserveUsd, 0) > SAMPLE_HARD_TOTAL_USD);
  assert.equal(estimates.find((e) => e.id === "comic-mystery")!.images, 6);
  assert.equal(estimates.find((e) => e.id === "horror")!.images, 0);
});

test("muestras: el acumulado entre reintentos y muestras limita el tope efectivo; sin margen suficiente no se arranca", () => {
  const caps = { totalUsd: 3.5, perSampleUsd: 0.75 };
  const est = estimateSample(manifest.samples.find((s) => s.id === "anime")!, rates);
  const fresh = sampleBudgetDecision({ caps, committedBySample: {}, sampleId: "anime", estimate: est });
  assert.equal(fresh.start, true);
  assert.equal(fresh.effectiveCapUsd, 0.75);
  const tight = sampleBudgetDecision({ caps, committedBySample: { horror: 1.5, "comic-mystery": 1.4 }, sampleId: "anime", estimate: est });
  assert.equal(tight.effectiveCapUsd, 0.6);
  assert.equal(tight.start, est.reserveUsd <= 0.6);
  const exhausted = sampleBudgetDecision({ caps, committedBySample: { horror: 3.2 }, sampleId: "anime", estimate: est });
  assert.equal(exhausted.start, false);
  // Una muestra con gasto previo (reintento) puede continuar: reutiliza lo pagado y el registro aplica el tope por operación.
  assert.equal(sampleBudgetDecision({ caps, committedBySample: { anime: 0.4 }, sampleId: "anime", estimate: est }).start, true);
});

test("workflow de muestras: por defecto no gasta; las claves de pago solo existen con mode=run y confirm=GASTAR", () => {
  const yml = readFileSync(path.join(ROOT, ".github/workflows/audiovisual-samples.yml"), "utf8");
  assert.match(yml, /default: plan/);
  assert.match(yml, /workflow_dispatch:/);
  assert.ok(!/\n  (push|pull_request|schedule):/.test(yml), "solo disparo manual");
  for (const key of ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY"]) {
    assert.match(yml, new RegExp(`${key}: \\$\\{\\{ inputs\\.mode == 'run' && inputs\\.confirm == 'GASTAR' && secrets\\.${key} \\|\\| '' \\}\\}`));
  }
  assert.match(yml, /SAMPLE_ALLOW_PAID: \$\{\{ inputs\.mode == 'run' && inputs\.confirm == 'GASTAR' && 'true' \|\| 'false' \}\}/);
  const runner = readFileSync(path.join(ROOT, "scripts/audiovisual-samples.ts"), "utf8");
  assert.match(runner, /process\.env\.SAMPLE_ALLOW_PAID !== "true"/);
  assert.match(runner, /if \(mode !== "run"\) \{/);
});
