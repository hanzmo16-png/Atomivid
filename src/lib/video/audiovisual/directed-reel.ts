/**
 * Pipeline de Reel con DIRECCIÓN AUDIOVISUAL aprobada. Solo se usa cuando
 * la solicitud tiene una dirección resuelta (video_requests.audiovisual_
 * direction); las solicitudes sin ella siguen generate-video.ts intacto.
 *
 * Orden pensado para no gastar en vano:
 *  1. Comprobación de disponibilidad (música compatible, imágenes, presupuesto).
 *  2. Música compatible con la dirección (antes de la voz; sin fallback).
 *  3. Imágenes con el estilo del perfil ilustrado (antes de la voz; si una
 *     falla, se detiene — nunca se sustituye por stock realista).
 *  4. Voz (misma identidad/idioma; la corrección de ritmo existente es la
 *     única resíntesis, igual que en el flujo anterior).
 *  5. Montaje sobre los tiempos reales de la voz, validado (cobertura exacta).
 *  6. Stock por plano (perfiles de stock) con duración mínima que evita
 *     congelados, render con grado/mezcla de la dirección y masterizado con
 *     control de picos.
 */
import fs from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getFootageProvider } from "@/lib/providers/footage";
import { getMusicProvider } from "@/lib/providers/music";
import { curatedLibraryMusicProvider } from "@/lib/providers/music/real";
import { getImageProvider } from "@/lib/providers/image";
import type { GeneratedScript, MusicResult, ScriptLanguage } from "@/lib/providers/types";
import type { RenderStage } from "@/lib/video/stages";
import type { Scene } from "../../../../remotion/VerticalReel";
import { computeNarrationGaps } from "../../../../remotion/audio-mix";
import { recordVideoGeneration } from "@/lib/billing/usage";
import { createFootageSelectionState, selectFootageForScene } from "@/lib/video/footage-select";
import { checkDuration, assertNarrationDuration } from "@/lib/video/duration-check";
import { LOUDNESS_TARGET, masterAudioLoudness } from "@/lib/video/audio-master";
import { buildEmphasisSet } from "@/lib/video/caption-emphasis";
import { buildCaptions } from "@/lib/video/captions";
import { VIDEO_TAIL_SECONDS } from "@/lib/video/script-pacing";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { ASSET_SIGNED_URL_TTL_SECONDS, STORAGE_BUCKET, alignScenesToWords, renderVerticalReel, uploadToStorage } from "@/lib/video/reel-shared";
import { PROFILES } from "./catalog";
import type { AudiovisualDirection } from "./direction";
import { evaluateDirectionReadiness, readinessErrorMessage } from "./readiness";
import { buildStyledImagePrompt, reelLookFor, stockConceptsFor, styledImageObjectPrefix } from "./visuals";
import { framingForBeat, minimumClipSeconds, mixLevelsFor, planReelMontage, validateTimeline } from "./montage";

type OnProgress = (stage: RenderStage) => void | Promise<void>;

export class DirectedProductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectedProductionError";
  }
}

