/**
 * P2B PREPARATION — pre-flight completo de la imagen de referencia
 * APROBADA de "Pillar Transport" (gobekli-tepe-ai-video-benchmark-v2-active),
 * SIN llamar nunca a Google.
 *
 * Ejercita el código REAL (no una simulación separada):
 *   imagen aprobada (repo) -> validación (ai-video-reference-image.ts) ->
 *   servidor HTTP LOCAL sirviendo esos bytes exactos ->
 *   fetchReferenceImageAsGeminiImageObject() de veo.ts (la MISMA función
 *   que usaría una llamada real) -> VideoGenerationRequest normalizado ->
 *   Cost Guard ($0.96 vs techo autorizado $1.00 y techo del benchmark
 *   $15) -> Execution Gate (ai-video-benchmark-execution-gate.ts, 5
 *   condiciones, estado REAL de este proceso) -> destino de Storage.
 *
 * El servidor HTTP es 127.0.0.1 únicamente (nunca expuesto) y se apaga al
 * final del script — sirve solo para poder ejercitar
 * fetchReferenceImageAsGeminiImageObject() con una URL real sin depender
 * de credenciales de Supabase que no existen en este entorno.
 *
 * Uso: npx tsx scripts/preflight-p2b-reference-image.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_AUTHORIZED_COST_USD = 1.0;

async function main() {
  const { validateReferenceImageBuffer, computeReferenceImageChecksumSha256, referenceImageStoragePath, REFERENCE_IMAGE_STORAGE_BUCKET } =
    await import("../src/lib/video/long-form/ai-video-reference-image");
  const { ACTIVE_BENCHMARK_SHOTS, ACTIVE_BENCHMARK_ID } = await import("../src/lib/video/long-form/ai-video-benchmark-v2-active");
  const { fetchReferenceImageAsGeminiImageObject, VEO_MODEL, VEO_DURATION_SECONDS_1080P, getVeoCostUsdPerSecond, veoVideoProvider } = await import(
    "../src/lib/providers/video-gen/veo"
  );
  const { PILLAR_TRANSPORT_VEO_FINAL_PROMPT, PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS } = await import(
    "../src/lib/video/long-form/ai-video-provider-comparison"
  );
  const { buildVideoGenerationRequest } = await import("../src/lib/video/long-form/ai-video-prompt-builder");
  const { evaluateBenchmarkExecutionGate } = await import("../src/lib/video/long-form/ai-video-benchmark-execution-gate");
  const { getFeatureFlags } = await import("../src/lib/video/feature-flags");
  const { getMaxBenchmarkBudgetUsd } = await import("../src/lib/video/long-form/ai-video-benchmark-cost");

  console.log("=".repeat(72));
  console.log("[preflight-p2b-reference-image] P2B PREPARATION — SIN llamada a Google");
  console.log("=".repeat(72));

  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport");
  if (!shot) throw new Error("Shot Pillar Transport no encontrado en el benchmark activo.");
  const approval = shot.referenceImageSpec.approval;
  if (!approval || shot.referenceImageSpec.status !== "approved") {
    throw new Error("La imagen de referencia de Pillar Transport no está marcada como aprobada — aborta.");
  }

  // --- 1. Imagen aprobada -> validación real ---
  const imagePath = join(__dirname, "..", approval.sourceImagePath);
  const buffer = readFileSync(imagePath);
  const validation = validateReferenceImageBuffer(buffer, "image/png");
  console.log("\n[1/6] Validación de la imagen de referencia aprobada:");
  console.log(`  archivo: ${approval.sourceImagePath}`);
  console.log(`  tamaño: ${buffer.byteLength} bytes`);
  console.log(`  validación: ${JSON.stringify(validation)}`);
  if (!validation.valid) throw new Error(`Imagen inválida: ${validation.reason}`);
  const liveChecksum = computeReferenceImageChecksumSha256(buffer);
  const checksumMatches = liveChecksum === approval.checksumSha256;
  console.log(`  checksum coincide con el registrado en la aprobación: ${checksumMatches} (${liveChecksum.slice(0, 16)}...)`);
  if (!checksumMatches) throw new Error("El checksum de la imagen en disco no coincide con el registrado en la aprobación — abortando.");

  // --- 2. Canonical asset (destino de Storage, subida real NO ejecutada en este entorno) ---
  const canonicalPath = referenceImageStoragePath(shot.benchmarkId, shot.shotId, liveChecksum, "png");
  console.log("\n[2/6] Destino de Storage (canonical asset — subida REAL pendiente, sin credenciales en este entorno):");
  console.log(`  bucket: ${REFERENCE_IMAGE_STORAGE_BUCKET}`);
  console.log(`  path: ${canonicalPath}`);
  console.log(`  coincide con approval.canonicalStoragePath: ${canonicalPath === approval.canonicalStoragePath}`);

  // --- 3. Servidor HTTP LOCAL (127.0.0.1 únicamente) sirviendo la imagen real ---
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(buffer.byteLength) });
    res.end(buffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const localUrl = `http://127.0.0.1:${port}/bench-v2-a-pillar-transport.png`;

  let veoImageObject: { bytesBase64Encoded: string; mimeType: string };
  try {
    console.log("\n[3/6] Ejercitando el código REAL de veo.ts (fetchReferenceImageAsGeminiImageObject) contra la imagen aprobada, vía servidor local:");
    veoImageObject = await fetchReferenceImageAsGeminiImageObject(localUrl);
    console.log(`  mimeType detectado: ${veoImageObject.mimeType}`);
    console.log(`  bytesBase64Encoded longitud: ${veoImageObject.bytesBase64Encoded.length} caracteres`);
    console.log(`  bytesBase64Encoded coincide con el buffer original: ${veoImageObject.bytesBase64Encoded === buffer.toString("base64")}`);
  } finally {
    server.close();
  }

  // --- 4. Request normalizado (Veo request builder) ---
  const durationSeconds = VEO_DURATION_SECONDS_1080P;
  const costPerSecond = getVeoCostUsdPerSecond();
  const estimatedCostUsd = Math.round(durationSeconds * costPerSecond * 100) / 100;
  const normalizedRequest = buildVideoGenerationRequest({
    visualIntent: PILLAR_TRANSPORT_VEO_FINAL_PROMPT,
    negativeSignals: PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS,
    referenceImageUrl: localUrl, // demostración local — la URL real de producción sería la de Supabase Storage, aún no generada.
    durationSeconds,
    aspectRatio: "16:9",
    maxCostUsd: MAX_AUTHORIZED_COST_USD,
    metadata: {
      benchmarkId: shot.benchmarkId,
      shotId: shot.shotId,
      provider: "veo",
      historicalClassification: shot.historicalClassification,
      targetResolution: "1080p",
      mode: "image-to-video",
    },
  });
  console.log("\n[4/6] Request normalizado (Veo request builder):");
  console.log(`  provider: google, model: ${VEO_MODEL}`);
  console.log(`  aspectRatio: ${normalizedRequest.aspectRatio}, durationSeconds: ${normalizedRequest.durationSeconds}, resolution objetivo: 1080p`);
  console.log(`  prompt: "${normalizedRequest.prompt.slice(0, 80)}..."`);
  console.log(`  negativePrompt incluye ${PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS.length} restricciones`);

  // --- 5. Cost Guard ---
  const benchmarkCeilingUsd = getMaxBenchmarkBudgetUsd();
  const costGuardPass = estimatedCostUsd <= MAX_AUTHORIZED_COST_USD && estimatedCostUsd <= benchmarkCeilingUsd;
  console.log("\n[5/6] Cost Guard:");
  console.log(`  costo estimado: $${estimatedCostUsd.toFixed(2)} (8s x $${costPerSecond}/s)`);
  console.log(`  techo autorizado para esta generación: $${MAX_AUTHORIZED_COST_USD.toFixed(2)}`);
  console.log(`  techo de planeación del benchmark: $${benchmarkCeilingUsd.toFixed(2)}`);
  console.log(`  Cost Guard: ${costGuardPass ? "PASS" : "FAIL"}`);

  // --- 6. Execution Gate (5 condiciones, estado REAL de este proceso) ---
  const flags = getFeatureFlags();
  const providerConfigured = veoVideoProvider.isAvailable();
  const gateParams = {
    referenceImageStatus: shot.referenceImageSpec.status,
    longFormAiVideoEnabled: flags.longFormAiVideoEnabled,
    explicitBenchmarkExecutionMode: false, // este script NUNCA lo activa — un pre-flight nunca ejecuta.
    costGuardAllowed: costGuardPass,
    providerConfigured,
  };
  const gateDecision = evaluateBenchmarkExecutionGate(gateParams);
  console.log("\n[6/6] Execution Gate (ai-video-benchmark-execution-gate.ts, 5 condiciones):");
  console.log(`  referenceImageStatus="${gateParams.referenceImageStatus}": ${gateParams.referenceImageStatus === "approved" ? "PASS" : "BLOCKED"}`);
  console.log(`  LONG_FORM_AI_VIDEO_ENABLED=${gateParams.longFormAiVideoEnabled}: ${gateParams.longFormAiVideoEnabled ? "PASS" : "BLOCKED (default de producción, sin cambios)"}`);
  console.log(`  explicitBenchmarkExecutionMode=${gateParams.explicitBenchmarkExecutionMode}: BLOCKED (nunca se activa desde un pre-flight)`);
  console.log(`  costGuardAllowed=${gateParams.costGuardAllowed}: ${gateParams.costGuardAllowed ? "PASS" : "BLOCKED"}`);
  console.log(`  providerConfigured (VEO_API_KEY en ESTE proceso)=${gateParams.providerConfigured}: ${gateParams.providerConfigured ? "PASS" : "BLOCKED (esta sesión interactiva no tiene VEO_API_KEY; Hans la configuró en Vercel, no aquí)"}`);
  console.log(`  DECISIÓN FINAL: ${gateDecision.allowed ? "ALLOWED" : "BLOCKED"}`);
  if (!gateDecision.allowed) {
    console.log(`  razones de bloqueo: ${gateDecision.reasons.join(" | ")}`);
  }

  console.log("\n" + "=".repeat(72));
  console.log(`[preflight-p2b-reference-image] Benchmark: ${ACTIVE_BENCHMARK_ID}`);
  console.log("[preflight-p2b-reference-image] 0 llamadas a Google. 0 créditos consumidos. LONG_FORM_AI_VIDEO_ENABLED permanece false (default de producción, sin cambios).");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("[preflight-p2b-reference-image] fallo:", err);
  process.exit(1);
});
