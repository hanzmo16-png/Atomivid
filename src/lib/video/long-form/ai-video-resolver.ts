/**
 * Resolver del AI Video Pipeline de Long Form — encadena, en orden:
 * elegibilidad (ai-video-eligibility.ts, sin red) → cost guard
 * (ai-video-cost-guard.ts, sin red) → prompt builder
 * (ai-video-prompt-builder.ts, sin red) → VideoProvider.generateVideo()
 * (providers/video-gen/, la ÚNICA llamada real/de red de todo este
 * módulo — el ciclo de vida async submit→poll→download YA está
 * encapsulado dentro de cada adaptador, ver runway.ts) → validación
 * (ai-video-validation.ts) → resultado normalizado listo para que el
 * llamador lo suba con el mismo `AssetUploader` que ya usa el resto de
 * Long Form (ver asset-resolver.ts) y lo pase al renderer.
 *
 * Este módulo SOLO resuelve el tier "ai_video" — si la elegibilidad
 * recomienda "ai_image_motion"/"ai_image"/"real_image" para un shot, o si
 * cualquier paso de arriba falla o excede presupuesto, devuelve un
 * resultado "skipped" con el tier de fallback recomendado; el LLAMADOR
 * (fuera de este checkpoint — ver informe final, sección "pendiente
 * deliberadamente") es quien decide cómo resolver ese fallback usando el
 * asset-resolver.ts / production-ai-recreation.ts YA existentes — este
 * módulo nunca reimplementa resolución de imágenes.
 *
 * Invariante de producción (mismo criterio que todo el resto del repo):
 * si se pide `requireReal: true` (nunca-fixture) y el VideoProvider
 * resuelto es el fixture (p. ej. porque no hay credenciales configuradas
 * pese a que el feature flag esté encendido), esto LANZA — nunca se
 * acepta un resultado fixture como si fuera real en producción.
 */
import type { VideoGenerationRequest, VideoProvider } from "@/lib/providers/types";
import { GenerativeProviderError } from "@/lib/providers/types";
import type { VisualAssetTier } from "./types";
import { scoreAiVideoEligibility, type AiVideoEligibilityInput } from "./ai-video-eligibility";
import {
  assertAiVideoBudget,
  getAiVideoCostConfig,
  recordAiVideoSpend,
  type AiVideoCostConfig,
  type AiVideoLedgerState,
} from "./ai-video-cost-guard";
import { buildVideoGenerationRequest } from "./ai-video-prompt-builder";
import { validateVideoAssetBuffer } from "./ai-video-validation";

export class AiVideoProductionFixtureError extends Error {
  constructor(public readonly shotId: string, public readonly providerName: string) {
    super(
      `AI Video Pipeline: se pidió requireReal=true para el shot "${shotId}" pero el VideoProvider resuelto es ` +
        `"${providerName}" (fixture) — nunca se acepta un resultado fixture como real en producción. Revisa la ` +
        `configuración del proveedor (VIDEO_PROVIDER/PREMIUM_CLIPS_ENABLED/RUNWAY_API_KEY) antes de reintentar.`,
    );
    this.name = "AiVideoProductionFixtureError";
  }
}

export type ResolvedAiVideoClip = {
  shotId: string;
  buffer: Buffer;
  mimeType: string;
  extension: string;
  durationSeconds: number;
  widthPx?: number;
  heightPx?: number;
  provider: string;
  model: string;
  costUsd: number;
  providerJobId?: string;
  /** ver GenerativeAsset.sourceHasGeneratedAudio (providers/types.ts) — pasa a través sin interpretarse aquí; el renderer decide qué hacer con esto. */
  sourceHasGeneratedAudio?: boolean;
};

export type AiVideoResolutionOutcome =
  | { status: "generated"; shotId: string; clip: ResolvedAiVideoClip }
  | { status: "skipped"; shotId: string; reason: string; recommendedFallback: VisualAssetTier };

export type ResolveAiVideoForShotParams = {
  shot: AiVideoEligibilityInput & { referenceAsset?: string };
  /** Duración total del documental (segundos) — para el tope de % del cost guard. */
  totalDocumentaryDurationSec: number;
  ledger: AiVideoLedgerState;
  videoProvider: VideoProvider;
  aspectRatio: VideoGenerationRequest["aspectRatio"];
  costConfig?: AiVideoCostConfig;
  /** true en cualquier ejecución que se vaya a entregar como real — nunca acepta un resultado fixture. false en dry-run/simulation. */
  requireReal?: boolean;
  contextNotes?: string[];
  negativeSignals?: string[];
  metadata?: Record<string, string>;
};

