import { SupplyUnavailableError } from "@/lib/supply/policy";
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
import type { FootageCandidate, FootageProvider, GenerativeAsset, ImageProvider, VideoProvider } from "@/lib/providers/types";
import { guardPaidCall, type LedgerStore } from "@/lib/paid-calls/gate";
import { PaidResultUnavailableError } from "@/lib/paid-calls/errors";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { MotionRequiredUnsatisfiableError } from "./production-plan";
import { GenerativeProviderError } from "@/lib/providers/types";
import { validateVisualAssetBuffer } from "../visual-asset-validation";
import type { ResolvedShotAsset } from "./asset-resolver";
import { resolveAiVideoForShot } from "./ai-video-resolver";
import { recordAiVideoSpend, type AiVideoCostConfig, type AiVideoLedgerState } from "./ai-video-cost-guard";
import type { AssetProvenance, AssetSelectionTrace, ShotAssetKind, ShotAssetStore } from "./durable-shot-assets";
import { contentIdentity, DocumentAssetRegistry, type AssetIdentity } from "./asset-identity";
import { selectStockForShot } from "./stock-selection";
import { clip, salientFact } from "./scene-anchoring";
import type { ProductionBudget } from "./production-budget";
import type { AllocatedShot, GenerativeUnitCosts } from "./production-plan";
import { documentaryImagePrompt, textCardForShot } from "./visual-intents";
import type { Shot, ShotType } from "./types";
import type { BeatVisual } from "./visual-intents";

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
  /**
   * Puerta de llamadas pagadas (PI V2 B1, RB-01): `pi_paid_operations`. produce.ts pasa la real
   * (Supabase). Si falta, se usa una en memoria POR OBJETO deps (solo válida dentro del proceso;
   * pensada para pruebas): nunca es un sustituto del ledger durable en producción.
   */
  ledger?: LedgerStore;
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
  /**
   * Planes v3+: selección por pertinencia + identidad de contenido en todo
   * el documental (stock-selection.ts, asset-identity.ts), procedencia en
   * cada registro y tarjetas ancladas a la narración. Ausente = v1/v2 sin
   * cambios.
   */
  visualPipeline?: "anchored_v1";
  /** Registro de identidad del documental — obligatorio con visualPipeline. */
  registry?: DocumentAssetRegistry;
  /** Inyectable en pruebas (evita ffmpeg/sharp). */
  identify?: (buffer: Buffer, mediaType: "image" | "video") => Promise<Pick<AssetIdentity, "sha256" | "dhash" | "dhashUnavailable">>;
};

/** Qué recurso ocupa la escena y por qué (insumo del informe previo al render). */
export type ShotAssetMeta = {
  objectPath?: string;
  identity?: AssetIdentity;
  provenance?: AssetProvenance;
  selection?: AssetSelectionTrace;
  /** Carencia registrada: no había material pertinente y único (la escena quedó como tarjeta). */
  gap?: { reason: string; queries?: string[]; rejected?: AssetSelectionTrace["rejected"] };
};

/** Duración extra que debe tener un clip de archivo sobre su escena (alineación a la voz + cola de fundido). */
export const STOCK_CLIP_MARGIN_SEC = 1.2;

const PEXELS_LICENSE = "Pexels License (uso libre, atribución no obligatoria) — https://www.pexels.com/license/";

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
  assetMeta?: ShotAssetMeta;
};

type MediaOutcome = {
  url: string;
  mediaType: "image" | "video";
  costUsd: number;
  bytes: number;
  provider: string;
  reused: boolean;
  priorCostUsd?: number;
  meta?: ShotAssetMeta;
};

type GapOutcome = { gap: NonNullable<ShotAssetMeta["gap"]> };

