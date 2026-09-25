/**
 * RC Phase 1 — versión "job real" del pipeline de Long Form, para que
 * `runRenderJob()` (src/lib/video/run-job.ts) pueda ejecutarlo exactamente
 * igual que ya ejecuta Reel (generateVideoFromScript) y Avatar
 * (generateAvatarVideo): a partir de una fila `video_requests` ya en
 * "processing", sin depender de que el navegador siga abierto (el worker
 * de GitHub Actions o el inline la disparan igual para las tres
 * modalidades, ver src/lib/worker/).
 *
 * NO sustituye a scripts/produce-long-form-video.ts (ese sigue siendo el
 * CLI para producir VIDEO #001 y correr fixtures/simulation localmente) —
 * es la ruta de PRODUCCIÓN real, sin los atajos específicos de ese CLI
 * (servidor HTTP local sobre un directorio temporal, hacks de VIDEO #001,
 * modo simulation). Reutiliza exactamente los mismos módulos ya probados:
 * mode.ts (nunca resuelve a fixture en silencio en modo real, ver
 * LongFormRealProviderMissingError), timeline.ts, cost.ts,
 * asset-resolver.ts (incluida su rama "ai_video" ya conectada, ver RC
 * Phase 1 anterior), captions.ts, audio-master.ts, render.ts.
 *
 * Durabilidad de cualquier clip de video-IA (Veo/Runway/Kling): el
 * VideoProvider real se envuelve con wrapDurableVideoProvider()
 * (ai-video-durable-provider.ts) — un retry de este mismo requestId
 * (nuevo render_attempts) nunca vuelve a pagar un shot ya generado con
 * éxito, reutiliza el registro STARTED/COMPLETED de ai-video-storage.ts.
 */
import fs from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCaptions } from "../captions";
import { buildEmphasisSet } from "../caption-emphasis";
import { LOUDNESS_TARGET, masterAudioLoudness } from "../audio-master";
import { VIDEO_TAIL_SECONDS } from "../script-pacing";
import { computeNarrationGaps } from "../../../../remotion/audio-mix";
import { getVideoProvider } from "@/lib/providers/video-gen";
import { getVoiceIdentity } from "@/lib/ai/voice";
import type { MusicResult, ScriptLanguage, VideoProvider } from "@/lib/providers/types";
import { resolveLongFormProviders, type LongFormProviderSet } from "./mode";
import { buildLongFormTimeline, type BeatSynthesizer } from "./timeline";
import { shotsForSpan } from "./shots";
import { renderLongFormDoc, type RenderLongFormDocInput } from "./render";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import { emptyAiVideoLedgerState } from "./ai-video-cost-guard";
import { synthesizeBeatNarrationProductionCached } from "./production-tts-cache";
import { visualsForBeat } from "./visual-intents";
import {
  allocateShotTypes,
  executionAllocation,
  getGenerativeUnitCosts,
  isLongFormAiVideoConfigured,
  limitsWithinAllocation,
  strategyLimits,
  type ProductionPlan,
} from "./production-plan";
import { ProductionBudget, supabaseBudgetStore, type BudgetStore } from "./production-budget";
import { supabaseShotAssetStore, type ShotAssetStore } from "./durable-shot-assets";
import { executeShot, type ShotExecution } from "./shot-executor";
import { type LongFormStage } from "./stages";
import { recordVideoGeneration } from "@/lib/billing/usage";

const STORAGE_BUCKET = "videos";
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;
/** Por encima de esta fracción de shots degradados a tarjeta de texto, el documental no se entrega (calidad insuficiente). */
export const MAX_TEXT_FALLBACK_RATIO = 0.25;

/**
 * `units` lleva progreso REAL por unidad de trabajo dentro de la etapa:
 * narraciones sintetizadas (storyboard), escenas resueltas (assets),
 * fotogramas renderizados (rendering). Nunca inventado — ver progress.ts.
 */
export type LongFormProgressUnits = { completed: number; total: number; label: string };
type OnProgress = (stage: LongFormStage, units?: LongFormProgressUnits) => void | Promise<void>;

/** Dependencias inyectables (pruebas / inyección de fallos). En producción se omiten todas. */
export type LongFormRuntime = {
  store?: ShotAssetStore;
  budgetStore?: BudgetStore;
  /** `null` fuerza "sin proveedor de video IA"; ausente = el real (envuelto durable) solo si el plan lo permite. */
  videoProvider?: VideoProvider | null;
  synthesizeBeat?: BeatSynthesizer;
  uploadArtifact?: (objectPath: string, buffer: Buffer, contentType: string) => Promise<{ path: string; url: string }>;
  render?: (input: RenderLongFormDocInput) => Promise<string>;
  aiVideoEnabled?: boolean;
  recordCosts?: boolean;
  resumeBackoffMs?: number;
};

