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
import type { GeneratedScript, MusicResult, ScriptLanguage, VideoProvider } from "@/lib/providers/types";
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
import { GeneratedImageUncertainError, resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";
import { ASSET_SIGNED_URL_TTL_SECONDS, STORAGE_BUCKET, alignScenesToWords, renderVerticalReel, uploadToStorage } from "@/lib/video/reel-shared";
import { PROFILES, motionModeOf } from "./catalog";
import type { AudiovisualDirection } from "./direction";
import { evaluateDirectionReadiness, getReelAnimationProvider, readinessErrorMessage } from "./readiness";
import {
  REEL_ANIMATION,
  animationClipCostUsd,
  buildAnimationBaseImagePrompt,
  buildContinuityBible,
  AnimationPlanError,
  planAnimatedShots,
  planSceneAnimation,
  type SceneAnimationSpec,
} from "./animation";
import { AnimatedClipUncertainError, prepareAnimationInputImage, resolveAnimatedClipForScene } from "./animated-clip";
import { buildStyledImagePrompt, reelLookFor, stockConceptsFor, styledImageObjectPrefix } from "./visuals";
import { PaidBudgetExceededError, UncertainPaidOperationError, type PaidLedger } from "./paid-ledger";
import { openStorageLedger } from "./paid-costs";
import { synthesizeNarrationCached } from "./voice-cache";
import { StorageStateUnknownError } from "./storage-state";
import { REEL_FPS, TRANSITION_FRAMES, coverScenes, framingForBeat, minimumClipSeconds, mixLevelsFor, planReelMontage, validateTimeline, type PlannedShot } from "./montage";

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
  attempt,
  paid,
  deps,
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
  /** Número de intento (render_attempts) — solo para trazar el registro de gasto. */
  attempt?: number;
  /**
   * Control de gasto: tope del registro durable de esta solicitud
   * (acumulado entre intentos) y si se escriben los costos en
   * generation_costs (las muestras no tienen fila en video_requests).
   */
  paid?: { capUsd?: number; otherCommittedUsd?: number; recordCosts?: boolean; ledger?: PaidLedger };
  /** Solo pruebas: proveedor de animación y render inyectables (por defecto, los reales). */
  deps?: { animationProvider?: VideoProvider | null; renderReel?: typeof renderVerticalReel };
}): Promise<{ videoPath: string; ledger: PaidLedger }> {
  const flags = getFeatureFlags();
  const profile = PROFILES[direction.profile];
  const segments = script.segments;
  let storageBytes = 0;

  // 1. Disponibilidad antes de cualquier gasto.
  const animated = motionModeOf(direction.selection) === "ai_animation";
  const readiness = evaluateDirectionReadiness({
    profile: direction.profile,
    music: direction.music.id,
    sceneCount: segments.length,
    flags,
    motion: animated ? "ai_animation" : "images",
    sceneTexts: segments.map((s) => s.text),
    sceneActions: segments.map((s) => s.visibleAction),
    sceneEnergy: direction.sceneEnergy,
    ...(deps?.animationProvider !== undefined ? { animationProvider: deps.animationProvider?.name ?? null } : {}),
  });
  if (!readiness.ok) throw new DirectedProductionError(readinessErrorMessage(readiness));

  console.log(
    "[atomivid:direction]",
    JSON.stringify({ requestId, fingerprint: direction.fingerprint.slice(0, 12), summary: direction.summary, profile: direction.profile, intent: direction.intent, music: direction.music, pace: direction.pace }),
  );

  // Registro de gasto durable (uno por solicitud, acumulado entre intentos):
  // cada operación pagada se reserva ANTES de llamar y se liquida después,
  // aunque el video no llegue a terminar.
  const ledger = paid?.ledger ?? (await openStorageLedger(supabase, STORAGE_BUCKET, requestId, { capUsd: paid?.capUsd, otherCommittedUsd: paid?.otherCommittedUsd }));
  const logLedger = (when: string) => console.log("[atomivid:paid-ledger]", JSON.stringify({ requestId, when, ...ledger.summary() }));
  try {
    return await produce();
  } finally {
    logLedger("fin del intento");
  }

  async function produce(): Promise<{ videoPath: string; ledger: PaidLedger }> {
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

  // 3. Imágenes con el estilo del perfil (perfiles ilustrados) o, en
  //    «Animación IA», la ilustración base de cada escena (todos los perfiles).
  const styledImages = new Map<number, { url: string; path: string; key: string; costUsd: number; status: "generated" | "reused" }>();
  let imageProviderName: string | undefined;
  let imageModel: string | undefined;
  const bible = animated ? buildContinuityBible({ profile: direction.profile, intent: direction.intent.id, topic, scenes: segments }) : null;
  const animationProvider = animated ? (deps?.animationProvider !== undefined ? deps.animationProvider : getReelAnimationProvider()) : null;
  if (animated && !animationProvider) {
    throw new DirectedProductionError("La animación IA no tiene proveedor disponible. Elige «Imágenes» en la revisión del guion. No se gastó nada.");
  }
  if (profile.visualSource === "generated_image" || animated) {
    await onProgress?.("footage");
    const imageProvider = getImageProvider();
    imageProviderName = imageProvider.name;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const concept = segment.visualConcepts?.[0] ?? segment.visualQuery;
      const styled = bible
        ? buildAnimationBaseImagePrompt({ profile: direction.profile, bible, concept, narration: segment.text })
        : buildStyledImagePrompt({ profile: direction.profile, intent: direction.intent.id, concept, narration: segment.text });
      // Presupuesto de imágenes ACUMULADO entre intentos (registro durable), no solo este intento.
      const remaining = Math.max(0, flags.maxVisualCostUsd - (ledger.summary().byKind.image?.usd ?? 0));
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
          objectPrefix: bible ? `scene-${i}-animbase-${styled.key}` : styledImageObjectPrefix(i, styled.key),
          ledger,
          attempt,
        });
        storageBytes += outcome.bufferBytes;
        imageModel = outcome.model ?? imageModel;
        styledImages.set(i, { url: outcome.url, path: outcome.path, key: styled.key, costUsd: outcome.costUsd, status: outcome.status });
      } catch (err) {
        const blocked =
          err instanceof GeneratedImageUncertainError || err instanceof UncertainPaidOperationError || err instanceof PaidBudgetExceededError || err instanceof StorageStateUnknownError;
        throw new DirectedProductionError(
          `No se pudo generar la imagen de la escena ${i + 1} con el estilo «${profile.label}»: ${err instanceof Error ? err.message : String(err)}. ` +
            "No se sustituyó por stock realista. " +
            (blocked
              ? "Requiere revisión antes de volver a intentar (no se repite un gasto incierto)."
              : "Puedes reintentar (las imágenes ya guardadas se reutilizan sin volver a pagarlas) o elegir otra dirección."),
        );
      }
    }
  }

  // 4. Voz — misma lógica de tolerancia de duración que el flujo anterior.
  await onProgress?.("voice");
  const voiceProvider = getVoiceProvider();
  const fullText = segments.map((s) => s.text).join(" ");
  // Caché por texto+voz+idioma+velocidad: un reintento reutiliza la voz y
  // sus tiempos ya pagados; la corrección de duración es otra entrada (y
  // otra operación del registro, «voice_retime»).
  const narrate = (speed?: number) =>
    synthesizeNarrationCached({ supabase, bucket: STORAGE_BUCKET, requestId, voiceProvider, text: fullText, language, speed, ledger, attempt });
  let voice = await narrate();
  if (targetDurationSeconds !== undefined) {
    let durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    if (!durationResult.withinTolerance) {
      const correctedSpeed = voice.durationSeconds / targetDurationSeconds;
      voice = await narrate(correctedSpeed);
      durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    }
    if (!durationResult.withinTolerance) assertNarrationDuration(targetDurationSeconds, voice.durationSeconds);
  }

  // 5. Montaje sobre los tiempos reales.
  const finalDurationSeconds = voice.durationSeconds + VIDEO_TAIL_SECONDS;
  const sceneTimings = alignScenesToWords(segments, voice.words);
  let shots: PlannedShot[];
  if (animated) {
    // Un plano continuo por escena (el clip animado). Si una escena necesita
    // más que un clip, se detiene ANTES de pagar la animación: nunca se
    // congela el último fotograma ni se ralentiza para rellenar.
    const plan = planAnimatedShots({
      sceneSpans: coverScenes(sceneTimings, finalDurationSeconds),
      transitionInFrames: TRANSITION_FRAMES[direction.intent.id],
      fps: REEL_FPS,
      sceneEnergy: direction.sceneEnergy,
    });
    if (plan.tooLong.length > 0) {
      throw new DirectedProductionError(
        `La narración de la escena ${plan.tooLong.map((t) => `${t.sceneIndex + 1} (${t.neededSeconds.toFixed(1)} s)`).join(", ")} supera un clip animado de ${REEL_ANIMATION.clipSeconds} s. ` +
          "Divide esa escena en la revisión del guion. No se generó ninguna animación.",
      );
    }
    // Una acción que no cabe en lo que se ve del plano se bloquea aquí, antes
    // de pagar: no se acelera ni se congela el clip para disimularlo.
    if (plan.tooShort.length > 0) {
      throw new DirectedProductionError(
        `La escena ${plan.tooShort.map((t) => `${t.sceneIndex + 1} (se ve ${t.visibleSeconds.toFixed(1)} s; su acción necesita ${t.requiredSeconds.toFixed(1)} s con el margen de cierre)`).join(", ")} es demasiado corta para completar su acción. ` +
          "Alarga o une esa escena en la revisión del guion. No se generó ninguna animación.",
      );
    }
    shots = plan.shots.map((shot) => ({ ...shot, role: shot.sceneIndex === 0 ? "hook" : "normal" }));
  } else {
    shots = planReelMontage({
      intent: direction.intent.id,
      pace: direction.pace.id,
      sceneEnergy: direction.sceneEnergy,
      sceneTimings,
      words: voice.words,
      totalSeconds: finalDurationSeconds,
    });
  }
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
  // 6a. «Animación IA»: un clip image-to-video por escena, a partir de su ilustración.
  const clips = new Map<number, { url: string; status: string; costUsd: number }>();
  if (animated && animationProvider && bible) {
    const clipCost = animationClipCostUsd();
    // Todos los planes ANTES del primer clip: una escena inválida no deja
    // clips anteriores pagados a medias.
    const specs: SceneAnimationSpec[] = [];
    for (let i = 0; i < segments.length; i++) {
      const base = styledImages.get(i);
      if (!base) throw new DirectedProductionError(`Falta la ilustración base de la escena ${i + 1}; no se anima sin imagen de entrada.`);
      const shot = shots.find((s) => s.sceneIndex === i);
      if (!shot) throw new DirectedProductionError(`La escena ${i + 1} no tiene plano en el montaje; no se anima.`);
      try {
        specs.push(
          planSceneAnimation({
            sceneIndex: i,
            segment: segments[i],
            energy: direction.sceneEnergy[i] ?? "medium",
            intent: direction.intent.id,
            bible,
            referenceImagePath: base.path,
            referenceImageKey: base.key,
            visibleSeconds: shot.endSeconds - shot.startSeconds,
          }),
        );
      } catch (err) {
        if (err instanceof AnimationPlanError) throw new DirectedProductionError(`${err.message} No se generó ninguna animación.`);
        throw err;
      }
    }
    for (let i = 0; i < segments.length; i++) {
      const base = styledImages.get(i)!;
      const spec = specs[i];
      console.log(
        "[atomivid:animation-plan]",
        JSON.stringify({ requestId, scene: i, subject: spec.subject, action: spec.action, visibleSeconds: spec.visibleSeconds, startState: spec.startState, endState: spec.endState, reference: spec.referenceImagePath, constants: spec.constants, framing: spec.framing, camera: spec.camera, key: spec.key }),
      );
      try {
        const input = await prepareAnimationInputImage({
          supabase,
          bucket: STORAGE_BUCKET,
          requestId,
          baseImagePath: base.path,
          objectPrefix: `scene-${i}-anim-${spec.key}`,
          signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
        });
        const clip = await resolveAnimatedClipForScene({
          supabase,
          bucket: STORAGE_BUCKET,
          requestId,
          spec,
          inputImage: input,
          videoProvider: animationProvider,
          maxCostUsd: clipCost,
          signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
          ledger,
          attempt,
          // Tope de animación ACUMULADO entre intentos, exigido solo al iniciar
          // una operación nueva (reutilizar o reanudar no gasta más).
          newOperationBudget: { capUsd: flags.maxAiAnimationCostUsd, committedUsd: () => ledger.summary().byKind.video?.usd ?? 0 },
        });
        storageBytes += clip.bufferBytes;
        clips.set(i, { url: clip.url, status: clip.status, costUsd: clip.costUsd });
      } catch (err) {
        const blocked =
          err instanceof AnimatedClipUncertainError || err instanceof UncertainPaidOperationError || err instanceof PaidBudgetExceededError || err instanceof StorageStateUnknownError;
        throw new DirectedProductionError(
          `No se pudo animar la escena ${i + 1}: ${err instanceof Error ? err.message : String(err)}. ` +
            "No se sustituyó por una imagen fija con zoom. " +
            (blocked
              ? "Requiere revisión antes de volver a intentar (no se repite un gasto incierto)."
              : "Puedes reintentar: las ilustraciones y los clips ya guardados se reutilizan, y una operación ya enviada se reanuda sin crear otra."),
        );
      }
    }
  }

  for (let s = 0; s < shots.length; s++) {
    const shot = shots[s];
    const segment = segments[shot.sceneIndex];
    const base = { startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, motion: shot.motion, transitionInFrames: shot.transitionInFrames };
    const clip = clips.get(shot.sceneIndex);
    if (clip) {
      // Clip animado (movimiento real dentro de la escena); su audio generado se descarta (render silenciado).
      scenes.push({ ...base, mediaUrl: clip.url, mediaType: "video", motion: "hold" });
      shotLog.push({ ...shot, source: "ai_animation", clip: clip.status });
      continue;
    }
    const styled = animated ? undefined : styledImages.get(shot.sceneIndex);
    if (animated) throw new DirectedProductionError(`Falta el clip animado de la escena ${shot.sceneIndex + 1}.`);
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
  const rawOutputPath = await (deps?.renderReel ?? renderVerticalReel)({
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

  // Costos desde el registro durable: acumulados de TODOS los intentos de
  // esta solicitud (voz inicial + corrección de duración, imágenes pagadas
  // en intentos que fallaron), no solo lo que usó este intento.
  const totals = ledger.summary().byKind;
  const voiceChars = (totals.voice?.characters ?? 0) + (totals.voice_retime?.characters ?? 0);
  const generated = [...styledImages.values()];
  if (paid?.recordCosts !== false) {
    await recordVideoGeneration(supabase, requestId, {
      voiceProvider: voiceProvider.name,
      voiceCharacters: voiceChars,
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
        generated.length > 0 || totals.image
          ? {
              imageProvider: imageProviderName,
              imageGenerationCount: totals.image?.count ?? 0,
              imageCostUsd: totals.image?.usd ?? 0,
              imageRequestedCount: generated.length,
              imageReusedCount: generated.filter((g) => g.status === "reused").length,
              imageDryRun: false,
              imageModel,
              ...(totals.video
                ? { premiumVideoProvider: animationProvider?.name, premiumVideoClipCount: totals.video.count, premiumVideoCostUsd: totals.video.usd }
                : {}),
            }
          : undefined,
    }).catch((err) => {
      console.warn(`No se pudo registrar el costo de ${requestId}:`, err);
    });
  }

  return { videoPath, ledger };
  }
}
