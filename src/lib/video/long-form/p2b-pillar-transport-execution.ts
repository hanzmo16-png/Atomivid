/**
 * P2B — lógica COMPARTIDA de la única generación real autorizada (Google
 * Veo 3.1 Fast, shot "Pillar Transport") — extraída a un módulo propio
 * para que scripts/execute-p2b-pillar-transport-veo.ts (CLI) y
 * src/app/api/admin/p2b-execute-pillar-transport-veo/route.ts (endpoint
 * administrativo, para correr donde exista VEO_API_KEY real — hoy solo
 * Vercel) llamen EXACTAMENTE la misma lógica de seguridad, nunca duplicada
 * en dos lugares que podrían divergir.
 *
 * Todas las condiciones de autorización viven aquí, no en el llamador:
 *   1. P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true (autorización explícita de un
 *      solo uso — nunca implícita por tener VEO_API_KEY configurada).
 *   2. Imagen de referencia aprobada, leída del repo, con checksum
 *      EXACTO al registrado en la aprobación (nunca sustituible).
 *   3. Cost Guard: costo estimado <= techo ABSOLUTO hardcodeado aquí
 *      (ABSOLUTE_MAX_COST_USD), nunca configurable por env var.
 *   4. VEO_API_KEY configurada en el proceso que ejecuta esto.
 *   5. retries=0 — ninguna lógica de reintento existe en este archivo.
 *
 * LONG_FORM_AI_VIDEO_ENABLED se fuerza a "true" SOLO dentro del proceso
 * que llama a executeP2BPillarTransportVeoOnce() (ver comentario en cada
 * llamador) — nunca el default real de producción.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

/** Techo ABSOLUTO autorizado por Hans para esta única generación — nunca configurable por env var, nunca elevado por ningún mecanismo. */
export const ABSOLUTE_MAX_COST_USD = 1.0;
export const RETRIES = 0;

export type P2BPreflightFailure = { check: string; detail: string };

export type P2BExecutionResult =
  | { preflightPassed: false; failures: P2BPreflightFailure[]; attempted: false }
  | {
      preflightPassed: true;
      attempted: true;
      success: true;
      providerJobId?: string;
      generationTimeMs: number;
      estimatedCostUsd: number;
      actualCostUsd: number;
      durationSeconds: number;
      validation: { valid: boolean; reason?: string; format?: string };
      storedLocallyAt: string;
    }
  | {
      preflightPassed: true;
      attempted: true;
      success: false;
      generationTimeMs: number;
      errorReason: string;
      errorProviderId: string;
      errorMessage: string;
    };

/**
 * Ejecuta el runtime pre-check completo y, SOLO si pasa, UNA generación
 * real (sin reintento). Pura en el sentido de que nunca vuelve a
 * intentarlo — cualquier resultado (éxito, fallo del proveedor, o
 * pre-check fallido) termina en un solo `return`, nunca en un loop.
 */