/** Resuelve UN shot. Pura excepto por la única llamada real a `videoProvider.generateVideo()`. */
export async function resolveAiVideoForShot(params: ResolveAiVideoForShotParams): Promise<AiVideoResolutionOutcome> {
  const costConfig = params.costConfig ?? getAiVideoCostConfig();
  const shotId = params.shot.id;

  const eligibility = scoreAiVideoEligibility(params.shot, costConfig);
  if (eligibility.recommendedAssetType !== "ai_video") {
    return { status: "skipped", shotId, reason: eligibility.reason, recommendedFallback: eligibility.recommendedAssetType };
  }

  const budgetDecision = assertAiVideoBudget(
    params.ledger,
    params.shot.durationSec,
    eligibility.estimatedCostUsd,
    params.totalDocumentaryDurationSec,
    costConfig,
  );
  if (!budgetDecision.allowed) {
    return {
      status: "skipped",
      shotId,
      reason: budgetDecision.reason,
      recommendedFallback: eligibility.fallback[0] ?? "ai_image",
    };
  }

  if (params.requireReal && params.videoProvider.name === "fixture") {
    throw new AiVideoProductionFixtureError(shotId, params.videoProvider.name);
  }

  const request = buildVideoGenerationRequest({
    visualIntent: params.shot.visualIntent,
    motionDescription: params.shot.motionDescription,
    contextNotes: params.contextNotes,
    negativeSignals: params.negativeSignals,
    referenceImageUrl: params.shot.referenceAsset,
    durationSeconds: params.shot.durationSec,
    aspectRatio: params.aspectRatio,
    maxCostUsd: eligibility.estimatedCostUsd,
    metadata: { shotId, ...params.metadata },
  });

  let asset;
  try {
    asset = await params.videoProvider.generateVideo(request);
  } catch (err) {
    // Cualquier fallo del proveedor (moderación, presupuesto propio,
    // timeout, error upstream) nunca se finge como éxito — se registra
    // (mensaje del error incluido en `reason`) y se ejecuta el fallback
    // permitido, nunca un reintento silencioso ni otro proveedor pago.
    if (err instanceof GenerativeProviderError) {
      return {
        status: "skipped",
        shotId,
        reason: `VideoProvider "${params.videoProvider.name}" falló (${err.reason}): ${err.message}`,
        recommendedFallback: eligibility.fallback[0] ?? "ai_image",
      };
    }
    throw err;
  }

  const validation = validateVideoAssetBuffer(asset.buffer, asset.mimeType, {
    durationSeconds: asset.durationSeconds,
    widthPx: asset.width,
    heightPx: asset.height,
  });
  if (!validation.valid) {
    return {
      status: "skipped",
      shotId,
      reason: `VideoProvider "${params.videoProvider.name}" devolvió un archivo inválido: ${validation.reason}`,
      recommendedFallback: eligibility.fallback[0] ?? "ai_image",
    };
  }
  // Defensa en profundidad: si llegamos aquí con requireReal=true, ya se
  // descartó arriba que el proveedor fuera "fixture" por nombre — esto
  // cubre además el caso (no esperado hoy) de un proveedor real que por
  // error devolviera bytes con la firma del fixture.
  if (params.requireReal && validation.format === "fixture-placeholder") {
    throw new AiVideoProductionFixtureError(shotId, params.videoProvider.name);
  }

  return {
    status: "generated",
    shotId,
    clip: {
      shotId,
      buffer: asset.buffer,
      mimeType: asset.mimeType,
      extension: asset.extension,
      durationSeconds: asset.durationSeconds ?? params.shot.durationSec,
      widthPx: asset.width,
      heightPx: asset.height,
      provider: params.videoProvider.name,
      model: asset.model,
      costUsd: asset.costUsd,
      providerJobId: asset.providerJobId,
      sourceHasGeneratedAudio: asset.sourceHasGeneratedAudio,
    },
  };
}

export type AiVideoBatchResult = {
  outcomes: AiVideoResolutionOutcome[];
  finalLedger: AiVideoLedgerState;
};

/**
 * Resuelve una lista de shots EN ORDEN, respetando `generationPriority`
 * (menor = más prioridad) cuando está presente — así el cost guard, si no
 * alcanza para todos los shots elegibles, concede primero los más
 * importantes. El ledger se actualiza secuencialmente: un shot resuelto
 * cuenta para el presupuesto del siguiente dentro del mismo lote.
 */
export async function resolveAiVideoForShots(
  shots: (AiVideoEligibilityInput & { referenceAsset?: string; generationPriority?: number })[],
  paramsWithoutShot: Omit<ResolveAiVideoForShotParams, "shot" | "ledger">,
  initialLedger: AiVideoLedgerState,
): Promise<AiVideoBatchResult> {
  const ordered = [...shots].sort((a, b) => (a.generationPriority ?? Number.MAX_SAFE_INTEGER) - (b.generationPriority ?? Number.MAX_SAFE_INTEGER));

  let ledger = initialLedger;
  const outcomes: AiVideoResolutionOutcome[] = [];
  for (const shot of ordered) {
    const outcome = await resolveAiVideoForShot({ ...paramsWithoutShot, shot, ledger });
    outcomes.push(outcome);
    if (outcome.status === "generated") {
      ledger = recordAiVideoSpend(ledger, outcome.clip.durationSeconds, outcome.clip.costUsd);
    }
  }
  return { outcomes, finalLedger: ledger };
}