async function reuseCompleted(deps: ShotExecutionDeps, shotId: string, kind: ShotAssetKind): Promise<MediaOutcome | null> {
  const record = await deps.store.read(shotId, kind);
  if (record?.status !== "COMPLETED" || !record.objectPath) return null;
  try {
    const url = await deps.store.signedUrl(record.objectPath);
    if (record.identity) deps.registry?.register(shotId, record.identity);
    return {
      url,
      mediaType: record.mediaType ?? "image",
      costUsd: 0,
      bytes: 0,
      provider: record.provider ?? "cache",
      reused: true,
      priorCostUsd: record.costUsd ?? 0,
      meta: { objectPath: record.objectPath, identity: record.identity, provenance: record.provenance, selection: record.selection },
    };
  } catch (err) {
    if (err instanceof SupplyUnavailableError) throw err;
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
  extra: { identity?: AssetIdentity; provenance?: AssetProvenance; selection?: AssetSelectionTrace } = {},
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
    ...extra,
  });
  if (extra.identity) deps.registry?.register(shotId, extra.identity);
  return deps.store.signedUrl(objectPath);
}

/**
 * v3: archivo por pertinencia + identidad de contenido en todo el
 * documental. Sin candidato pertinente y único → carencia explícita.
 */
async function resolveStockAnchored(shot: AllocatedShot, deps: ShotExecutionDeps, preferVideo: boolean): Promise<MediaOutcome | GapOutcome | null> {
  const cached = await reuseCompleted(deps, shot.id, "stock");
  if (cached) return cached;
  if (deps.replayOnly) return null;
  if (!deps.registry) throw new Error("visualPipeline anchored_v1 requiere un DocumentAssetRegistry");
  const visual = shot.anchoredVisual ?? { description: shot.visualIntent, motion: false };
  const outcome = await selectStockForShot(
    // Margen: el corte puede desplazarse hasta ±0.6 s al alinearse con la voz y un fundido añade cola.
    { shotId: shot.id, visual, preferVideo, minDurationSec: shot.durationSec + STOCK_CLIP_MARGIN_SEC },
    { footageProvider: deps.footageProvider, registry: deps.registry, identify: deps.identify },
  );
  if (outcome.status === "gap") {
    return { gap: { reason: outcome.reason, queries: outcome.queries, rejected: outcome.rejected.slice(0, 12) } };
  }
  const { candidate } = outcome;
  const provenance: AssetProvenance = {
    kind: "stock_illustrative",
    provider: deps.footageProvider.name,
    license: PEXELS_LICENSE,
    author: candidate.photographer,
    pageUrl: candidate.pageUrl,
  };
  const selection: AssetSelectionTrace = {
    query: outcome.query,
    tier: outcome.tier,
    relevance: outcome.assessment.relevance === "keyword_match" ? "keyword_match" : "unverified",
    score: outcome.assessment.score,
    matchedTerms: outcome.assessment.matchedTerms,
    candidateDescription: candidate.description,
    candidatesConsidered: outcome.candidatesConsidered,
    rejected: outcome.rejected.slice(0, 12),
  };
  const url = await persistMedia(deps, shot.id, "stock", outcome.buffer, candidate.mimeType, candidate.extension, candidate.mediaType, deps.footageProvider.name, 0, {
    identity: outcome.identity,
    provenance,
    selection,
  });
  return {
    url,
    mediaType: candidate.mediaType,
    costUsd: 0,
    bytes: outcome.buffer.byteLength,
    provider: deps.footageProvider.name,
    reused: false,
    meta: { objectPath: deps.store.objectPathFor(shot.id, "stock", candidate.extension), identity: outcome.identity, provenance, selection },
  };
}

/** Prompt de imagen IA con el contexto de lugar/época de la intención anclada (recreación, nunca "foto histórica"). */
function aiImagePromptFor(shot: AllocatedShot): string {
  const v = shot.anchoredVisual;
  const context = v ? [v.place && `in ${v.place}`, v.era && `during ${v.era}`].filter(Boolean).join(", ") : "";
  return documentaryImagePrompt(context ? `${shot.visualIntent} (${context}; historically plausible recreation)` : shot.visualIntent);
}

