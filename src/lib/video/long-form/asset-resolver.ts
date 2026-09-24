/**
 * Resuelve UN shot real (con su shot.type ya decidido por shots.ts) al
 * asset final que la composición Remotion (LongFormDoc.tsx) va a
 * renderizar. No duplica ningún proveedor: reutiliza FootageProvider e
 * ImageProvider tal cual (los mismos de Shorts, ver providers/), y solo
 * agrega el ruteo por shot.type — stock vs. generado vs. gráfico
 * determinístico (texto/diagrama/mapa, sin IA, ver diagram-map.ts).
 */
import type { FootageProvider, ImageProvider, VideoGenerationRequest, VideoProvider } from "@/lib/providers/types";
import type { Shot } from "./types";
import {
  buildFixtureDiagramSpec,
  buildFixtureMapSpec,
  buildFixtureTextCardSpec,
  type DocumentaryGraphicSpec,
} from "./diagram-map";
import { resolveAiVideoForShot } from "./ai-video-resolver";
import type { AiVideoCostConfig, AiVideoLedgerState } from "./ai-video-cost-guard";

export type ResolvedShotAsset =
  | { kind: "media"; mediaType: "image" | "video"; url: string }
  | { kind: "graphic"; graphic: DocumentaryGraphicSpec };

export type ShotAssetResult = {
  shotId: string;
  asset: ResolvedShotAsset;
  costUsd: number;
  bufferBytes: number;
  providerUsed: string;
};

/** Sube un buffer ya resuelto y devuelve una URL que Remotion puede leer — misma forma que uploadToStorage() en generate-video.ts, inyectada aquí para no acoplar este módulo a Supabase ni a ningún storage concreto. */
export type AssetUploader = (objectPath: string, buffer: Buffer, contentType: string) => Promise<{ url: string }>;

/**
 * Construye la especificación gráfica (texto/diagrama/mapa) para un shot.
 * Por defecto usa los generadores FIXTURE de diagram-map.ts — Fase B
 * (research pack real) debe inyectar aquí una función que construya specs
 * reales a partir de fuentes verificadas, nunca sustituir esto en
 * silencio por contenido inventado.
 */
export type GraphicSpecProvider = (shot: Shot) => DocumentaryGraphicSpec | undefined;

const defaultGraphicSpecProvider: GraphicSpecProvider = (shot) => {
  switch (shot.type) {
    case "text":
      return buildFixtureTextCardSpec(shot.id, shot.captionText);
    case "diagram":
      return buildFixtureDiagramSpec(shot.id);
    case "map":
      return buildFixtureMapSpec(shot.id);
    default:
      return undefined;
  }
};

export type ResolveShotAssetContext = {
  footageProvider: FootageProvider;
  imageProvider: ImageProvider;
  upload: AssetUploader;
  /** Prefijo de ruta para los objetos subidos (equivalente a artifactPrefix en generate-video.ts). */
  pathPrefix: string;
  /** Presupuesto restante para ESTE shot generado — el ImageProvider debe rechazar (budget_exceeded) si lo excede, no gastar de más. */
  imageBudgetRemainingUsd: number;
  graphicSpecFor?: GraphicSpecProvider;
  /**
   * Requerido SOLO si algún shot de este lote es de tipo "ai_video" — su
   * ausencia hace que ese shot falle explícitamente (nunca cae a un
   * fixture en silencio, ver resolveAiVideo abajo). `ledger` es el estado
   * ACTUAL del cost guard de video-IA (ai-video-cost-guard.ts) — el
   * llamador es responsable de recalcularlo entre shots con
   * `recordAiVideoSpend()` tras cada llamada, exactamente igual que ya
   * hace con `imageBudgetRemainingUsd`/`imageCostSpentUsd` — este módulo
   * nunca lo muta ni lo persiste por su cuenta.
   */
  aiVideo?: {
    videoProvider: VideoProvider;
    ledger: AiVideoLedgerState;
    /** Duración total del documental (segundos) — para el tope de % del cost guard. */
    totalDocumentaryDurationSec: number;
    aspectRatio: VideoGenerationRequest["aspectRatio"];
    costConfig?: AiVideoCostConfig;
    /** true en cualquier ejecución que se vaya a entregar como real — nunca acepta un resultado fixture (ver AiVideoProductionFixtureError). false en dry-run/simulation. */
    requireReal?: boolean;
    contextNotes?: string[];
    negativeSignals?: string[];
    metadata?: Record<string, string>;
  };
};

async function resolveStockImage(shot: Shot, ctx: ResolveShotAssetContext): Promise<ShotAssetResult> {
  const candidates = await ctx.footageProvider.searchImageCandidates?.(shot.visualIntent);
  const picked = candidates?.[0];
  const result = picked ?? (await ctx.footageProvider.fetchFootage(shot.visualIntent));
  const buffer = await ctx.footageProvider.downloadFootage(result.url);
  const uploaded = await ctx.upload(`${ctx.pathPrefix}/${shot.id}.${result.extension}`, buffer, result.mimeType);
  return {
    shotId: shot.id,
    asset: { kind: "media", mediaType: "image", url: uploaded.url },
    costUsd: 0,
    bufferBytes: buffer.byteLength,
    providerUsed: ctx.footageProvider.name,
  };
}

