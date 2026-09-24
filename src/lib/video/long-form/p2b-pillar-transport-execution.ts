/**
 * P2B — lógica COMPARTIDA de la generación real autorizada (Google Veo 3.1
 * Fast, shot "Pillar Transport") — extraída a un módulo propio para que
 * scripts/execute-p2b-pillar-transport-veo.ts (CLI) y
 * src/app/api/admin/p2b-execute-pillar-transport-veo/route.ts (endpoint
 * administrativo, para correr donde exista VEO_API_KEY real — hoy solo
 * Vercel) llamen EXACTAMENTE la misma lógica de seguridad, nunca duplicada
 * en dos lugares que podrían divergir.
 *
 * Todas las condiciones de autorización viven aquí, no en el llamador:
 *   1. P2B_PILLAR_TRANSPORT_VEO_EXECUTE=true (autorización explícita —
 *      nunca implícita por tener VEO_API_KEY configurada).
 *   2. Imagen de referencia aprobada, leída del repo, con checksum
 *      EXACTO al registrado en la aprobación (nunca sustituible).
 *   3. Cost Guard POR CLIP: costo estimado <= PER_CLIP_MAX_COST_USD
 *      (ver p2b-mission-ledger.ts), nunca configurable por env var.
 *   4. Cost Guard de MISIÓN: gasto acumulado (ledger durable en Supabase
 *      Storage, ver p2b-mission-ledger.ts) + este intento <
 *      MISSION_TOTAL_BUDGET_USD ($10, autorización de misión de Hans) —
 *      cada invocación de la ruta administrativa corre en un
 *      contenedor/proceso efímero distinto, así que este techo NUNCA
 *      podría verificarse correctamente sin un ledger que persista fuera
 *      del proceso.
 *   5. VEO_API_KEY configurada en el proceso que ejecuta esto.
 *   6. retries=0 — ninguna lógica de reintento automático existe en este
 *      archivo (cada invocación de executeP2BPillarTransportVeoOnce()
 *      intenta como máximo UNA llamada real a Google).
 *
 * LONG_FORM_AI_VIDEO_ENABLED se fuerza a "true" SOLO dentro del proceso
 * que llama a executeP2BPillarTransportVeoOnce() (ver comentario en cada
 * llamador) — nunca el default real de producción.
 *
 * La imagen de referencia aprobada se pasa a veo.ts como un `data:` URL
 * (bytes ya en memoria, codificados en base64) en vez de servirla desde un
 * servidor HTTP local (127.0.0.1) — el diseño original de P2B-prep/P2B.
 * `fetch()` de Node soporta `data:` de forma nativa (verificado en este
 * mismo entorno), así que esto preserva exactamente el mismo código real
 * de veo.ts (`fetchReferenceImageAsGeminiImageObject`, que sigue haciendo
 * un `fetch()` real) sin depender de si el sandbox de red de las funciones
 * serverless de Vercel permite abrir un socket de loopback y conectarse a
 * él dentro de la misma invocación — una suposición nunca antes verificada
 * fuera de este entorno de desarrollo/`tsx` local.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PER_CLIP_MAX_COST_USD, evaluateMissionBudget, appendLedgerEntry, readLedger } from "./p2b-mission-ledger";

/** Alias retrocompatible — el techo POR CLIP vive ahora en p2b-mission-ledger.ts junto al techo de misión ($10); scripts/execute-p2b-pillar-transport-veo.ts lo sigue importando con este nombre. */
export const ABSOLUTE_MAX_COST_USD = PER_CLIP_MAX_COST_USD;
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
      storedLocallyAt?: string;
      canonicalStoragePath?: string;
      storageWarning?: string;
      missionCumulativeSpendUsd: number;
    }
  | {
      preflightPassed: true;
      attempted: true;
      success: false;
      generationTimeMs: number;
      errorReason: string;
      errorProviderId: string;
      errorMessage: string;
      /** Presente cuando el fallo ocurrió DESPUÉS de que Google ya creó la operación (p. ej. 503 transitorio al consultar, o descarga fallida) — permite ubicarla/inspeccionarla manualmente sin perderla, ver GenerativeProviderError.providerJobId. */
      providerJobId?: string;
      missionCumulativeSpendUsd: number;
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
  let attemptNumber = 1;
  let supabase: SupabaseClient | undefined;

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

  // Cost Guard de MISIÓN ($10 total, ver p2b-mission-ledger.ts): solo tiene
  // sentido comprobarlo si ya vamos a gastar dinero real (providerConfigured)
  // — se lee un ledger DURABLE de Supabase Storage porque cada invocación de
  // este módulo corre en un proceso/contenedor efímero distinto (Vercel), así
  // que el acumulado NUNCA podría verificarse correctamente con solo estado
  // en memoria de este proceso.
  let missionCumulativeSpendUsd = 0;
  if (providerConfigured) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service");
      supabase = createServiceClient();
      const ledger = await readLedger(supabase);
      attemptNumber = ledger.entries.length + 1;
      const budgetDecision = evaluateMissionBudget(ledger, estimatedCostUsd);
      missionCumulativeSpendUsd = ledger.entries
        .filter((e) => e.result !== "preflight_blocked")
        .reduce((sum, e) => sum + (e.actualCostUsd ?? e.expectedCostUsd), 0);
      if (!budgetDecision.allowed) {
        failures.push({ check: "mission_budget", detail: budgetDecision.detail });
      }
    } catch (err) {
      // Fail closed: si ya vamos a gastar dinero real pero no podemos leer el
      // ledger durable, NO seguimos — no hay forma segura de saber si ya nos
      // acercamos al techo de $10 de la misión.
      failures.push({
        check: "mission_ledger_available",
        detail: `No se pudo leer/crear el cliente de Supabase Storage para verificar el ledger de gasto de la misión antes de gastar dinero real: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (failures.length > 0) {
    // Best-effort: deja constancia del intento bloqueado en el ledger para
    // auditoría (nunca cuenta como gasto — ver cumulativeBillableSpend). Si
    // esto mismo falla (p. ej. supabase nunca se pudo crear), no bloquea el
    // resultado — ya vamos a devolver preflightPassed:false de todos modos.
    if (supabase) {
      await appendLedgerEntry(supabase, {
        attempt: attemptNumber,
        timestampIso: new Date().toISOString(),
        provider: "veo",
        model: VEO_MODEL,
        shotId: "bench-v2-a-pillar-transport",
        reason: "P2B mission — runtime pre-check falló, sin llamada a Google.",
        expectedCostUsd: estimatedCostUsd,
        actualCostUsd: null,
        result: "preflight_blocked",
      }).catch(() => undefined);
    }
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

  // La imagen de referencia se pasa como `data:` URL — los bytes ya
  // validados/con checksum verificado, en memoria, codificados en base64.
  // `veo.ts` la "descarga" con un `fetch()` real e idéntico al que usaría
  // para cualquier URL real (ver fetchReferenceImageAsGeminiImageObject),
  // sin depender de abrir un socket de loopback dentro del sandbox de red
  // de la función serverless (ver comentario de cabecera de este archivo).
  request.referenceImageUrl = `data:image/png;base64,${imageBuffer!.toString("base64")}`;

  const startedAtMs = Date.now();
  try {
    const asset = await veoVideoProvider.generateVideo(request);
    const generationTimeMs = Date.now() - startedAtMs;

    const validation = validateVideoAssetBuffer(asset.buffer, asset.mimeType, {
      durationSeconds: asset.durationSeconds,
      widthPx: asset.width,
      heightPx: asset.height,
    });

    // Storage: intenta primero el canonical Supabase Storage real (mismo
    // bucket/patrón que el resto de Long Form, ver ai-video-storage.ts) —
    // si falla (o si `supabase` nunca se pudo crear), preserva el MP4 ya
    // generado y pagado localmente en vez de perderlo (Plan I: nunca se
    // reintenta la generación por un fallo de Storage).
    let canonicalStoragePath: string | undefined;
    let storedLocallyAt: string | undefined;
    let storageWarning: string | undefined;
    const idempotencyKey = (asset.providerJobId ?? `no-operation-id-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "-");
    if (supabase) {
      try {
        const { resolveAiVideoStorageAsset } = await import("./ai-video-storage");
        const canonical = await resolveAiVideoStorageAsset(
          supabase,
          {
            shotId: shot!.shotId,
            buffer: asset.buffer,
            mimeType: asset.mimeType,
            extension: asset.extension,
            durationSeconds: asset.durationSeconds ?? durationSeconds,
            provider: "veo",
            model: asset.model,
            costUsd: asset.costUsd,
            providerJobId: asset.providerJobId,
            sourceHasGeneratedAudio: asset.sourceHasGeneratedAudio,
          },
          { scopeId: shot!.benchmarkId, idempotencyKey, executionMode: "real" },
        );
        canonicalStoragePath = `${canonical.bucket}/${canonical.storagePath}`;
      } catch (err) {
        storageWarning = `Subida a Supabase Storage falló — el video generado se preserva localmente. Detalle: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      storageWarning = "Sin cliente de Supabase disponible en este proceso — el video generado se preserva localmente (nunca se pierde, pero esto no es durable en un contenedor serverless efímero).";
    }
    if (!canonicalStoragePath) {
      const outputDir = join(process.cwd(), ".atomivid-state", "p2b-results");
      mkdirSync(outputDir, { recursive: true });
      const outputPath = join(outputDir, `bench-v2-a-pillar-transport-veo-${Date.now()}.${asset.extension}`);
      writeFileSync(outputPath, asset.buffer);
      storedLocallyAt = outputPath;
    }

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

    if (supabase) {
      await appendLedgerEntry(supabase, {
        attempt: attemptNumber,
        timestampIso: new Date().toISOString(),
        provider: "veo",
        model: asset.model,
        shotId: shot!.shotId,
        reason: "P2B mission — Pillar Transport, image-to-video, 16:9, 1080p, 8s.",
        expectedCostUsd: estimatedCostUsd,
        actualCostUsd: asset.costUsd,
        result: "success",
        providerJobId: asset.providerJobId,
      }).catch(() => undefined);
    }

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
      storedLocallyAt,
      canonicalStoragePath,
      storageWarning,
      missionCumulativeSpendUsd: missionCumulativeSpendUsd + asset.costUsd,
    };
  } catch (err) {
    const generationTimeMs = Date.now() - startedAtMs;
    const reason = err instanceof GenerativeProviderError ? err.reason : "upstream_error";
    // Si Google ya creó la operación antes de fallar (p. ej. un 503
    // transitorio al consultar, o un fallo de descarga), veo.ts adjunta su
    // identificador aquí — nunca se pierde, ver GenerativeProviderError.
    // providerJobId (types.ts) y el comentario de cabecera de waitForCompletion.
    const providerJobId = err instanceof GenerativeProviderError ? err.providerJobId : undefined;
    if (supabase) {
      await appendLedgerEntry(supabase, {
        attempt: attemptNumber,
        timestampIso: new Date().toISOString(),
        provider: "veo",
        model: VEO_MODEL,
        shotId: shot!.shotId,
        reason: "P2B mission — Pillar Transport, intento falló tras iniciar (o intentar iniciar) la generación real.",
        expectedCostUsd: estimatedCostUsd,
        // Conservador: se asume gastado (Google pudo haber facturado la
        // operación aunque el sondeo/descarga/validación fallara después) —
        // ver comentario de cumulativeBillableSpend en p2b-mission-ledger.ts.
        actualCostUsd: estimatedCostUsd,
        result: "failure",
        errorReason: reason,
        providerJobId,
      }).catch(() => undefined);
    }
    if (err instanceof GenerativeProviderError) {
      return {
        preflightPassed: true,
        attempted: true,
        success: false,
        generationTimeMs,
        errorReason: err.reason,
        errorProviderId: err.providerId,
        errorMessage: err.message,
        providerJobId: err.providerJobId,
        missionCumulativeSpendUsd: missionCumulativeSpendUsd + estimatedCostUsd,
      };
    }
    return {
      preflightPassed: true,
      attempted: true,
      success: false,
      generationTimeMs,
      missionCumulativeSpendUsd: missionCumulativeSpendUsd + estimatedCostUsd,
      errorReason: "upstream_error",
      errorProviderId: "veo",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