/** Archivo real (Pexels, 16:9). v1/v2: consulta del shot y luego el tema (histórico); v3: resolveStockAnchored. */
async function resolveStock(shot: AllocatedShot, deps: ShotExecutionDeps, preferVideo: boolean): Promise<MediaOutcome | GapOutcome | null> {
  if (deps.visualPipeline === "anchored_v1") return resolveStockAnchored(shot, deps, preferVideo);
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
      if (err instanceof SupplyUnavailableError) throw err;
      console.warn(`[atomivid:long-form:shot] archivo no disponible para ${shot.id} ("${query}"):`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

type AiImageOutcome = MediaOutcome | { unavailable: string };

const inProcessLedgers = new WeakMap<object, LedgerStore>();
function ledgerFor(deps: ShotExecutionDeps): LedgerStore {
  if (deps.ledger) return deps.ledger;
  let l = inProcessLedgers.get(deps);
  if (!l) {
    l = memoryLedgerStore();
    inProcessLedgers.set(deps, l);
  }
  return l;
}

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

  const request = {
    prompt: deps.visualPipeline === "anchored_v1" ? aiImagePromptFor(shot) : documentaryImagePrompt(shot.visualIntent),
    aspectRatio: "16:9" as const,
    maxCostUsd: deps.units.imageUsd,
  };
  const persistImage = async (asset: GenerativeAsset): Promise<MediaOutcome> => {
    if (deps.visualPipeline === "anchored_v1") {
      // Recreación IA: identidad de contenido (para el registro del documental) y procedencia explícita.
      const identity: AssetIdentity = { provider: deps.imageProvider.name, ...(await (deps.identify ?? contentIdentity)(asset.buffer, "image")) };
      const provenance: AssetProvenance = { kind: "ai_recreation", provider: deps.imageProvider.name, license: "Generada por IA para este documental — recreación, no registro histórico" };
      const selection: AssetSelectionTrace = { relevance: "generated_from_intent", query: shot.visualIntent };
      const url = await persistMedia(deps, shot.id, "ai_image", asset.buffer, asset.mimeType, asset.extension, "image", deps.imageProvider.name, asset.costUsd, {
        identity,
        provenance,
        selection,
      });
      return {
        url,
        mediaType: "image",
        costUsd: asset.costUsd,
        bytes: asset.buffer.byteLength,
        provider: deps.imageProvider.name,
        reused: false,
        meta: { objectPath: deps.store.objectPathFor(shot.id, "ai_image", asset.extension), identity, provenance, selection },
      };
    }
    const url = await persistMedia(deps, shot.id, "ai_image", asset.buffer, asset.mimeType, asset.extension, "image", deps.imageProvider.name, asset.costUsd);
    return { url, mediaType: "image", costUsd: asset.costUsd, bytes: asset.buffer.byteLength, provider: deps.imageProvider.name, reused: false };
  };

  let asset: GenerativeAsset;
  // PI V2 COST-7: a paid image is made durable (object + COMPLETED record) BEFORE its ledger row
  // is committed, so a crash in between leaves a reusable asset instead of a paid, lost one. A
  // storage failure still commits the row (the provider charged) and then fails the shot as before.
  let persisted: MediaOutcome | undefined;
  let persistError: unknown;
  try {
    if (deps.imageProvider.name === "fixture") {
      asset = await deps.imageProvider.generateImage(request);
    } else {
      // Puerta de llamadas pagadas (PI V2 B1, RB-01): fila en pi_paid_operations antes del HTTP;
      // COMMITTED sin registro COMPLETED (el reuso de arriba no lo encontró) no regenera.
      const guarded = await guardPaidCall<GenerativeAsset>(
        ledgerFor(deps),
        {
          projectId: deps.metadata?.requestId ?? "unknown-request",
          shotId: `ai_image:${shot.id}`,
          provider: deps.imageProvider.name,
          model: deps.imageProvider.name,
          method: "generate_image",
          inputFingerprint: { prompt: request.prompt, aspectRatio: request.aspectRatio },
          reservedUsd: Math.max(0, deps.units.imageUsd),
        },
        {
          call: async () => {
            const a = await deps.imageProvider.generateImage({ ...request, disableRetries: true });
            // Same contract as Reel generated images: never trust "the call did not throw" as "the
            // file is usable". An invalid file is paid but unusable: the gate treats it as uncertain
            // (no new call) and the shot uses its existing fallback (ASSET-FINAL).
            const validation = validateVisualAssetBuffer(a.buffer, a.mimeType);
            if (!validation.valid) throw new Error(`Imagen IA inválida de "${deps.imageProvider.name}": ${validation.reason}`);
            try {
              persisted = await persistImage(a);
            } catch (err) {
              if (err instanceof SupplyUnavailableError) throw err;
              persistError = err;
            }
            return { result: a, costUsd: a.costUsd, resultRef: `shot-asset:${shot.id}:ai_image` };
          },
          load: async () => null,
          // El proveedor ya reintenta una vez por su cuenta ante un rechazo explícito (openai.ts).
          maxRejectedRetries: 0,
        },
      );
      asset = guarded.result;
    }
  } catch (err) {
    if (err instanceof SupplyUnavailableError) throw err;
    if (err instanceof PaidResultUnavailableError) {
      // Nada se envió ni se cobró en este intento: la reserva vuelve al presupuesto.
      await deps.budget.releaseAiImage(deps.units.imageUsd);
      return { unavailable: "esta imagen ya se pagó en un intento anterior y su resultado no está disponible — no se regenera" };
    }
    if (err instanceof GenerativeProviderError && NO_CHARGE_IMAGE_REASONS.has(err.reason)) {
      await deps.store.write({ shotId: shot.id, kind: "ai_image", status: "FAILED_NO_CHARGE", provider: deps.imageProvider.name, updatedAtIso: new Date().toISOString() });
      await deps.budget.releaseAiImage(deps.units.imageUsd);
      return { unavailable: `imagen IA rechazada sin costo (${err.reason})` };
    }
    // Costo incierto: queda STARTED (nunca se regenera) y la reserva queda contada.
    return { unavailable: `imagen IA falló (${err instanceof GenerativeProviderError ? err.reason : "error inesperado"})` };
  }
  if (persistError !== undefined) throw persistError;
  if (persisted) return persisted;
  if (deps.requireReal && deps.imageProvider.name === "fixture") {
    throw new Error(`Shot ${shot.id}: el proveedor de imagen resolvió a fixture en una producción real.`);
  }
  return persistImage(asset);
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
    assetMeta: media.meta,
  };
}

