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
import type { MusicResult, ScriptLanguage, VideoGenerationRequest } from "@/lib/providers/types";
import { resolveLongFormProviders, type LongFormProviderSet } from "./mode";
import { buildLongFormTimeline } from "./timeline";
import type { VisualStrategy } from "./shots";
import { assertWithinBudget, estimateLongFormCost, getLongFormBudget } from "./cost";
import { resolveShotAsset, type AssetUploader } from "./asset-resolver";
import { renderLongFormDoc } from "./render";
import { wrapDurableVideoProvider } from "./ai-video-durable-provider";
import { emptyAiVideoLedgerState, recordAiVideoSpend, type AiVideoLedgerState } from "./ai-video-cost-guard";
import type { NarrativeBeat } from "./types";
import { type LongFormStage } from "./stages";
import { recordVideoGeneration } from "@/lib/billing/usage";

const STORAGE_BUCKET = "videos";
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * `units` (opcional) lleva progreso REAL por unidad de trabajo dentro de
 * la etapa — hoy solo "assets" (un shot resuelto = una unidad, la etapa
 * más larga y la única con trabajo por-shot real que vale contar, ver
 * progress.ts). Sin `units`, el caller (run-job.ts) sigue guardando solo
 * la etapa, exactamente igual que antes de esta pieza.
 */
type OnProgress = (stage: LongFormStage, units?: { completed: number; total: number }) => void | Promise<void>;

/** Forma persistida en video_requests.script_json para mode="long_form" — un guion ya aprobado (beats con narración), sin shots todavía: buildLongFormTimeline() los calcula contra la duración REAL narrada, igual que el CLI. */
export type LongFormScriptBeatInput = Pick<
  NarrativeBeat,
  "id" | "type" | "purpose" | "narration" | "claims" | "sources" | "emotionalTone" | "patternInterrupt"
>;

export type LongFormScriptJson = {
  topic: string;
  beats: LongFormScriptBeatInput[];
};

export function isLongFormScriptJson(value: unknown): value is LongFormScriptJson {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { topic?: unknown; beats?: unknown };
  return (
    typeof candidate.topic === "string" &&
    Array.isArray(candidate.beats) &&
    candidate.beats.length > 0 &&
    candidate.beats.every(
      (b) => b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string" && typeof (b as { narration?: unknown }).narration === "string",
    )
  );
}