export class LongFormScriptChangedError extends Error {
  constructor() {
    super("El guion cambió después de confirmar el plan de producción — no se ejecuta un plan distinto al confirmado.");
    this.name = "LongFormScriptChangedError";
  }
}

export class LongFormQualityError extends Error {
  constructor(degraded: number, total: number) {
    super(
      `Demasiadas escenas sin material real (${degraded}/${total} degradadas a tarjeta de texto) — no se entrega un documental de baja calidad. ` +
        "Los recursos ya obtenidos quedan guardados; un reintento no los vuelve a pagar.",
    );
    this.name = "LongFormQualityError";
  }
}

export { isLongFormScriptJson, type LongFormScriptBeatInput, type LongFormScriptJson } from "./script-json";
import type { LongFormScriptBeatInput } from "./script-json";

export async function generateLongFormVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  topic,
  beats,
  language = "es",
  onProgress,
  providers,
  plan,
  runtime = {},
}: {
  supabase: SupabaseClient;
  requestId: string;
  artifactPrefix?: string;
  topic: string;
  beats: LongFormScriptBeatInput[];
  language?: ScriptLanguage;
  onProgress?: OnProgress;
  /** Inyección para pruebas — en producción siempre se omite (nunca fixture en silencio, ver mode.ts). */
  providers?: LongFormProviderSet;
  /** Snapshot CONFIRMADO (long_form_production_plan) — el worker ejecuta exactamente su estrategia y nunca excede su allocation. */
  plan: ProductionPlan;
  runtime?: LongFormRuntime;
}): Promise<{ videoPath: string; deviations: number; spentUsd: number }> {
  const voiceCharacters = beats.reduce((sum, b) => sum + b.narration.length, 0);
  if (voiceCharacters !== plan.voiceCharacters) throw new LongFormScriptChangedError();

  const resolvedProviders = providers ?? resolveLongFormProviders("real");
  const requireReal = !providers;
  const store = runtime.store ?? supabaseShotAssetStore(supabase, requestId, STORAGE_BUCKET);
  const allocation = executionAllocation(plan);
  // Abrir el presupuesto (gratis) ANTES de cualquier llamada pagada: si el
  // storage no responde, el trabajo falla aquí con $0 gastado.
  const budget = await ProductionBudget.open(runtime.budgetStore ?? supabaseBudgetStore(supabase, requestId, STORAGE_BUCKET), allocation);
  const units = getGenerativeUnitCosts();
  const uploadArtifact = runtime.uploadArtifact ?? ((path: string, buffer: Buffer, ct: string) => uploadToStorage(supabase, path, buffer, ct));

  await onProgress?.("scripting");
  await onProgress?.("storyboard", { completed: 0, total: beats.length, label: "narraciones" });

  const baseSynth: BeatSynthesizer =
    runtime.synthesizeBeat ??
    ((voiceProvider, beat, lang) =>
      synthesizeBeatNarrationProductionCached(supabase, voiceProvider, beat, lang, {
        videoId: requestId,
        voiceIdentity: getVoiceIdentity(lang === "en" ? "en" : "es"),
      }));
  let synthesized = 0;
  const synthesizeWithProgress: BeatSynthesizer = async (voiceProvider, beat, lang) => {
    const result = await baseSynth(voiceProvider, beat, lang);
    synthesized += 1;
    await onProgress?.("storyboard", { completed: synthesized, total: beats.length, label: "narraciones" });
    return result;
  };
  const timeline = await buildLongFormTimeline(
    resolvedProviders.voiceProvider,
    beats,
    language,
    shotsForSpan,
    synthesizeWithProgress,
    plan.strategy,
    (beat) => visualsForBeat(beat as { narration: string; visuals?: unknown }, topic),
  );

  // Proveedor de video IA real (solo si el plan confirmado tiene clips). Si
  // en este entorno resuelve a fixture (p. ej. falta VEO_API_KEY), el video
  // IA se desactiva ANTES de asignar: esas ranuras se degradan a imagen IA
  // dentro de la allocation, nunca a un clip de fixture en producción.
  let baseVideoProvider: VideoProvider | null = null;
  if (runtime.videoProvider !== undefined) {
    baseVideoProvider = runtime.videoProvider;
  } else if (allocation.maxAiVideoClips > 0 && (runtime.aiVideoEnabled ?? isLongFormAiVideoConfigured())) {
    const candidate = getVideoProvider();
    baseVideoProvider = candidate.name === "fixture" && requireReal ? null : candidate;
  }
  const aiVideoEnabled = baseVideoProvider !== null && (runtime.aiVideoEnabled ?? true);
  const limits = limitsWithinAllocation(
    strategyLimits(plan.strategy, plan.estimatedVoiceCostUsd ?? 0, { aiVideoEnabled, units }),
    allocation,
  );
  const allShots = timeline.beats.flatMap((b) => b.shots);
  const allocated = allocateShotTypes(allShots, timeline.durationSeconds, limits);
  if (allocated.aiImageCount !== plan.aiImageCount || allocated.aiVideoClipCount !== plan.aiVideoClipCount) {
    await budget.recordDeviation({
      shotId: "*",
      planned: `${plan.aiImageCount} imágenes IA, ${plan.aiVideoClipCount} clips de video IA`,
      executed: `${allocated.aiImageCount} imágenes IA, ${allocated.aiVideoClipCount} clips de video IA`,
      reason: "duración real narrada distinta de la estimada — siempre dentro de la allocation confirmada",
    });
  }

  const videoProvider: VideoProvider | undefined =
    baseVideoProvider && limits.aiVideoEnabled && allocated.aiVideoClipCount > 0
      ? wrapDurableVideoProvider(baseVideoProvider, {
          supabase,
          scopeId: requestId,
          executionMode: "real",
          beforeSubmit: () => budget.reserveAiVideoSubmit(units.veoClipUsd),
          maxInAttemptResumes: 2,
          resumeBackoffMs: runtime.resumeBackoffMs,
        })
      : undefined;

  await onProgress?.("assets", { completed: 0, total: allocated.shots.length, label: "escenas" });
  let aiVideoLedger = emptyAiVideoLedgerState();
  let spentUsd = 0;
  let storageBytes = 0;
  let footageCount = 0;
  let aiImageSpentUsd = 0;
  let aiVideoSpentUsd = 0;
  let aiVideoClipsUsed = 0;
  let deviations = 0;
  let degradedToText = 0;
  const executions: ShotExecution[] = [];
  for (const [index, shot] of allocated.shots.entries()) {
    const execution = await executeShot(
      shot,
      {
        topic,
        footageProvider: resolvedProviders.footageProvider,
        imageProvider: resolvedProviders.imageProvider,
        videoProvider,
        store,
        budget,
        units,
        aiVideoCostConfig: limits.aiVideoCostConfig,
        totalDurationSec: timeline.durationSeconds,
        requireReal,
        metadata: { requestId },
      },
      aiVideoLedger,
    );
    aiVideoLedger = execution.aiVideoLedger;
    executions.push(execution);
    storageBytes += execution.bufferBytes;
    if (!execution.reused) spentUsd += execution.costUsd;
    if (execution.executedType === "stock_video" || execution.executedType === "ken_burns_image") footageCount += 1;
    if (execution.executedType === "generated_placeholder" && !execution.reused) aiImageSpentUsd += execution.costUsd;
    if (execution.executedType === "ai_video") {
      aiVideoClipsUsed += 1;
      if (!execution.reused) aiVideoSpentUsd += execution.costUsd;
    }
    if (execution.deviation) {
      deviations += 1;
      if (execution.deviation.executed === "text") degradedToText += 1;
      await budget.recordDeviation({ shotId: shot.id, ...execution.deviation });
    }
    await onProgress?.("assets", { completed: index + 1, total: allocated.shots.length, label: "escenas" });
  }
  if (allocated.shots.length > 0 && degradedToText / allocated.shots.length > MAX_TEXT_FALLBACK_RATIO) {
    throw new LongFormQualityError(degradedToText, allocated.shots.length);
  }

  const shotScenes = allocated.shots.map((shot, i) => ({
    id: shot.id,
    startSeconds: shot.startSec,
    endSeconds: shot.endSec,
    asset: executions[i].asset,
    motion: shot.motion,
  }));

  const emphasisSet = buildEmphasisSet([]);
  const captions = buildCaptions(timeline.words, emphasisSet);
  const narrationGaps = computeNarrationGaps(timeline.words);

  const fullNarrationText = beats.map((b) => b.narration).join(" ");
  const finalDurationSeconds = timeline.durationSeconds + VIDEO_TAIL_SECONDS;
  let music: MusicResult | null = null;
  let musicFallbackReason: string | null = null;
  try {
    music = await resolvedProviders.musicProvider.getTrack({
      durationSeconds: finalDurationSeconds,
      style: "documental",
      topic,
      scriptText: fullNarrationText,
      language,
      seed: requestId,
    });
  } catch (err) {
    musicFallbackReason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(`[atomivid:long-form:produce] ${requestId} — no se pudo obtener música, el documental se genera sin ella:`, musicFallbackReason);
  }
  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    musicUrl = (await uploadArtifact(`${artifactPrefix}/music.${music.extension}`, music.audioBuffer, music.mimeType)).url;
  }

  storageBytes += timeline.audioBuffer.byteLength;
  const audioUpload = await uploadArtifact(`${artifactPrefix}/voice.${timeline.extension}`, timeline.audioBuffer, timeline.mimeType);

  await onProgress?.("rendering");
  // renderMedia() reporta fotogramas de forma síncrona: se encadenan las
  // escrituras de progreso (con throttle) y cualquier fallo (p. ej. el
  // intento perdió su reserva) se relanza al terminar el render.
  let progressChain: Promise<void> = Promise.resolve();
  let progressError: unknown = null;
  let lastReportedFrames = -1;
  let lastReportedAt = 0;
  const renderStartedAt = Date.now();
  const rawOutputPath = await (runtime.render ?? renderLongFormDoc)({
    audioUrl: audioUpload.url,
    musicUrl,
    scenes: shotScenes,
    captions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
    onFrameProgress: ({ renderedFrames, totalFrames }) => {
      const now = Date.now();
      const step = Math.max(1, Math.floor(totalFrames / 50));
      if (renderedFrames < totalFrames && renderedFrames - lastReportedFrames < step && now - lastReportedAt < 20_000) return;
      lastReportedFrames = renderedFrames;
      lastReportedAt = now;
      progressChain = progressChain
        .then(() => onProgress?.("rendering", { completed: renderedFrames, total: totalFrames, label: "fotogramas" }))
        .catch((err) => {
          progressError = progressError ?? err;
        });
    },
  });
  await progressChain;
  if (progressError) throw progressError;
  const renderMs = Date.now() - renderStartedAt;

  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath);
    outputPath = masteredPath;
    console.log("[atomivid:long-form:produce] masterización de loudness", JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }));
  } catch (err) {
    console.warn(
      `[atomivid:long-form:produce] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), se sube sin normalizar:`,
      err instanceof Error ? err.message : err,
    );
  }

  const videoBuffer = await fs.readFile(outputPath);
  storageBytes += videoBuffer.byteLength;
  const { path: videoPath } = await uploadArtifact(`${artifactPrefix}/final.mp4`, videoBuffer, "video/mp4");
  await fs.unlink(outputPath).catch(() => {});
  if (outputPath !== rawOutputPath) await fs.unlink(rawOutputPath).catch(() => {});

  console.log(
    "[atomivid:long-form:produce] terminado",
    JSON.stringify({ requestId, strategy: plan.strategy, shotCount: shotScenes.length, durationSeconds: finalDurationSeconds, spentUsd, deviations, budget: budget.snapshot().used }),
  );

  if (runtime.recordCosts !== false) {
    // Mismo registro de costos que Reel/Avatar (generation_costs) — un
    // fallo aquí nunca tumba un video que sí se generó.
    await recordVideoGeneration(supabase, requestId, {
      voiceProvider: resolvedProviders.voiceProvider.name,
      voiceCharacters: fullNarrationText.length,
      footageProvider: resolvedProviders.footageProvider.name,
      footageCount,
      musicProvider: music ? resolvedProviders.musicProvider.name : "none",
      musicTrack: music?.track
        ? { id: music.track.trackId, title: music.track.title, author: music.track.author, license: music.track.license, sourceUrl: music.track.sourceUrl }
        : null,
      musicFallbackReason,
      videoDurationSeconds: finalDurationSeconds,
      renderMs,
      storageBytes,
      creativeLayer: {
        imageProvider: aiImageSpentUsd > 0 ? resolvedProviders.imageProvider.name : undefined,
        imageCostUsd: aiImageSpentUsd,
        premiumVideoProvider: aiVideoClipsUsed > 0 ? (videoProvider?.name ?? "veo") : undefined,
        premiumVideoClipCount: aiVideoClipsUsed,
        premiumVideoCostUsd: aiVideoSpentUsd,
      },
    }).catch((err) => {
      console.warn(`[atomivid:long-form:produce] No se pudo registrar el costo de ${requestId}:`, err);
    });
  }

  return { videoPath, deviations, spentUsd };
}

/** Mismo patrón que generate-video.ts (Shorts): sube al bucket privado y firma una URL de corta duración para que este mismo proceso (Remotion) pueda leerla. */
async function uploadToStorage(
  supabase: SupabaseClient,
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string; url: string }> {
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, buffer, { contentType, upsert: true });
  if (error) throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);

  const { data, error: signError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, ASSET_SIGNED_URL_TTL_SECONDS);
  if (signError || !data) throw new Error(`No se pudo firmar la URL de ${objectPath}: ${signError?.message ?? "desconocido"}`);

  return { path: objectPath, url: data.signedUrl };
}