/**
 * Tarjeta anclada (v3): el dato destacable del pasaje como título y el
 * propio pasaje, breve, como cuerpo — nunca el título del documental.
 * Sin dato (tarjeta por CARENCIA): solo el pasaje, como título grande.
 */
export function anchoredTextCard(shot: { narrationFragment?: string; captionText: string }): { kind: "text"; title: string; body: string; isFixture: false; size: "large" } {
  const fragment = shot.narrationFragment ?? shot.captionText;
  const fact = salientFact(fragment);
  // "large": título ≥ 72 px / cuerpo ≥ 44 px; los límites de caracteres garantizan que cabe (render-approval.ts lo comprueba).
  return fact
    ? { kind: "text", title: fact, body: clip(fragment, 110), isFixture: false, size: "large" }
    : { kind: "text", title: clip(fragment, 90), body: "", isFixture: false, size: "large" };
}

function textResult(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState, reason?: string, gap?: ShotAssetMeta["gap"]): ShotExecution {
  const anchored = deps.visualPipeline === "anchored_v1" && shot.narrationFragment !== undefined;
  return {
    shotId: shot.id,
    asset: { kind: "graphic", graphic: anchored ? anchoredTextCard(shot) : textCardForShot(shot, deps.topic) },
    executedType: "text",
    costUsd: 0,
    bufferBytes: 0,
    providerUsed: "deterministic",
    reused: false,
    attributedCostUsd: 0,
    deviation: reason ? { planned: shot.type, executed: "text", reason } : undefined,
    aiVideoLedger: ledger,
    assetMeta: gap ? { gap } : undefined,
  };
}

