/**
 * Ejecución de UN shot ya asignado (allocateShotTypes) en la ruta de
 * producto de Long Form — con reuso durable, presupuesto confirmado y
 * fallback acotado:
 *
 * - Todo asset ya resuelto en un intento anterior se REUTILIZA
 *   (durable-shot-assets.ts), nunca se vuelve a pagar.
 * - Toda llamada pagada NUEVA reserva antes en el presupuesto durable
 *   (production-budget.ts); sin reserva → fallback, nunca gasto extra.
 * - Un STARTED huérfano (costo incierto) nunca se regenera.
 * - Fallback: video IA → imagen IA de referencia con movimiento; imagen IA
 *   → archivo real; archivo (consulta alternativa) → tarjeta de texto REAL.
 *   Nunca un fixture, nunca un tipo más caro que lo asignado.
 */
import type { FootageProvider, ImageProvider, VideoProvider } from "@/lib/providers/types";
import { GenerativeProviderError } from "@/lib/providers/types";
import type { ResolvedShotAsset } from "./asset-resolver";
import { resolveAiVideoForShot } from "./ai-video-resolver";
import { recordAiVideoSpend, type AiVideoCostConfig, type AiVideoLedgerState } from "./ai-video-cost-guard";
import type { ShotAssetKind, ShotAssetStore } from "./durable-shot-assets";
import type { ProductionBudget } from "./production-budget";
import type { AllocatedShot, GenerativeUnitCosts } from "./production-plan";
import { documentaryImagePrompt, textCardForShot } from "./visual-intents";
import type { ShotType } from "./types";

/** Rechazos de imagen con costo conocido CERO (el proveedor no generó nada). */
const NO_CHARGE_IMAGE_REASONS = new Set<GenerativeProviderError["reason"]>([
  "moderation_rejected",
  "invalid_request",
  "not_configured",
  "authentication_error",
  "budget_exceeded",
  "quota_exceeded",
  "rate_limited",
  "contract_unverified",
]);

export type ShotExecutionDeps = {
  topic: string;
  footageProvider: FootageProvider;
  imageProvider: ImageProvider;
  /** Ya envuelto con wrapDurableVideoProvider (reuso/reanudación/reserva de presupuesto por envío). */
  videoProvider?: VideoProvider;
  store: ShotAssetStore;
  budget: ProductionBudget;
  units: GenerativeUnitCosts;
  aiVideoCostConfig: AiVideoCostConfig;
  totalDurationSec: number;
  requireReal: boolean;
  metadata?: Record<string, string>;
  /**
   * Recuperación (P0 2026-09-25): CERO llamadas a proveedores — solo se
   * reutilizan registros COMPLETED durables. Nunca reserva presupuesto ni
   * escribe STARTED; un COMPLETED ilegible aborta (ShotReplayError) en vez
   * de degradar en silencio a otro material.
   */
  replayOnly?: boolean;
};

export class ShotReplayError extends Error {
  constructor(readonly shotId: string, reason: string) {
    super(`Recuperación abortada en ${shotId}: ${reason} — no se llama a ningún proveedor.`);
    this.name = "ShotReplayError";
  }
}

export type ShotExecution = {
  shotId: string;
  asset: ResolvedShotAsset;
  executedType: ShotType;
  costUsd: number;
  bufferBytes: number;
  providerUsed: string;
  reused: boolean;
  /** Costo real atribuible al video (incluye lo pagado en un intento anterior y reutilizado). */
  attributedCostUsd: number;
  /** Presente si el shot terminó con un tipo distinto del asignado. */
  deviation?: { planned: ShotType; executed: ShotType; reason: string };
  aiVideoLedger: AiVideoLedgerState;
};

type MediaOutcome = { url: string; mediaType: "image" | "video"; costUsd: number; bytes: number; provider: string; reused: boolean; priorCostUsd?: number };

