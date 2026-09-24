/**
 * AI Video Pipeline P2A — demuestra el Benchmark Suite de Göbekli Tepe de
 * punta a punta EN SIMULACIÓN:
 *
 *   Benchmark Manifest (5 shots) -> Eligibility -> Cost Guard ->
 *   VideoProvider (fixture, forzado) -> Validation -> Storage
 *   (Supabase fake en memoria) -> Evaluation record (pendiente) ->
 *   Observability
 *
 * y al final imprime la preparación de la PRIMERA generación real candidata
 * (sección 10 del encargo) — sin ejecutarla nunca.
 *
 * SIN llamar nunca a un proveedor real: usa EXPLÍCITAMENTE
 * `fixtureVideoProvider` (nunca `getVideoProvider()`/Runway), y un cliente
 * Supabase FALSO en memoria (nunca una URL/clave real) para el paso de
 * Storage — mismo criterio de seguridad que dry-run-ai-video-plan.ts (P1).
 * Forzar LONG_FORM_AI_VIDEO_ENABLED=true está acotado a este proceso.
 *
 * Uso: npx tsx scripts/dry-run-ai-video-benchmark.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.
process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";

/** Fake mínimo de SupabaseClient en memoria — mismo patrón que visual-test-v2-storage.test.ts. Nunca toca una red/proyecto real. */
function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
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
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function main() {
  const { fixtureVideoProvider } = await import("../src/lib/providers/video-gen/fixture");
  const { GOBEKLI_TEPE_BENCHMARK_MANIFEST, benchmarkShotToEligibilityInput } = await import(
    "../src/lib/video/long-form/ai-video-benchmark-manifest"
  );
  const { scoreAiVideoEligibilityBatch } = await import("../src/lib/video/long-form/ai-video-eligibility");
  const { estimateBenchmarkSuiteCost, getMaxBenchmarkBudgetUsd } = await import(
    "../src/lib/video/long-form/ai-video-benchmark-cost"
  );
  const { resolveAiVideoForShots } = await import("../src/lib/video/long-form/ai-video-resolver");
  const { emptyAiVideoLedgerState, getAiVideoCostConfig } = await import("../src/lib/video/long-form/ai-video-cost-guard");
  const { resolveAiVideoStorageAsset } = await import("../src/lib/video/long-form/ai-video-storage");
  const { createPendingEvaluationRecord, validateEvaluationRecord } = await import("../src/lib/video/long-form/ai-video-evaluation");
  const { buildAiVideoObservabilityRecord, logAiVideoObservabilityRecord } = await import(
    "../src/lib/video/long-form/ai-video-observability"
  );
  const { buildFirstGenerationPrep } = await import("../src/lib/video/long-form/ai-video-benchmark-first-generation");

  const manifest = GOBEKLI_TEPE_BENCHMARK_MANIFEST;
  const supabase = makeFakeSupabase();

  console.log("=".repeat(72));
  console.log(`[dry-run-ai-video-benchmark] ${manifest.benchmarkId} (v${manifest.version}) — SIMULATION ONLY`);
  console.log(`  ${manifest.shots.length} shots, video de referencia: ${manifest.createdForVideoId}`);
  console.log(`  proveedor: "${fixtureVideoProvider.name}" (forzado, nunca un proveedor real en este script)`);
  console.log("=".repeat(72));

  // --- 1. Eligibility ---
  const eligibilityInputs = manifest.shots.map(benchmarkShotToEligibilityInput);
  const eligibility = scoreAiVideoEligibilityBatch(eligibilityInputs);
  console.log("\n[1/5] Elegibilidad por shot (motor SIN modificar para este benchmark):");
  for (const e of eligibility) {
    const spec = manifest.shots.find((s) => s.shotId === e.shotId)!;
    const matches = e.recommendedAssetType === spec.expectedEligibility.recommendedAssetType && e.eligibilityScore >= spec.expectedEligibility.minScore;
    console.log(
      `  - ${e.shotId} (${spec.title}): score=${e.eligibilityScore.toFixed(2)} -> ${e.recommendedAssetType} ` +
        `[esperado ${spec.expectedEligibility.recommendedAssetType}, min ${spec.expectedEligibility.minScore}] ${matches ? "OK" : "MISMATCH"}`,
    );
  }

  // --- 2. Cost estimation (planeación, techo $15) ---
  const costModel = {
    provider: "runway",
    model: "gen4_turbo",
    costPerSecondUsd: getAiVideoCostConfig("balanced").aiVideoCostPerSecondUsd,
    verifiedAgainstPrimaryDocs: false,
  };
  const costEstimate = estimateBenchmarkSuiteCost(manifest.benchmarkId, manifest.shots, costModel);
  console.log("\n[2/5] Estimación de costo (PLANEACIÓN, no autorización de gasto):");
  console.log(`  modelo de costo: ${costModel.provider}/${costModel.model} @ $${costModel.costPerSecondUsd}/s (verificado contra doc primaria: ${costModel.verifiedAgainstPrimaryDocs})`);
  console.log(`  ${costEstimate.clipCount} clips, ${costEstimate.totalDurationSec}s totales`);
  console.log(`  costo total (sin reintentos): $${costEstimate.totalCostUsd.toFixed(4)}`);
  console.log(`  costo de UN reintento (peor caso): $${costEstimate.oneRetryCostUsd.toFixed(4)}`);
  console.log(`  PEOR CASO total: $${costEstimate.worstCaseCostUsd.toFixed(4)} de un techo de planeación de $${costEstimate.ceilingUsd} (MAX_BENCHMARK_BUDGET_USD=${getMaxBenchmarkBudgetUsd()}) -> dentro del techo: ${costEstimate.withinCeiling}`);

  // --- 3-5. Resolver (fixture) -> Storage (fake) -> Evaluation + Observability ---
  // Se compara contra la duración REAL de VIDEO #001 (756.448s, ya
  // producido — ver informe final de producción), no contra la suma de
  // los 5 shots del propio benchmark: el % del cost guard tiene sentido
  // frente a UN documental completo, nunca frente a un lote de prueba
  // aislado (eso distorsionaría el % artificialmente).
  const REFERENCE_DOCUMENTARY_DURATION_SEC = 756.448;
  const paramsWithoutShot = {
    totalDocumentaryDurationSec: REFERENCE_DOCUMENTARY_DURATION_SEC,
    videoProvider: fixtureVideoProvider,
    aspectRatio: "16:9" as const,
    costConfig: getAiVideoCostConfig("premium"), // presupuesto generoso: el objetivo aquí es demostrar la cadena, no el rechazo por presupuesto (eso ya se probó en P1).
    requireReal: false, // SIEMPRE false en este script.
  };
  const batch = await resolveAiVideoForShots(eligibilityInputs, paramsWithoutShot, emptyAiVideoLedgerState());

  console.log("\n[3-5/5] Resolución (fixture) -> Storage (Supabase fake en memoria) -> Evaluation + Observability:");
  for (const outcome of batch.outcomes) {
    const shotSpec = manifest.shots.find((s) => s.shotId === outcome.shotId)!;
    if (outcome.status !== "generated") {
      console.log(`  - ${outcome.shotId}: OMITIDO — ${outcome.reason}`);
      continue;
    }

    const idempotencyKey = `dryrun-${outcome.shotId}`;
    const asset = await resolveAiVideoStorageAsset(supabase, outcome.clip, {
      scopeId: manifest.benchmarkId,
      idempotencyKey,
      executionMode: "simulation",
    });

    const evaluation = createPendingEvaluationRecord({
      benchmarkId: manifest.benchmarkId,
      shotId: outcome.shotId,
      provider: outcome.clip.provider,
      model: outcome.clip.model,
      executionMode: "simulation",
    });
    evaluation.generationSuccess = true;
    evaluation.durationSeconds = outcome.clip.durationSeconds;
    evaluation.costUsd = outcome.clip.costUsd;
    validateEvaluationRecord(evaluation);

    const observability = buildAiVideoObservabilityRecord({
      provider: outcome.clip.provider,
      model: outcome.clip.model,
      benchmarkId: manifest.benchmarkId,
      shotId: outcome.shotId,
      providerJobId: outcome.clip.providerJobId,
      executionMode: "simulation",
      clipDurationSeconds: outcome.clip.durationSeconds,
      estimatedCostUsd: shotSpec ? costEstimate.perShot.find((p) => p.shotId === outcome.shotId)!.costUsd : 0,
      actualCostUsd: outcome.clip.costUsd,
      retryCount: 0,
      validationResult: "valid",
    });
    logAiVideoObservabilityRecord(observability);

    console.log(`  - ${outcome.shotId}: GENERADO (simulation) -> Storage: ${asset.bucket}/${asset.storagePath} (checksum ${asset.checksumSha256.slice(0, 12)}...) -> Evaluation: pendiente de revisión humana`);
  }

  // --- Primera generación real candidata (PREPARAR, no ejecutar) ---
  const prep = buildFirstGenerationPrep();
  console.log("\n" + "=".repeat(72));
  console.log(`[dry-run-ai-video-benchmark] PRIMERA GENERACIÓN REAL CANDIDATA (preparada, NO ejecutada): ${prep.shot.shotId} (${prep.shot.title})`);
  console.log(`  provider/model candidato: ${prep.candidateProvider}/${prep.candidateModel} (verificado contra doc primaria: ${prep.costEstimateVerified})`);
  console.log(`  duración: ${prep.shot.durationSec}s, aspectRatio: ${prep.shot.aspectRatio}`);
  console.log(`  costo estimado: $${prep.costEstimateUsd.toFixed(4)}`);
  console.log(`  prompt normalizado: "${prep.normalizedRequest.prompt}"`);
  console.log(`  negativePrompt: "${prep.normalizedRequest.negativePrompt ?? "(ninguno)"}"`);
  console.log(`  retry policy: ${prep.retryPolicy}`);
  console.log(`  fallback chain: ${prep.fallbackChain.join(" -> ") || "(ninguno)"}`);
  console.log(`  criterios de éxito:`);
  for (const c of prep.successCriteria) console.log(`    - ${c}`);
  console.log("\n  NO SE EJECUTÓ ninguna llamada real. 0 créditos consumidos. LONG_FORM_AI_VIDEO_ENABLED permanece false fuera de este proceso.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("[dry-run-ai-video-benchmark] fallo:", err);
  process.exit(1);
});