async function stockOrText(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState, preferVideo: boolean, reason?: string): Promise<ShotExecution> {
  if (deps.visualPipeline === "anchored_v1") {
    // Una sola selección (video primero y luego fotos, dentro de stock-selection.ts).
    const outcome = await resolveStock(shot, deps, preferVideo);
    if (outcome && "gap" in outcome) {
      return textResult(shot, deps, ledger, `${reason ? `${reason}; ` : ""}carencia de material pertinente: ${outcome.gap.reason}`, outcome.gap);
    }
    if (outcome) {
      const executed: ShotType = outcome.mediaType === "video" ? "stock_video" : "ken_burns_image";
      const sameFamily = shot.type === "stock_video" || shot.type === "stock_image" || shot.type === "ken_burns_image";
      return mediaResult(shot, outcome, executed, ledger, reason ?? (sameFamily ? undefined : "fallback a archivo real"));
    }
    return textResult(shot, deps, ledger, reason ? `${reason}; archivo real no disponible` : "archivo real no disponible");
  }
  const first = preferVideo ? await resolveStock(shot, deps, true) : null;
  const stock = (first && !("gap" in first) ? first : null) ?? (await resolveStock(shot, deps, false));
  if (stock && "gap" in stock) return textResult(shot, deps, ledger, reason ? `${reason}; archivo real no disponible` : "archivo real no disponible");
  if (stock) {
    const executed: ShotType = stock.mediaType === "video" ? "stock_video" : "ken_burns_image";
    const sameFamily = shot.type === "stock_video" || shot.type === "stock_image" || shot.type === "ken_burns_image";
    return mediaResult(shot, stock, executed, ledger, reason ?? (sameFamily ? undefined : "fallback a archivo real"));
  }
  return textResult(shot, deps, ledger, reason ? `${reason}; archivo real no disponible` : "archivo real no disponible");
}

/**
 * PI V2 B5.2 (RB-08): per-visual reservation of moving stock clips, made BEFORE TTS. Each clip is a
 * normal COMPLETED `stock` record in the request's durable shot store, keyed by
 * `motionres-${visualId}-${k}` instead of a shot id (the production id is the store's scope).
 * Selection uses selectStockForShot itself (relevance, dedupe by provider id / canonical URL,
 * download, empty-file and SHA-256 / perceptual-hash checks) over a video-only view of the footage
 * provider that keeps only clips at least `minDurationSec` long. A retry reads the durable records
 * and searches nothing; replay never searches.
 */
export type MotionVisualDemand = { visualId: string; visual: BeatVisual; clips: number; minDurationSec: number };
export type ReservedMotionClip = { ref: string; durationSec: number; identity?: AssetIdentity };
export const motionReservationRef = (visualId: string, k: number) => `motionres-${visualId}-${k}`;

function videoOnlyFootage(provider: FootageProvider, minDurationSec: number): FootageProvider {
  return {
    name: provider.name,
    fetchFootage: (q, min, o) => provider.fetchFootage(q, min, o),
    downloadFootage: (url) => provider.downloadFootage(url),
    async searchVideoCandidates(query, min, orientation) {
      const raw: FootageCandidate[] = provider.searchVideoCandidates
        ? await provider.searchVideoCandidates(query, min, orientation)
        : await provider.fetchFootage(query, min, orientation).then((r) => (r ? [{ ...r, sourceId: "" }] : []));
      return raw.filter((c) => c.mediaType === "video" && typeof c.durationSeconds === "number" && c.durationSeconds >= minDurationSec);
    },
  };
}

