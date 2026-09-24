/**
 * P2B — ejecución administrativa de UNA ÚNICA generación real de video vía
 * Google Veo 3.1 Fast, autorizada explícitamente por Hans para el shot
 * "Pillar Transport" (gobekli-tepe-ai-video-benchmark-v2-active).
 *
 * NUNCA es un endpoint público — es un script server-side, pensado para
 * correr donde exista VEO_API_KEY (hoy: solo configurada en Vercel, NO en
 * esta sesión de Claude Code, ver informe P2B). Requiere TODAS estas
 * condiciones simultáneamente, o aborta ANTES de llamar a Google:
 *
 *   1. P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true (autorización explícita de
 *      UN SOLO uso — nunca activada por defecto, nunca implícita por
 *      tener VEO_API_KEY configurada).
 *   2. La imagen de referencia aprobada existe en el repo, su checksum en
 *      disco coincide EXACTO con el registrado en la aprobación (Hans,
 *      P2B preparation) — nunca se sustituye por otra imagen.
 *   3. Cost Guard: costo estimado ($0.96) <= techo absoluto ($1.00,
 *      hardcodeado en este archivo, NO configurable por env var — nunca
 *      se autoriza un gasto mayor cambiando una variable de entorno).
 *   4. VEO_API_KEY configurada en ESTE proceso (providerConfigured).
 *   5. retries=0 — sin ninguna lógica de reintento; UN intento, cualquier
 *      resultado (éxito o fallo) termina la ejecución.
 *
 * LONG_FORM_AI_VIDEO_ENABLED se fuerza a "true" SOLO dentro de este
 * proceso (nunca el default real de producción, ver dry-run-ai-video-*.ts
 * de P1/P2A — mismo patrón ya establecido) — usuarios de producción NUNCA
 * obtienen acceso a AI Video por correr este script.
 *
 * Uso (server-side, con VEO_API_KEY y P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true
 * en el entorno):
 *   npx tsx scripts/execute-p2b-pillar-transport-veo.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.
process.env.LONG_FORM_AI_VIDEO_ENABLED = "true"; // SOLO este proceso — ver comentario de cabecera.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Techo ABSOLUTO autorizado por Hans para esta única generación — nunca configurable por env var, nunca elevado por ningún mecanismo. */
const ABSOLUTE_MAX_COST_USD = 1.0;
const RETRIES = 0;

type PreflightFailure = { check: string; detail: string };