export async function generateDirectedVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  script,
  style,
  topic,
  language = "es",
  targetDurationSeconds,
  onProgress,
  direction,
}: {
  supabase: SupabaseClient;
  requestId: string;
  artifactPrefix?: string;
  script: GeneratedScript;
  style?: string;
  topic?: string;
  language?: ScriptLanguage;
  targetDurationSeconds?: number;
  onProgress?: OnProgress;
  direction: AudiovisualDirection;
}): Promise<{ videoPath: string }> {
  const flags = getFeatureFlags();
  const profile = PROFILES[direction.profile];
  const segments = script.segments;
  let storageBytes = 0;

  // 1. Disponibilidad antes de cualquier gasto.
  const readiness = evaluateDirectionReadiness({ profile: direction.profile, music: direction.music.id, sceneCount: segments.length, flags });
  if (!readiness.ok) throw new DirectedProductionError(readinessErrorMessage(readiness));

  console.log(
    "[atomivid:direction]",
    JSON.stringify({ requestId, fingerprint: direction.fingerprint.slice(0, 12), summary: direction.summary, profile: direction.profile, intent: direction.intent, music: direction.music, pace: direction.pace }),
  );

  // 2. Música compatible (nunca Beatoven ni otra pista cualquiera en modo dirigido).
  await onProgress?.("music");
  let music: MusicResult | null = null;
  if (direction.music.id !== "none") {
    const base = getMusicProvider();
    const musicProvider = base.name === "beatoven" ? curatedLibraryMusicProvider : base;
    try {
      music = await musicProvider.getTrack({
        durationSeconds: (targetDurationSeconds ?? 60) + VIDEO_TAIL_SECONDS,
        style,
        topic,
        language,
        seed: requestId,
        direction: direction.music.id,
      });
    } catch (err) {
      throw new DirectedProductionError(
        `${err instanceof Error ? err.message : String(err)} Cambia la música en la revisión del guion (otra dirección o «Sin música»). No se usó otra pista ni música de pago.`,
      );
    }
  }

  // 3. Imágenes con el estilo del perfil (solo perfiles ilustrados).
  const styledImages = new Map<number, { url: string; costUsd: number; status: "generated" | "reused" }>();
  let imageCostUsd = 0;
  let imageProviderName: string | undefined;
  let imageModel: string | undefined;
  if (profile.visualSource === "generated_image") {
    await onProgress?.("footage");
    const imageProvider = getImageProvider();
    imageProviderName = imageProvider.name;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const styled = buildStyledImagePrompt({
        profile: direction.profile,
        intent: direction.intent.id,
        concept: segment.visualConcepts?.[0] ?? segment.visualQuery,
        narration: segment.text,
      });
      const remaining = Math.max(0, flags.maxVisualCostUsd - imageCostUsd);
      try {
        const outcome = await resolveGeneratedImageForScene({
          supabase,
          bucket: STORAGE_BUCKET,
          requestId,
          sceneIndex: i,
          scene: { imagePrompt: styled.prompt, negativePrompt: styled.negativePrompt },
          imageProvider,
          remainingBudgetUsd: remaining,
          signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
          objectPrefix: styledImageObjectPrefix(i, styled.key),
        });
        imageCostUsd += outcome.costUsd;
        storageBytes += outcome.bufferBytes;
        imageModel = outcome.model ?? imageModel;
        styledImages.set(i, { url: outcome.url, costUsd: outcome.costUsd, status: outcome.status });
      } catch (err) {
        throw new DirectedProductionError(
          `No se pudo generar la imagen de la escena ${i + 1} con el estilo «${profile.label}»: ${err instanceof Error ? err.message : String(err)}. ` +
            "No se sustituyó por stock realista. Puedes reintentar (las imágenes ya generadas se reutilizan sin volver a pagarlas) o elegir otra dirección.",
        );
      }
    }
  }

  // 4. Voz — misma lógica de tolerancia de duración que el flujo anterior.
  await onProgress?.("voice");
  const voiceProvider = getVoiceProvider();
  const fullText = segments.map((s) => s.text).join(" ");
  let voice = await voiceProvider.synthesize(fullText, language);
  if (targetDurationSeconds !== undefined) {
    let durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    if (!durationResult.withinTolerance) {
      const correctedSpeed = voice.durationSeconds / targetDurationSeconds;
      voice = await voiceProvider.synthesize(fullText, language, correctedSpeed);
      durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    }
    if (!durationResult.withinTolerance) assertNarrationDuration(targetDurationSeconds, voice.durationSeconds);
  }

  // 5. Montaje sobre los tiempos reales.
  const finalDurationSeconds = voice.durationSeconds + VIDEO_TAIL_SECONDS;
  const sceneTimings = alignScenesToWords(segments, voice.words);
  const shots = planReelMontage({
    intent: direction.intent.id,
    pace: direction.pace.id,
    sceneEnergy: direction.sceneEnergy,
    sceneTimings,
    words: voice.words,
    totalSeconds: finalDurationSeconds,
  });
  const timelineIssues = validateTimeline(shots, finalDurationSeconds);
  if (timelineIssues.length > 0) {
    throw new DirectedProductionError(`El montaje no cubre exactamente la narración: ${timelineIssues.map((i) => i.detail).join("; ")}`);
  }

  // 6. Recursos por plano.
  await onProgress?.("footage");
  const footageProvider = getFootageProvider();
  const footageState = createFootageSelectionState();
  const scenes: Scene[] = [];
  const shotLog: Array<Record<string, unknown>> = [];
  for (let s = 0; s < shots.length; s++) {
    const shot = shots[s];
    const segment = segments[shot.sceneIndex];
    const base = { startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, motion: shot.motion, transitionInFrames: shot.transitionInFrames };
    const styled = styledImages.get(shot.sceneIndex);
    if (styled) {
      // Imagen fija con movimiento de cámara (paneo/zoom), no animación generada.
      const framing = framingForBeat(shot.beatIndex);
      scenes.push({ ...base, mediaUrl: styled.url, mediaType: "image", ...(framing ? { framing } : {}) });
      shotLog.push({ ...shot, source: "styled_image" });
      continue;
    }
    const concepts = segment.visualConcepts && segment.visualConcepts.length > 0 ? segment.visualConcepts : [segment.visualQuery];
    const rotation = shot.beatIndex % concepts.length;
    const rotated = [...concepts.slice(rotation), ...concepts.slice(0, rotation)];
    const outcome = await selectFootageForScene({
      provider: footageProvider,
      concepts: stockConceptsFor(direction.profile, rotated),
      minimumDurationSeconds: minimumClipSeconds(shots, s),
      state: footageState,
    });
    const footageBuffer = await footageProvider.downloadFootage(outcome.result.url);
    storageBytes += footageBuffer.byteLength;
    const { url: mediaUrl } = await uploadToStorage(
      supabase,
      `${artifactPrefix}/scene-${shot.sceneIndex}-${shot.beatIndex}.${outcome.result.extension}`,
      footageBuffer,
      outcome.result.mimeType,
    );
    scenes.push({ ...base, mediaUrl, mediaType: outcome.result.mediaType });
    shotLog.push({ ...shot, source: "stock", query: outcome.queryUsed, tier: outcome.conceptTier });
  }
  console.log("[atomivid:direction-montage]", JSON.stringify({ requestId, totalSeconds: finalDurationSeconds, shots: shotLog }));

  storageBytes += voice.audioBuffer.byteLength;
  const { url: audioUrl } = await uploadToStorage(supabase, `${artifactPrefix}/voice.${voice.extension}`, voice.audioBuffer, voice.mimeType);
  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    musicUrl = (await uploadToStorage(supabase, `${artifactPrefix}/music.${music.extension}`, music.audioBuffer, music.mimeType)).url;
    console.log("[atomivid:music] pista dirigida", JSON.stringify({ requestId, direction: direction.music.id, ...(music.track ?? { note: "fixture" }) }));
  }

  const captions = buildCaptions(voice.words, buildEmphasisSet(segments.flatMap((s) => s.emphasisWords ?? [])));
  const narrationGaps = computeNarrationGaps(voice.words);

  await onProgress?.("render");
  const renderStartedAt = Date.now();
  const look = reelLookFor(direction.profile, direction.intent.id);
  const mix = mixLevelsFor(direction.intent.id);
  const rawOutputPath = await renderVerticalReel({
    audioUrl,
    musicUrl,
    scenes,
    captions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
    ...(look ? { look } : {}),
    ...(mix ? { mix } : {}),
  });
  const renderMs = Date.now() - renderStartedAt;

  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath, { truePeakMarginDb: 1 });
    outputPath = masteredPath;
    console.log("[atomivid:audio] masterización de loudness", JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }));
  } catch (err) {
    console.warn(`[atomivid:audio] ${requestId} — no se pudo masterizar el loudness, se sube sin normalizar:`, err instanceof Error ? err.message : err);
  }

  await onProgress?.("uploading");
  const videoBuffer = await fs.readFile(outputPath);
  storageBytes += videoBuffer.byteLength;
  const { path: videoPath } = await uploadToStorage(supabase, `${artifactPrefix}/final.mp4`, videoBuffer, "video/mp4");
  await fs.unlink(outputPath).catch(() => {});
  if (outputPath !== rawOutputPath) await fs.unlink(rawOutputPath).catch(() => {});

  const generated = [...styledImages.values()];
  await recordVideoGeneration(supabase, requestId, {
    voiceProvider: voiceProvider.name,
    voiceCharacters: fullText.length,
    footageProvider: footageProvider.name,
    footageCount: scenes.length,
    musicProvider: music ? (getMusicProvider().name === "beatoven" ? curatedLibraryMusicProvider.name : getMusicProvider().name) : "none",
    musicTrack: music?.track
      ? { id: music.track.trackId, title: music.track.title, author: music.track.author, license: music.track.license, sourceUrl: music.track.sourceUrl }
      : null,
    musicFallbackReason: direction.music.id === "none" ? "sin música (elegido en la dirección audiovisual)" : null,
    videoDurationSeconds: finalDurationSeconds,
    renderMs,
    storageBytes,
    creativeLayer:
      generated.length > 0
        ? {
            imageProvider: imageProviderName,
            imageGenerationCount: generated.filter((g) => g.status === "generated").length,
            imageCostUsd,
            imageRequestedCount: generated.length,
            imageReusedCount: generated.filter((g) => g.status === "reused").length,
            imageDryRun: false,
            imageModel,
          }
        : undefined,
  }).catch((err) => {
    console.warn(`No se pudo registrar el costo de ${requestId}:`, err);
  });

  return { videoPath };
}