async function reuseCompleted(deps: ShotExecutionDeps, shotId: string, kind: ShotAssetKind): Promise<MediaOutcome | null> {
  const record = await deps.store.read(shotId, kind);
  if (record?.status !== "COMPLETED" || !record.objectPath) return null;
  try {
    const url = await deps.store.signedUrl(record.objectPath);
    return { url, mediaType: record.mediaType ?? "image", costUsd: 0, bytes: 0, provider: record.provider ?? "cache", reused: true, priorCostUsd: record.costUsd ?? 0 };
  } catch (err) {
    if (deps.replayOnly) throw new ShotReplayError(shotId, `el asset ${kind} COMPLETED no se pudo leer (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

async function persistMedia(
  deps: ShotExecutionDeps,
  shotId: string,
  kind: ShotAssetKind,
  buffer: Buffer,
  contentType: string,
  extension: string,
  mediaType: "image" | "video",
  provider: string,
  costUsd: number,
): Promise<string> {
  const objectPath = deps.store.objectPathFor(shotId, kind, extension);
  await deps.store.putObject(objectPath, buffer, contentType);
  await deps.store.write({
    shotId,
    kind,
    status: "COMPLETED",
    objectPath,
    contentType,
    mediaType,
    costUsd,
    provider,
    bytes: buffer.byteLength,
    updatedAtIso: new Date().toISOString(),
  });
  return deps.store.signedUrl(objectPath);
}

/** Archivo real (Pexels, 16:9): consulta del shot y luego el tema — nunca paga. */
async function resolveStock(shot: AllocatedShot, deps: ShotExecutionDeps, preferVideo: boolean): Promise<MediaOutcome | null> {
  const cached = await reuseCompleted(deps, shot.id, "stock");
  if (cached) return cached;
  if (deps.replayOnly) return null;
  const queries = [...new Set([shot.visualIntent, deps.topic].map((q) => q.trim()).filter(Boolean))];
  for (const query of queries) {
    try {
      let result;
      if (preferVideo) {
        result = await deps.footageProvider.fetchFootage(query, shot.durationSec, "landscape");
      } else {
        const candidates = deps.footageProvider.searchImageCandidates
          ? await deps.footageProvider.searchImageCandidates(query, "landscape")
          : [];
        result = candidates[0] ?? (await deps.footageProvider.fetchFootage(query, undefined, "landscape"));
      }
      const buffer = await deps.footageProvider.downloadFootage(result.url);
      if (buffer.byteLength === 0) continue;
      const url = await persistMedia(deps, shot.id, "stock", buffer, result.mimeType, result.extension, result.mediaType, deps.footageProvider.name, 0);
      return { url, mediaType: result.mediaType, costUsd: 0, bytes: buffer.byteLength, provider: deps.footageProvider.name, reused: false };
    } catch (err) {
      console.warn(`[atomivid:long-form:shot] archivo no disponible para ${shot.id} ("${query}"):`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

type AiImageOutcome = MediaOutcome | { unavailable: string };

/** Imagen IA con reuso durable + reserva de presupuesto; nunca regenera un STARTED incierto. */
async function resolveAiImage(shot: AllocatedShot, deps: ShotExecutionDeps): Promise<AiImageOutcome> {
  const cached = await reuseCompleted(deps, shot.id, "ai_image");
  if (cached) return cached;
  if (deps.replayOnly) return { unavailable: "recuperación: sin imagen IA durable (no se genera)" };
  const existing = await deps.store.read(shot.id, "ai_image");
  if (existing?.status === "STARTED") {
    return { unavailable: "una generación anterior de esta imagen quedó sin confirmar (costo incierto) — no se regenera" };
  }
  if (existing?.status === "FAILED_NO_CHARGE") {
    return { unavailable: "el proveedor ya rechazó esta imagen antes" };
  }
  if (!(await deps.budget.reserveAiImage(deps.units.imageUsd))) {
    return { unavailable: "presupuesto confirmado de imágenes IA agotado" };
  }
  await deps.store.write({ shotId: shot.id, kind: "ai_image", status: "STARTED", provider: deps.imageProvider.name, updatedAtIso: new Date().toISOString() });

  let asset;
  try {
    asset = await deps.imageProvider.generateImage({
      prompt: documentaryImagePrompt(shot.visualIntent),
      aspectRatio: "16:9",
      maxCostUsd: deps.units.imageUsd,
    });
  } catch (err) {
    if (err instanceof GenerativeProviderError && NO_CHARGE_IMAGE_REASONS.has(err.reason)) {
      await deps.store.write({ shotId: shot.id, kind: "ai_image", status: "FAILED_NO_CHARGE", provider: deps.imageProvider.name, updatedAtIso: new Date().toISOString() });
      await deps.budget.releaseAiImage(deps.units.imageUsd);
      return { unavailable: `imagen IA rechazada sin costo (${err.reason})` };
    }
    // Costo incierto: queda STARTED (nunca se regenera) y la reserva queda contada.
    return { unavailable: `imagen IA falló (${err instanceof GenerativeProviderError ? err.reason : "error inesperado"})` };
  }
  if (deps.requireReal && deps.imageProvider.name === "fixture") {
    throw new Error(`Shot ${shot.id}: el proveedor de imagen resolvió a fixture en una producción real.`);
  }
  const url = await persistMedia(deps, shot.id, "ai_image", asset.buffer, asset.mimeType, asset.extension, "image", deps.imageProvider.name, asset.costUsd);
  return { url, mediaType: "image", costUsd: asset.costUsd, bytes: asset.buffer.byteLength, provider: deps.imageProvider.name, reused: false };
}

function mediaResult(shot: AllocatedShot, media: MediaOutcome, executedType: ShotType, ledger: AiVideoLedgerState, deviationReason?: string): ShotExecution {
  return {
    shotId: shot.id,
    asset: { kind: "media", mediaType: media.mediaType, url: media.url },
    executedType,
    costUsd: media.costUsd,
    bufferBytes: media.bytes,
    providerUsed: media.provider,
    reused: media.reused,
    attributedCostUsd: media.reused ? (media.priorCostUsd ?? 0) : media.costUsd,
    deviation: deviationReason ? { planned: shot.type, executed: executedType, reason: deviationReason } : undefined,
    aiVideoLedger: ledger,
  };
}

function textResult(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState, reason?: string): ShotExecution {
  return {
    shotId: shot.id,
    asset: { kind: "graphic", graphic: textCardForShot(shot, deps.topic) },
    executedType: "text",
    costUsd: 0,
    bufferBytes: 0,
    providerUsed: "deterministic",
    reused: false,
    attributedCostUsd: 0,
    deviation: reason ? { planned: shot.type, executed: "text", reason } : undefined,
    aiVideoLedger: ledger,
  };
}

async function stockOrText(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState, preferVideo: boolean, reason?: string): Promise<ShotExecution> {
  const stock = (preferVideo ? await resolveStock(shot, deps, true) : null) ?? (await resolveStock(shot, deps, false));
  if (stock) {
    const executed: ShotType = stock.mediaType === "video" ? "stock_video" : "ken_burns_image";
    const sameFamily = shot.type === "stock_video" || shot.type === "stock_image" || shot.type === "ken_burns_image";
    return mediaResult(shot, stock, executed, ledger, reason ?? (sameFamily ? undefined : "fallback a archivo real"));
  }
  return textResult(shot, deps, ledger, reason ? `${reason}; archivo real no disponible` : "archivo real no disponible");
}

export async function executeShot(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState): Promise<ShotExecution> {
  switch (shot.type) {
    case "text":
    case "diagram":
    case "map":
      return textResult(shot, deps, ledger);
    case "stock_video":
      return stockOrText(shot, deps, ledger, true);
    case "stock_image":
    case "ken_burns_image":
      return stockOrText(shot, deps, ledger, false);
    case "generated_placeholder": {
      const image = await resolveAiImage(shot, deps);
      if ("unavailable" in image) return stockOrText(shot, deps, ledger, false, image.unavailable);
      return mediaResult(shot, image, "generated_placeholder", ledger);
    }
    case "ai_video": {
      const cachedClip = await reuseCompleted(deps, shot.id, "ai_video");
      if (cachedClip) {
        return mediaResult(shot, { ...cachedClip, mediaType: "video" }, "ai_video", recordAiVideoSpend(ledger, shot.durationSec, 0));
      }
      const reference = await resolveAiImage(shot, deps);
      if ("unavailable" in reference) return stockOrText(shot, deps, ledger, false, `sin imagen de referencia para video IA: ${reference.unavailable}`);
      if (!deps.videoProvider || deps.replayOnly) return mediaResult(shot, reference, "generated_placeholder", ledger, "proveedor de video IA no configurado");

      const outcome = await resolveAiVideoForShot({
        shot: { ...shot, referenceAsset: reference.url },
        totalDocumentaryDurationSec: deps.totalDurationSec,
        ledger,
        videoProvider: deps.videoProvider,
        aspectRatio: "16:9",
        costConfig: deps.aiVideoCostConfig,
        billedDurationSec: deps.units.veoBilledSeconds,
        requireReal: deps.requireReal,
        metadata: deps.metadata,
      });
      if (outcome.status === "skipped") {
        return mediaResult(shot, reference, "generated_placeholder", ledger, `video IA no generado: ${outcome.reason}`);
      }
      const url = await persistMedia(deps, shot.id, "ai_video", outcome.clip.buffer, outcome.clip.mimeType, outcome.clip.extension, "video", outcome.clip.provider, outcome.clip.costUsd);
      return mediaResult(
        shot,
        { url, mediaType: "video", costUsd: outcome.clip.costUsd + reference.costUsd, bytes: outcome.clip.buffer.byteLength, provider: outcome.clip.provider, reused: false },
        "ai_video",
        recordAiVideoSpend(ledger, shot.durationSec, outcome.clip.costUsd),
      );
    }
    default: {
      const exhaustive: never = shot.type;
      throw new Error(`executeShot: tipo no manejado ${exhaustive}`);
    }
  }
}