async function main() {
  const { ACTIVE_BENCHMARK_SHOTS } = await import("../src/lib/video/long-form/ai-video-benchmark-v2-active");
  const { validateReferenceImageBuffer, computeReferenceImageChecksumSha256 } = await import("../src/lib/video/long-form/ai-video-reference-image");
  const { evaluateBenchmarkExecutionGate } = await import("../src/lib/video/long-form/ai-video-benchmark-execution-gate");
  const { veoVideoProvider, VEO_MODEL, VEO_DURATION_SECONDS_1080P, getVeoCostUsdPerSecond } = await import("../src/lib/providers/video-gen/veo");
  const { PILLAR_TRANSPORT_VEO_FINAL_PROMPT, PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS } = await import(
    "../src/lib/video/long-form/ai-video-provider-comparison"
  );
  const { buildVideoGenerationRequest } = await import("../src/lib/video/long-form/ai-video-prompt-builder");
  const { validateVideoAssetBuffer } = await import("../src/lib/video/long-form/ai-video-validation");
  const { buildAiVideoObservabilityRecord, logAiVideoObservabilityRecord } = await import("../src/lib/video/long-form/ai-video-observability");
  const { GenerativeProviderError } = await import("../src/lib/providers/types");

  console.log("=".repeat(72));
  console.log("[P2B] Ejecución administrativa de UNA generación real — Veo 3.1 Fast — Pillar Transport");
  console.log("=".repeat(72));

  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport");
  const approval = shot?.referenceImageSpec.approval;
  const failures: PreflightFailure[] = [];

  // --- Runtime pre-check: TODAS las condiciones, antes de tocar red. ---
  const explicitAuthorization = process.env.P2B_PILLAR_TRANSPORT_VEO_EXECUTE === "true";
  if (!explicitAuthorization) {
    failures.push({ check: "explicit_authorization", detail: "P2B_PILLAR_TRANSPORT_VEO_EXECUTE no es 'true' — ejecución de un solo uso no autorizada explícitamente para este proceso." });
  }

  if (!shot || !approval || shot.referenceImageSpec.status !== "approved") {
    failures.push({ check: "image_approved", detail: "El shot Pillar Transport no tiene una imagen de referencia con status='approved'." });
  }

  let imageBuffer: Buffer | undefined;
  if (approval) {
    const imagePath = join(__dirname, "..", approval.sourceImagePath);
    if (!existsSync(imagePath)) {
      failures.push({ check: "reference_image_exists", detail: `No se encontró el archivo de imagen de referencia en "${approval.sourceImagePath}".` });
    } else {
      imageBuffer = readFileSync(imagePath);
      const liveChecksum = computeReferenceImageChecksumSha256(imageBuffer);
      if (liveChecksum !== approval.checksumSha256) {
        failures.push({ check: "checksum_match", detail: `Checksum en disco (${liveChecksum}) NO coincide con el aprobado (${approval.checksumSha256}) — posible sustitución de la imagen.` });
      }
      const imgValidation = validateReferenceImageBuffer(imageBuffer, "image/png");
      if (!imgValidation.valid) {
        failures.push({ check: "reference_image_valid", detail: imgValidation.reason });
      } else if (imgValidation.format !== "png") {
        failures.push({ check: "reference_image_format", detail: `formato inesperado: ${imgValidation.format}` });
      }
    }
  }

  const durationSeconds = VEO_DURATION_SECONDS_1080P;
  if (durationSeconds !== 8) failures.push({ check: "duration_8s", detail: `VEO_DURATION_SECONDS_1080P=${durationSeconds}, esperado 8.` });
  const aspectRatio = "16:9" as const;
  const estimatedCostUsd = Math.round(durationSeconds * getVeoCostUsdPerSecond() * 100) / 100;
  if (estimatedCostUsd !== 0.96) {
    failures.push({ check: "expected_cost", detail: `Costo estimado calculado ($${estimatedCostUsd}) distinto del esperado ($0.96) — configuración de precio pudo cambiar, revisar antes de continuar.` });
  }
  if (estimatedCostUsd > ABSOLUTE_MAX_COST_USD) {
    failures.push({ check: "cost_guard", detail: `Costo estimado ($${estimatedCostUsd}) excede el techo absoluto autorizado ($${ABSOLUTE_MAX_COST_USD}).` });
  }
  if (RETRIES !== 0) failures.push({ check: "retries_zero", detail: "RETRIES debe ser exactamente 0." });
  if (VEO_MODEL !== "veo-3.1-fast-generate-preview") {
    failures.push({ check: "model_correct", detail: `Modelo inesperado: ${VEO_MODEL}` });
  }

  const providerConfigured = veoVideoProvider.isAvailable();
  if (!providerConfigured) {
    failures.push({ check: "provider_configured", detail: "VEO_API_KEY no está configurada en ESTE proceso — isAvailable()=false." });
  }

  const gateDecision = evaluateBenchmarkExecutionGate({
    referenceImageStatus: shot?.referenceImageSpec.status ?? "not_generated",
    longFormAiVideoEnabled: true, // forzado solo en este proceso, ver cabecera.
    explicitBenchmarkExecutionMode: explicitAuthorization,
    costGuardAllowed: estimatedCostUsd <= ABSOLUTE_MAX_COST_USD,
    providerConfigured,
  });
  if (!gateDecision.allowed) {
    failures.push({ check: "execution_gate", detail: gateDecision.reasons.join(" | ") });
  }

  console.log("\n[RUNTIME PRE-CHECK]");
  console.log(`  P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true: ${explicitAuthorization ? "PASS" : "FAIL"}`);
  console.log(`  imagen aprobada + checksum coincide: ${failures.some((f) => ["image_approved", "checksum_match", "reference_image_exists", "reference_image_valid"].includes(f.check)) ? "FAIL" : "PASS"}`);
  console.log(`  aspectRatio=16:9, duration=8s, model=${VEO_MODEL}: ${failures.some((f) => ["duration_8s", "model_correct"].includes(f.check)) ? "FAIL" : "PASS"}`);
  console.log(`  costo estimado=$${estimatedCostUsd} <= techo absoluto=$${ABSOLUTE_MAX_COST_USD}: ${failures.some((f) => ["expected_cost", "cost_guard"].includes(f.check)) ? "FAIL" : "PASS"}`);
  console.log(`  retries=0: PASS`);
  console.log(`  VEO_API_KEY configurada en este proceso (providerConfigured): ${providerConfigured ? "PASS" : "FAIL"}`);
  console.log(`  Execution Gate (5 condiciones): ${gateDecision.allowed ? "PASS" : "FAIL"}`);

  if (failures.length > 0) {
    console.log("\n" + "=".repeat(72));
    console.log("[P2B] RUNTIME PRE-CHECK: FAIL — ABORTANDO SIN LLAMAR A GOOGLE.");
    for (const f of failures) console.log(`  - ${f.check}: ${f.detail}`);
    console.log("[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 0/1");
    console.log("=".repeat(72));
    process.exit(1);
  }

  console.log("\n[P2B] RUNTIME PRE-CHECK: PASS — procediendo con LA ÚNICA generación autorizada (retries=0, sin reintento posible).");

  const request = buildVideoGenerationRequest({
    visualIntent: PILLAR_TRANSPORT_VEO_FINAL_PROMPT,
    negativeSignals: PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS,
    referenceImageUrl: "PLACEHOLDER", // sobreescrito abajo — buildVideoGenerationRequest exige un valor no vacío si se pasa la clave.
    durationSeconds,
    aspectRatio,
    maxCostUsd: ABSOLUTE_MAX_COST_USD,
    metadata: { benchmarkId: shot!.benchmarkId, shotId: shot!.shotId, provider: "veo", historicalClassification: shot!.historicalClassification },
  });
  // La imagen de referencia se sirve desde el archivo YA validado del repo
  // (nunca una URL de terceros) — ver informe P2B, sección Storage: sirve
  // como fuente server-side mientras Supabase Storage real no está disponible.
  // Un servidor HTTP local (127.0.0.1) expone exactamente esos bytes para
  // que veo.ts los descargue tal cual haría con cualquier URL real.
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(imageBuffer!.byteLength) });
    res.end(imageBuffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  request.referenceImageUrl = `http://127.0.0.1:${port}/bench-v2-a-pillar-transport.png`;

  const startedAtMs = Date.now();
  const startedAtIso = new Date().toISOString();
  console.log(`\n[P2B] Llamando a Google Veo (${VEO_MODEL}) — inicio ${startedAtIso}...`);

  try {
    const asset = await veoVideoProvider.generateVideo(request);
    const generationTimeMs = Date.now() - startedAtMs;

    console.log(`\n[P2B] Google respondió con éxito. providerJobId=${asset.providerJobId}, generationTimeMs=${generationTimeMs}`);

    const validation = validateVideoAssetBuffer(asset.buffer, asset.mimeType, {
      durationSeconds: asset.durationSeconds,
      widthPx: asset.width,
      heightPx: asset.height,
    });
    console.log(`[P2B] Validación del clip: ${JSON.stringify(validation)}`);

    const outputDir = join(__dirname, "..", ".atomivid-state", "p2b-results");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `bench-v2-a-pillar-transport-veo-${Date.now()}.${asset.extension}`);
    writeFileSync(outputPath, asset.buffer);
    console.log(`[P2B] Clip guardado localmente en: ${outputPath} (Supabase Storage real no disponible en este proceso — ver informe, sección Storage).`);

    const observability = buildAiVideoObservabilityRecord({
      provider: "veo",
      model: asset.model,
      shotId: shot!.shotId,
      providerJobId: asset.providerJobId,
      executionMode: "real",
      generationTimeMs,
      clipDurationSeconds: asset.durationSeconds,
      estimatedCostUsd,
      actualCostUsd: asset.costUsd,
      retryCount: 0,
      validationResult: validation.valid ? "valid" : "invalid",
    });
    logAiVideoObservabilityRecord(observability);

    console.log("\n" + "=".repeat(72));
    console.log("[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 1/1");
    console.log(`[P2B] SUCCESSFUL REAL VIDEO GENERATIONS: ${validation.valid ? "1/1" : "0/1 (generó, pero no pasó validación)"}`);
    console.log(`[P2B] ACTUAL COST: $${asset.costUsd}`);
    console.log("=".repeat(72));
  } catch (err) {
    const generationTimeMs = Date.now() - startedAtMs;
    console.log("\n" + "=".repeat(72));
    console.log("[P2B] FALLO en la generación real — NO se reintenta.");
    if (err instanceof GenerativeProviderError) {
      console.log(`  reason: ${err.reason}`);
      console.log(`  providerId: ${err.providerId}`);
      console.log(`  message (sanitizado, sin secretos): ${err.message}`);
    } else {
      console.log(`  error no tipado: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`  generationTimeMs: ${generationTimeMs}`);
    console.log("[P2B] REAL VIDEO GENERATIONS ATTEMPTED: 1/1");
    console.log("[P2B] SUCCESSFUL REAL VIDEO GENERATIONS: 0/1");
    console.log("=".repeat(72));
    process.exit(1);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[P2B] fallo inesperado del script:", err);
  process.exit(1);
});