async function resolveStockVideo(shot: Shot, ctx: ResolveShotAssetContext): Promise<ShotAssetResult> {
  const result = await ctx.footageProvider.fetchFootage(shot.visualIntent, shot.durationSec);
  const buffer = await ctx.footageProvider.downloadFootage(result.url);
  const uploaded = await ctx.upload(`${ctx.pathPrefix}/${shot.id}.${result.extension}`, buffer, result.mimeType);
  return {
    shotId: shot.id,
    asset: { kind: "media", mediaType: result.mediaType, url: uploaded.url },
    costUsd: 0,
    bufferBytes: buffer.byteLength,
    providerUsed: ctx.footageProvider.name,
  };
}

async function resolveGeneratedImage(shot: Shot, ctx: ResolveShotAssetContext): Promise<ShotAssetResult> {
  const asset = await ctx.imageProvider.generateImage({
    prompt: shot.visualIntent,
    aspectRatio: "16:9",
    maxCostUsd: ctx.imageBudgetRemainingUsd,
  });
  const uploaded = await ctx.upload(`${ctx.pathPrefix}/${shot.id}.${asset.extension}`, asset.buffer, asset.mimeType);
  return {
    shotId: shot.id,
    asset: { kind: "media", mediaType: "image", url: uploaded.url },
    costUsd: asset.costUsd,
    bufferBytes: asset.buffer.byteLength,
    providerUsed: ctx.imageProvider.name,
  };
}

/**
 * Conecta el tier "ai_video" (VisualAssetTier, ver ai-video-resolver.ts)
 * con el switch de ShotType — RC Phase 1: antes de esto, ai-video-
 * resolver.ts estaba completamente probado pero sin ningún llamador real
 * fuera de su propio test file y del mecanismo P2B aislado. Requiere
 * `ctx.aiVideo` (nunca inventa un VideoProvider ni un ledger) — si falta,
 * lanza en vez de degradar en silencio, porque eso significaría que el
 * llamador nunca decidió conscientemente cómo pagar este shot.
 *
 * Si la elegibilidad/cost-guard/proveedor descartan el video-IA para este
 * shot (`outcome.status === "skipped"` — nunca lanza por esto, es un
 * resultado esperado del propio diseño del resolver), degrada a una
 * imagen de stock REAL — jamás a un fixture — mismo criterio que el
 * resto de este archivo: un fixture solo puede aparecer si
 * footageProvider/imageProvider mismos lo devuelven (p. ej. en modo
 * simulation), nunca porque este resolver lo sustituya por su cuenta.
 */
async function resolveAiVideo(shot: Shot, ctx: ResolveShotAssetContext): Promise<ShotAssetResult> {
  if (!ctx.aiVideo) {
    throw new Error(
      `resolveShotAsset: el shot ${shot.id} es de tipo "ai_video" pero no se proveyó ctx.aiVideo (videoProvider/ledger/aspectRatio/...) — nunca se degrada en silencio a otro tratamiento por falta de contexto.`,
    );
  }
  const outcome = await resolveAiVideoForShot({
    shot,
    totalDocumentaryDurationSec: ctx.aiVideo.totalDocumentaryDurationSec,
    ledger: ctx.aiVideo.ledger,
    videoProvider: ctx.aiVideo.videoProvider,
    aspectRatio: ctx.aiVideo.aspectRatio,
    costConfig: ctx.aiVideo.costConfig,
    requireReal: ctx.aiVideo.requireReal,
    contextNotes: ctx.aiVideo.contextNotes,
    negativeSignals: ctx.aiVideo.negativeSignals,
    metadata: ctx.aiVideo.metadata,
  });

  if (outcome.status === "generated") {
    const uploaded = await ctx.upload(`${ctx.pathPrefix}/${shot.id}.${outcome.clip.extension}`, outcome.clip.buffer, outcome.clip.mimeType);
    return {
      shotId: shot.id,
      asset: { kind: "media", mediaType: "video", url: uploaded.url },
      costUsd: outcome.clip.costUsd,
      bufferBytes: outcome.clip.buffer.byteLength,
      providerUsed: outcome.clip.provider,
    };
  }
  return resolveStockImage(shot, ctx);
}

function resolveGraphic(shot: Shot, ctx: ResolveShotAssetContext): ShotAssetResult {
  const graphicSpecFor = ctx.graphicSpecFor ?? defaultGraphicSpecProvider;
  const graphic = graphicSpecFor(shot);
  if (!graphic) {
    throw new Error(`resolveShotAsset: no hay especificación gráfica para el shot ${shot.id} (tipo ${shot.type})`);
  }
  return { shotId: shot.id, asset: { kind: "graphic", graphic }, costUsd: 0, bufferBytes: 0, providerUsed: "deterministic" };
}

export async function resolveShotAsset(shot: Shot, ctx: ResolveShotAssetContext): Promise<ShotAssetResult> {
  switch (shot.type) {
    case "text":
    case "diagram":
    case "map":
      return resolveGraphic(shot, ctx);
    case "generated_placeholder":
      return resolveGeneratedImage(shot, ctx);
    case "stock_video":
      return resolveStockVideo(shot, ctx);
    case "stock_image":
    case "ken_burns_image":
      return resolveStockImage(shot, ctx);
    case "ai_video":
      return resolveAiVideo(shot, ctx);
    default: {
      const exhaustive: never = shot.type;
      throw new Error(`resolveShotAsset: shot.type no manejado: ${exhaustive}`);
    }
  }
}