export async function reserveMotionClips(
  demands: readonly MotionVisualDemand[],
  deps: {
    footageProvider: FootageProvider;
    store: ShotAssetStore;
    identify?: (buffer: Buffer, mediaType: "image" | "video") => Promise<Pick<AssetIdentity, "sha256" | "dhash" | "dhashUnavailable">>;
  },
  opts: { searchAllowed: boolean },
): Promise<Map<string, ReservedMotionClip[]>> {
  const registry = new DocumentAssetRegistry();
  const out = new Map<string, ReservedMotionClip[]>();
  // Already-reserved clips first (retry/replay): they are reused as-is and block duplicates.
  const existing = new Map<string, (ReservedMotionClip | null)[]>();
  for (const d of demands) {
    const clips: (ReservedMotionClip | null)[] = [];
    for (let k = 0; k < d.clips; k++) {
      const ref = motionReservationRef(d.visualId, k);
      const rec = await deps.store.read(ref, "stock");
      const ok = rec?.status === "COMPLETED" && rec.objectPath && rec.mediaType === "video" && typeof rec.clipDurationSec === "number";
      clips.push(ok ? { ref, durationSec: rec!.clipDurationSec!, identity: rec!.identity } : null);
      if (ok && rec!.identity) registry.register(ref, rec!.identity);
    }
    existing.set(d.visualId, clips);
  }
  for (const d of demands) {
    const clips = existing.get(d.visualId)!;
    for (let k = 0; k < d.clips; k++) {
      if (clips[k]) continue;
      if (!opts.searchAllowed) throw new MotionRequiredUnsatisfiableError(d.visualId, `reserva de movimiento incompleta (falta el clip ${k + 1} de ${d.clips}) y esta ejecución no puede buscar`);
      const ref = motionReservationRef(d.visualId, k);
      const outcome = await selectStockForShot(
        { shotId: ref, visual: d.visual, preferVideo: true, minDurationSec: d.minDurationSec },
        { footageProvider: videoOnlyFootage(deps.footageProvider, d.minDurationSec), registry, identify: deps.identify },
      );
      if (outcome.status === "gap") {
        throw new MotionRequiredUnsatisfiableError(d.visualId, `solo ${k} de ${d.clips} clips en movimiento reservables de al menos ${d.minDurationSec.toFixed(1)} s: ${outcome.reason}`);
      }
      const { candidate, buffer } = outcome;
      const identity = outcome.identity;
      const objectPath = deps.store.objectPathFor(ref, "stock", candidate.extension);
      await deps.store.putObject(objectPath, buffer, candidate.mimeType);
      await deps.store.write({
        shotId: ref,
        kind: "stock",
        status: "COMPLETED",
        objectPath,
        contentType: candidate.mimeType,
        mediaType: "video",
        costUsd: 0,
        provider: deps.footageProvider.name,
        bytes: buffer.byteLength,
        updatedAtIso: new Date().toISOString(),
        identity,
        provenance: { kind: "stock_illustrative", provider: deps.footageProvider.name, license: PEXELS_LICENSE, author: candidate.photographer, pageUrl: candidate.pageUrl },
        selection: {
          query: outcome.query,
          tier: outcome.tier,
          relevance: outcome.assessment.relevance === "keyword_match" ? "keyword_match" : "unverified",
          score: outcome.assessment.score,
          matchedTerms: outcome.assessment.matchedTerms,
          candidateDescription: candidate.description,
          candidatesConsidered: outcome.candidatesConsidered,
          rejected: outcome.rejected.slice(0, 12),
        },
        clipDurationSec: candidate.durationSeconds,
      });
      registry.register(ref, identity);
      clips[k] = { ref, durationSec: candidate.durationSeconds!, identity };
    }
    out.set(d.visualId, clips as ReservedMotionClip[]);
  }
  return out;
}

/**
 * PI V2 B5.2: binds each motion shot (timeline order) to the next free reserved clip of its visual.
 * A shot never lasts longer than its clip allows (clip ≥ shot + STOCK_CLIP_MARGIN_SEC): when the
 * measured timing asks for more, the shot is split into equal parts, each consuming the next
 * reserved clip (extra parts are stock_video). No clip left → MotionShotUnavailableError.
 * Shots without motion are returned untouched.
 */
export function bindMotionReservations<S extends Shot>(shots: readonly S[], reservations: ReadonlyMap<string, readonly ReservedMotionClip[]>): S[] {
  const cursor = new Map<string, number>();
  const out: S[] = [];
  for (const shot of shots) {
    if (!shot.motionRequired) {
      out.push(shot);
      continue;
    }
    const visualId = shot.motionVisualId ?? "";
    const clips = reservations.get(visualId) ?? [];
    const at = cursor.get(visualId) ?? 0;
    let parts = 1;
    for (;;) {
      if (at + parts > clips.length) {
        throw new MotionShotUnavailableError(shot.id, `la reserva de la escena ${visualId || "(sin visual)"} no cubre ${shot.durationSec.toFixed(2)} s (${clips.length - at} clips libres)`);
      }
      const partSec = shot.durationSec / parts;
      if (clips.slice(at, at + parts).every((c) => c.durationSec >= partSec + STOCK_CLIP_MARGIN_SEC)) break;
      parts += 1;
    }
    const partSec = shot.durationSec / parts;
    for (let j = 0; j < parts; j++) {
      const startSec = Math.round((shot.startSec + j * partSec) * 1000) / 1000;
      const endSec = j === parts - 1 ? shot.endSec : Math.round((shot.startSec + (j + 1) * partSec) * 1000) / 1000;
      const base = { ...shot, startSec, endSec, durationSec: Math.round((endSec - startSec) * 1000) / 1000, motionClipRef: clips[at + j].ref };
      out.push(
        j === 0
          ? base
          : { ...base, id: `${shot.id}-m${j + 1}`, type: "stock_video", source: "stock", motion: "pan", dedupKey: `${shot.dedupKey}:m${j + 1}` },
      );
    }
    cursor.set(visualId, at + parts);
  }
  return out;
}