export async function generateLongFormVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  topic,
  beats,
  language = "es",
  onProgress,
  providers,
  strategy = "balanced",
}: {
  supabase: SupabaseClient;
  requestId: string;
  artifactPrefix?: string;
  topic: string;
  beats: LongFormScriptBeatInput[];
  language?: ScriptLanguage;
  onProgress?: OnProgress;
  /** Inyección para pruebas — en producción siempre se omite y se resuelve resolveLongFormProviders("real")/getVideoProvider() (nunca fixture en silencio, ver mode.ts). */
  providers?: LongFormProviderSet;
  /** Estrategia visual CONFIRMADA por el usuario (ver production-plan.ts/actions.ts) — nunca recalculada aquí, solo aplicada al mismo shotsForSpan() ya usado. Default "balanced" preserva el comportamiento histórico para cualquier llamador que no la pase (CLI, tests). */
  strategy?: VisualStrategy;
}): Promise<{ videoPath: string }> {
  const resolvedProviders = providers ?? resolveLongFormProviders("real");
  const durableVideoProvider = wrapDurableVideoProvider(getVideoProvider(), {
    supabase,
    scopeId: requestId,
    executionMode: "real",
  });

  await onProgress?.("scripting");
  // El guion (topic + beats con narración) ya llegó aprobado desde la fila
  // video_requests (ver run-job.ts) — Fase 3 conectará aquí la generación
  // real (Claude) todavía no invocada desde el modelo de job; por ahora
  // este módulo asume que `beats` ya es contenido final, igual que
  // scriptFile en el CLI.

  await onProgress?.("storyboard");
  const timeline = await buildLongFormTimeline(resolvedProviders.voiceProvider, beats, language, undefined, undefined, strategy);

  const budget = getLongFormBudget();
  const estimate = estimateLongFormCost({ durationSec: timeline.durationSeconds, beats: timeline.beats });
  assertWithinBudget(estimate, budget);

  await onProgress?.("assets");
  const allShots = timeline.beats.flatMap((b) => b.shots);
  const hasAiVideoShots = allShots.some((s) => s.type === "ai_video");
  if (hasAiVideoShots) await onProgress?.("ai_video");

  const upload: AssetUploader = async (objectPath, buffer, contentType) =>
    uploadToStorage(supabase, `${artifactPrefix}/${objectPath}`, buffer, contentType);

  let aiVideoLedger: AiVideoLedgerState = emptyAiVideoLedgerState();
  let imageCostSpentUsd = 0;
  let footageCount = 0;
  let storageBytes = 0;
  const shotScenes: {
    id: string;
    startSeconds: number;
    endSeconds: number;
    asset: Awaited<ReturnType<typeof resolveShotAsset>>["asset"];
    motion: (typeof allShots)[number]["motion"];
  }[] = [];

  for (const [shotIndex, shot] of allShots.entries()) {
    const remainingImageBudget = Math.max(0, budget.maxImageUsd - imageCostSpentUsd);
    const result = await resolveShotAsset(shot, {
      footageProvider: resolvedProviders.footageProvider,
      imageProvider: resolvedProviders.imageProvider,
      upload,
      pathPrefix: artifactPrefix,
      imageBudgetRemainingUsd: remainingImageBudget,
      aiVideo: {
        videoProvider: durableVideoProvider,
        ledger: aiVideoLedger,
        totalDocumentaryDurationSec: timeline.durationSeconds,
        aspectRatio: "16:9" as VideoGenerationRequest["aspectRatio"],
        requireReal: true,
        metadata: { requestId },
      },
    });
    imageCostSpentUsd += result.costUsd;
    storageBytes += result.bufferBytes;
    if (shot.type === "ai_video" && result.asset.kind === "media" && result.asset.mediaType === "video") {
      aiVideoLedger = recordAiVideoSpend(aiVideoLedger, shot.durationSec, result.costUsd);
    } else if (result.providerUsed === resolvedProviders.footageProvider.name) {
      footageCount += 1;
    }
    shotScenes.push({
      id: shot.id,
      startSeconds: shot.startSec,
      endSeconds: shot.endSec,
      asset: result.asset,
      motion: shot.motion,
    });
    // QA real (2026-09-25, "LONG FORM RC FINAL HARDENING"): antes de esto,
    // toda la etapa "assets" (la más larga — puede tardar varios minutos
    // en un documental de 3+ min) solo mostraba "Resolviendo imágenes y
    // video por plano" fijo, sin ningún indicio de avance real. Progreso
    // por unidad (shot resuelto) real, nunca inventado — ver progress.ts.
    await onProgress?.("assets", { completed: shotIndex + 1, total: allShots.length });
  }

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
    console.warn(
      `[atomivid:long-form:produce] ${requestId} — no se pudo obtener música, el documental se genera sin ella:`,
      musicFallbackReason,
    );
  }
  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    const uploaded = await upload("music." + music.extension, music.audioBuffer, music.mimeType);
    musicUrl = uploaded.url;
  }

  storageBytes += timeline.audioBuffer.byteLength;
  const audioUpload = await upload("voice.wav", timeline.audioBuffer, "audio/wav");

  await onProgress?.("rendering");
  const renderStartedAt = Date.now();
  const rawOutputPath = await renderLongFormDoc({
    audioUrl: audioUpload.url,
    musicUrl,
    scenes: shotScenes,
    captions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
  });
  const renderMs = Date.now() - renderStartedAt;

  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath);
    outputPath = masteredPath;
    console.log(
      "[atomivid:long-form:produce] masterización de loudness",
      JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }),
    );
  } catch (err) {
    console.warn(
      `[atomivid:long-form:produce] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), se sube sin normalizar:`,
      err instanceof Error ? err.message : err,
    );
  }

  const videoBuffer = await fs.readFile(outputPath);
  storageBytes += videoBuffer.byteLength;
  const { path: videoPath } = await uploadToStorage(supabase, `${artifactPrefix}/final.mp4`, videoBuffer, "video/mp4");
  await fs.unlink(outputPath).catch(() => {});
  if (outputPath !== rawOutputPath) await fs.unlink(rawOutputPath).catch(() => {});

  console.log(
    "[atomivid:long-form:produce] terminado",
    JSON.stringify({
      requestId,
      shotCount: shotScenes.length,
      durationSeconds: finalDurationSeconds,
      imageCostSpentUsd,
      aiVideo: { clips: aiVideoLedger.usedClips, seconds: aiVideoLedger.usedSeconds, costUsd: aiVideoLedger.spentUsd },
    }),
  );

  // RC mission Fase 6 (cost engine): centraliza el costo real en la MISMA
  // tabla generation_costs que ya usan Reel/Avatar (recordVideoGeneration,
  // billing/usage.ts) — nunca un registro aparte solo para Long Form. El
  // tier "video premium" (premium_video_*) ya existía para clips tipo
  // Runway; Veo/ai_video encaja ahí sin ningún cambio de schema. Igual que
  // en generate-video.ts, un fallo al registrar el costo NUNCA tumba un
  // video que sí se generó bien — solo se advierte.
  await recordVideoGeneration(supabase, requestId, {
    voiceProvider: resolvedProviders.voiceProvider.name,
    voiceCharacters: fullNarrationText.length,
    footageProvider: resolvedProviders.footageProvider.name,
    footageCount,
    musicProvider: music ? resolvedProviders.musicProvider.name : "none",
    musicTrack: music?.track
      ? {
          id: music.track.trackId,
          title: music.track.title,
          author: music.track.author,
          license: music.track.license,
          sourceUrl: music.track.sourceUrl,
        }
      : null,
    musicFallbackReason,
    videoDurationSeconds: finalDurationSeconds,
    renderMs,
    storageBytes,
    creativeLayer: {
      imageProvider: imageCostSpentUsd > 0 ? resolvedProviders.imageProvider.name : undefined,
      imageCostUsd: imageCostSpentUsd,
      premiumVideoProvider: aiVideoLedger.usedClips > 0 ? durableVideoProvider.name : undefined,
      premiumVideoClipCount: aiVideoLedger.usedClips,
      premiumVideoCostUsd: aiVideoLedger.spentUsd,
    },
  }).catch((err) => {
    console.warn(`[atomivid:long-form:produce] No se pudo registrar el costo de ${requestId}:`, err);
  });

  return { videoPath };
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