export async function executeP2BPillarTransportVeoOnce(): Promise<P2BExecutionResult> {
  process.env.LONG_FORM_AI_VIDEO_ENABLED = "true"; // SOLO este proceso — ver comentario de cabecera.

  const { ACTIVE_BENCHMARK_SHOTS } = await import("./ai-video-benchmark-v2-active");
  const { validateReferenceImageBuffer, computeReferenceImageChecksumSha256 } = await import("./ai-video-reference-image");
  const { evaluateBenchmarkExecutionGate } = await import("./ai-video-benchmark-execution-gate");
  const { veoVideoProvider, VEO_MODEL, VEO_DURATION_SECONDS_1080P, getVeoCostUsdPerSecond } = await import("@/lib/providers/video-gen/veo");
  const { PILLAR_TRANSPORT_VEO_FINAL_PROMPT, PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS } = await import("./ai-video-provider-comparison");
  const { buildVideoGenerationRequest } = await import("./ai-video-prompt-builder");
  const { validateVideoAssetBuffer } = await import("./ai-video-validation");
  const { buildAiVideoObservabilityRecord, logAiVideoObservabilityRecord } = await import("./ai-video-observability");
  const { GenerativeProviderError } = await import("@/lib/providers/types");

  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport");
  const approval = shot?.referenceImageSpec.approval;
  const failures: P2BPreflightFailure[] = [];

  const explicitAuthorization = process.env.P2B_PILLAR_TRANSPORT_VEO_EXECUTE === "true";
  if (!explicitAuthorization) {
    failures.push({ check: "explicit_authorization", detail: "P2B_PILLAR_TRANSPORT_VEO_EXECUTE no es 'true' — ejecución de un solo uso no autorizada explícitamente para este proceso." });
  }

  if (!shot || !approval || shot.referenceImageSpec.status !== "approved") {
    failures.push({ check: "image_approved", detail: "El shot Pillar Transport no tiene una imagen de referencia con status='approved'." });
  }

  let imageBuffer: Buffer | undefined;
  if (approval) {
    // process.cwd() (no __dirname): portable entre `tsx scripts/...` (cwd=raíz del repo, convención ya usada por todos los scripts) y una función serverless de Vercel (cwd=raíz del deployment).
    const imagePath = join(process.cwd(), approval.sourceImagePath);
    if (!existsSync(imagePath)) {
      failures.push({ check: "reference_image_exists", detail: `No se encontró el archivo de imagen de referencia en "${approval.sourceImagePath}" (cwd=${process.cwd()}).` });
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
    longFormAiVideoEnabled: true,
    explicitBenchmarkExecutionMode: explicitAuthorization,
    costGuardAllowed: estimatedCostUsd <= ABSOLUTE_MAX_COST_USD,
    providerConfigured,
  });
  if (!gateDecision.allowed) {
    failures.push({ check: "execution_gate", detail: gateDecision.reasons.join(" | ") });
  }

  if (failures.length > 0) {
    return { preflightPassed: false, failures, attempted: false };
  }

  const request = buildVideoGenerationRequest({
    visualIntent: PILLAR_TRANSPORT_VEO_FINAL_PROMPT,
    negativeSignals: PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS,
    referenceImageUrl: "PLACEHOLDER", // sobreescrito abajo.
    durationSeconds,
    aspectRatio,
    maxCostUsd: ABSOLUTE_MAX_COST_USD,
    metadata: { benchmarkId: shot!.benchmarkId, shotId: shot!.shotId, provider: "veo", historicalClassification: shot!.historicalClassification },
  });

  // La imagen de referencia se sirve desde el archivo YA validado del repo
  // (nunca una URL de terceros) — Supabase Storage real todavía no
  // contiene el asset (ver informe P2B). Un servidor HTTP local
  // (127.0.0.1, nunca expuesto) sirve esos bytes exactos para que
  // veo.ts los descargue igual que haría con cualquier URL real.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(imageBuffer!.byteLength) });
    res.end(imageBuffer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  request.referenceImageUrl = `http://127.0.0.1:${port}/bench-v2-a-pillar-transport.png`;

  const startedAtMs = Date.now();
  try {
    const asset = await veoVideoProvider.generateVideo(request);
    const generationTimeMs = Date.now() - startedAtMs;

    const validation = validateVideoAssetBuffer(asset.buffer, asset.mimeType, {
      durationSeconds: asset.durationSeconds,
      widthPx: asset.width,
      heightPx: asset.height,
    });

    const outputDir = join(process.cwd(), ".atomivid-state", "p2b-results");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `bench-v2-a-pillar-transport-veo-${Date.now()}.${asset.extension}`);
    writeFileSync(outputPath, asset.buffer);

    logAiVideoObservabilityRecord(
      buildAiVideoObservabilityRecord({
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
      }),
    );

    return {
      preflightPassed: true,
      attempted: true,
      success: true,
      providerJobId: asset.providerJobId,
      generationTimeMs,
      estimatedCostUsd,
      actualCostUsd: asset.costUsd,
      durationSeconds: asset.durationSeconds ?? durationSeconds,
      validation,
      storedLocallyAt: outputPath,
    };
  } catch (err) {
    const generationTimeMs = Date.now() - startedAtMs;
    if (err instanceof GenerativeProviderError) {
      return {
        preflightPassed: true,
        attempted: true,
        success: false,
        generationTimeMs,
        errorReason: err.reason,
        errorProviderId: err.providerId,
        errorMessage: err.message,
      };
    }
    return {
      preflightPassed: true,
      attempted: true,
      success: false,
      generationTimeMs,
      errorReason: "upstream_error",
      errorProviderId: "veo",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    server.close();
  }
}