/** A motion-required shot could not get moving footage. The job stops; nothing is substituted. */
export class MotionShotUnavailableError extends Error {
  constructor(readonly shotId: string, readonly reason: string) {
    super(`La escena ${shotId} requiere movimiento y no se obtuvo video (${reason}). No se sustituye por una imagen fija ni una tarjeta: la producción se detiene.`);
    this.name = "MotionShotUnavailableError";
  }
}

/**
 * PI V2 B5.1 (RB-08): a shot whose visual requires motion executes only as AI video or stock
 * video. AI video refused/unavailable → moving stock; no moving stock → MotionShotUnavailableError.
 * Never generated_placeholder, Ken Burns, a still or a text card.
 */
async function executeMotionShot(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState): Promise<ShotExecution> {
  let reason: string | undefined;
  if (shot.type === "ai_video") {
    const cachedClip = await reuseCompleted(deps, shot.id, "ai_video");
    if (cachedClip) {
      return mediaResult(shot, { ...cachedClip, mediaType: "video" }, "ai_video", recordAiVideoSpend(ledger, shot.durationSec, 0));
    }
    if (!deps.videoProvider || deps.replayOnly) {
      reason = "proveedor de video IA no configurado";
    } else {
      const reference = await resolveAiImage(shot, deps);
      if ("unavailable" in reference) {
        reason = `sin imagen de referencia para video IA: ${reference.unavailable}`;
      } else {
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
        if (outcome.status !== "skipped") {
          const url = await persistMedia(deps, shot.id, "ai_video", outcome.clip.buffer, outcome.clip.mimeType, outcome.clip.extension, "video", outcome.clip.provider, outcome.clip.costUsd);
          return mediaResult(
            shot,
            { url, mediaType: "video", costUsd: outcome.clip.costUsd + reference.costUsd, bytes: outcome.clip.buffer.byteLength, provider: outcome.clip.provider, reused: false },
            "ai_video",
            recordAiVideoSpend(ledger, shot.durationSec, outcome.clip.costUsd),
          );
        }
        reason = `video IA no generado: ${outcome.reason}`;
      }
    }
  }
  // PI V2 B5.2: only the clip reserved before TTS — no new search, no other candidate.
  const prefix = reason ? `${reason}; ` : "";
  if (!shot.motionClipRef) throw new MotionShotUnavailableError(shot.id, `${prefix}sin clip en movimiento reservado`);
  const rec = await deps.store.read(shot.motionClipRef, "stock");
  if (rec?.status !== "COMPLETED" || !rec.objectPath || rec.mediaType !== "video") {
    throw new MotionShotUnavailableError(shot.id, `${prefix}el clip reservado ${shot.motionClipRef} no está disponible`);
  }
  if (!(typeof rec.clipDurationSec === "number" && rec.clipDurationSec >= shot.durationSec + STOCK_CLIP_MARGIN_SEC)) {
    throw new MotionShotUnavailableError(shot.id, `${prefix}el clip reservado (${rec.clipDurationSec ?? "?"} s) no cubre la escena (${shot.durationSec.toFixed(2)} s + margen)`);
  }
  const url = await deps.store.signedUrl(rec.objectPath);
  return mediaResult(
    shot,
    {
      url,
      mediaType: "video",
      costUsd: 0,
      bytes: rec.bytes ?? 0,
      provider: rec.provider ?? deps.footageProvider.name,
      reused: true,
      meta: { objectPath: rec.objectPath, identity: rec.identity, provenance: rec.provenance, selection: rec.selection },
    },
    "stock_video",
    ledger,
    shot.type === "stock_video" ? undefined : reason ?? "la escena requiere movimiento",
  );
}

export async function executeShot(shot: AllocatedShot, deps: ShotExecutionDeps, ledger: AiVideoLedgerState): Promise<ShotExecution> {
  if (shot.motionRequired) return executeMotionShot(shot, deps, ledger);
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
