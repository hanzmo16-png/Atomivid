import { buildCaptions } from "./captions";
import { VIDEO_TAIL_SECONDS } from "./script-pacing";
import { ProviderConfigurationError } from "@/lib/providers/production";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getVoiceProvider } from "@/lib/providers/voice";
import { getFootageProvider } from "@/lib/providers/footage";
import { getMusicProvider } from "@/lib/providers/music";
import type { GeneratedScript, MusicResult, ScriptLanguage, WordTiming } from "@/lib/providers/types";
import type { RenderStage } from "@/lib/video/stages";
import type { Caption, Scene } from "../../../remotion/VerticalReel";
import { computeNarrationGaps, type NarrationGap } from "../../../remotion/audio-mix";
import { recordVideoGeneration } from "@/lib/billing/usage";
import { splitIntoBeats } from "@/lib/video/scene-beats";
import { createFootageSelectionState, selectFootageForScene } from "@/lib/video/footage-select";
import { checkDuration, assertNarrationDuration } from "@/lib/video/duration-check";
import { LOUDNESS_TARGET, masterAudioLoudness } from "@/lib/video/audio-master";
import { buildEmphasisSet } from "@/lib/video/caption-emphasis";
import { getAccentColor } from "@/lib/video/brand";
import { evaluateQualityGate, QUALITY_GATE_MIN_SCORE } from "@/lib/video/quality-gate";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { buildStoryboard } from "@/lib/video/storyboard";
import type { Storyboard } from "@/lib/video/storyboard/types";
import { getImageProvider } from "@/lib/providers/image";
import { decideResourceStrategy, buildScenePlanEntry, type ScenePlanEntry } from "@/lib/video/visual-resource-planner";
import { resolveGeneratedImageForScene } from "@/lib/video/visual-resource-resolver";

// Deliberadamente separado de generate-script.ts — ver el comentario ahí
// para la razón exacta (Remotion no debe cargarse en la ruta de guion).
// Este módulo (voz/footage/música/render) solo lo importan el worker
// inline (fallback de desarrollo, ver src/lib/video/run-job.ts) y el
// script de prueba end-to-end con fixtures.

const STORAGE_BUCKET = "videos";
const COMPOSITION_ID = "VerticalReel";
// El bucket es privado: los assets intermedios (voz/footage/música) se
// firman por un rato corto, solo el tiempo que tarda este mismo proceso en
// leerlos para el render — no necesitan durar más que eso.
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

type OnProgress = (stage: RenderStage) => void | Promise<void>;

/**
 * Etapa 2 del pipeline: a partir de un guion ya aprobado (generado o
 * editado por el usuario), sintetiza voz, busca footage, agrega música,
 * arma subtítulos y renderiza el video final.
 */
export async function generateVideoFromScript({
  supabase,
  requestId,
  artifactPrefix = requestId,
  script,
  style,
  topic,
  language = "es",
  targetDurationSeconds,
  onProgress,
}: {
  supabase: SupabaseClient;
  requestId: string;
  artifactPrefix?: string;
  script: GeneratedScript;
  /** Estilo elegido por el usuario (p. ej. "Motivacional") — usado para elegir música acorde. */
  style?: string;
  /** Tema original de la solicitud — señal adicional para el tono musical (ver providers/music/tone.ts). */
  topic?: string;
  language?: ScriptLanguage;
  /** Duración objetivo original de la solicitud (video_requests.duration_seconds) — para advertir si la narración real se sale de tolerancia (±10%). Ausente = no se verifica. */
  targetDurationSeconds?: number;
  onProgress?: OnProgress;
}): Promise<{ videoPath: string }> {
  const voiceProvider = getVoiceProvider();
  const footageProvider = getFootageProvider();
  const musicProvider = getMusicProvider();
  const imageProvider = getFeatureFlags().imageGenerationEnabled ? getImageProvider() : undefined;
  let storageBytes = 0;

  // 0. Storyboard semántico (Visual Director) — detrás de
  // VISUAL_DIRECTOR_ENABLED (apagado por defecto, ver feature-flags.ts),
  // nunca bloquea el render si falla. Cuando SÍ se genera, alimenta al
  // planificador visual de abajo (decideResourceStrategy) para decidir,
  // escena por escena, si conviene una imagen generada en vez de stock —
  // con el flag apagado, `storyboard` queda undefined y esa decisión
  // siempre cae a stock (comportamiento idéntico al de antes de esta
  // función existir). Tampoco escribe en video_requests.storyboard_json
  // porque esa columna depende de la migración 0010, que no se aplica
  // sola (ver supabase/migrations/0010_visual_director.sql).
  let storyboard: Storyboard | undefined;
  if (getFeatureFlags().visualDirectorEnabled) {
    try {
      const built = await buildStoryboard(script, language);
      storyboard = built.storyboard;
      console.log(
        "[atomivid:storyboard]",
        JSON.stringify({
          requestId,
          source: built.source,
          totalScenes: storyboard.scenes.length,
          hookDescription: storyboard.hookDescription,
          closingDescription: storyboard.closingDescription,
          resourceTypes: storyboard.scenes.map((s) => s.resourceType),
        }),
      );
    } catch (err) {
      if (err instanceof ProviderConfigurationError) throw err;
      console.warn(
        `[atomivid:storyboard] ${requestId} — no se pudo generar el storyboard, se continúa con el flujo actual:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 1. Voz narrada completa en una sola llamada, con timestamps por
  // palabra (así toda la narración usa la misma voz y ritmo).
  await onProgress?.("voice");
  const fullText = script.segments.map((s) => s.text).join(" ");
  let voice = await voiceProvider.synthesize(fullText, language);

  // Verificación de duración REAL (no estimada) contra el objetivo de la
  // solicitud — nunca estira ni recorta el audio ya grabado (eso sonaría
  // artificial), rechaza cuando el guion quedó fuera de tolerancia (±10%)
  // para poder recalibrar WORDS_PER_SECOND (script-pacing.ts) con datos
  // reales en vez de dejarlo pasar en silencio. Causa raíz confirmada del
  // defecto "duración ~28% menor que la pedida" en el video auditado.
  //
  // Antes de rendirse: una sola corrección de RITMO (voiceProvider habla
  // más rápido/lento, nunca reescribe el texto ya aprobado por el usuario
  // en la revisión) proporcional a cuánto se pasó/quedó corto. Confirmado
  // en producción (2026-09-20) que el conteo de palabras por sí solo no
  // siempre predice bien la duración real hablada — esta corrección ataca
  // la causa real (el ritmo de esta síntesis en particular) sin gastar en
  // un guion nuevo ni pedirle al usuario que vuelva a revisar texto que no
  // escribió. Si tras la corrección sigue fuera de tolerancia, se rinde
  // igual que antes: assertNarrationDuration lanza y no se sigue.
  let durationWithinTolerance = true;
  if (targetDurationSeconds !== undefined) {
    let durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    if (!durationResult.withinTolerance) {
      const correctedSpeed = voice.durationSeconds / targetDurationSeconds;
      const correctedVoice = await voiceProvider.synthesize(fullText, language, correctedSpeed);
      const correctedResult = checkDuration(targetDurationSeconds, correctedVoice.durationSeconds);
      voice = correctedVoice;
      durationResult = correctedResult;
    }
    durationWithinTolerance = durationResult.withinTolerance;
    if (!durationResult.withinTolerance) {
      assertNarrationDuration(targetDurationSeconds, voice.durationSeconds);
    }
  }

  // 2. Repartir el tiempo de la narración real entre las escenas del guion
  const sceneTimings = alignScenesToWords(script.segments, voice.words);

  // 3. Footage: varios candidatos por escena (y por "beat" visual dentro
  // de escenas largas), puntuados y deduplicados contra todo lo ya usado
  // en este video — reemplaza el patrón anterior (una sola búsqueda de
  // 2-4 palabras, primer resultado, sin memoria entre escenas), causa
  // raíz confirmada de "solo ~4 clips distintos" y "atardecer repetido"
  // en el video auditado. Ver footage-select.ts para el detalle.
  await onProgress?.("footage");
  const footageState = createFootageSelectionState();
  const scenes: Scene[] = [];
  const footageSelections: Array<{
    sceneIndex: number;
    beatIndex: number;
    queryUsed: string;
    conceptTier: number;
    usedFallbackQuery: boolean;
    candidatesConsidered: number;
    reason: string;
  }> = [];
  // Planificador visual (imagen generada vs. stock) — ver
  // visual-resource-planner.ts para la política completa. Con
  // VISUAL_DIRECTOR_ENABLED=false (default) `storyboard` es undefined y
  // decideResourceStrategy() siempre devuelve useGeneration:false en su
  // primer chequeo, así que este bloque nunca cambia el comportamiento
  // existente cuando el flag está apagado.
  const visualPlan: ScenePlanEntry[] = [];
  let imagesRequestedCount = 0;
  let imagesGeneratedCount = 0;
  let imagesReusedCount = 0;
  let visualCostSpentUsd = 0;
  let usedGeneratedImageProvider: string | null = null;
  let usedGeneratedImageModel: string | null = null;
  let usedGeneratedImageSize: string | null = null;

  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const beats = splitIntoBeats(timing.start, timing.end);
    const baseConcepts =
      segment.visualConcepts && segment.visualConcepts.length > 0
        ? segment.visualConcepts
        : [segment.visualQuery];
    const storyboardScene = storyboard?.scenes[i];

    for (let b = 0; b < beats.length; b++) {
      const beat = beats[b];
      const beatDuration = Math.max(0, beat.end - beat.start);
      // Beats después del primero dentro de la misma escena empiezan por
      // un concepto distinto (si hay más de uno) para variar el plano en
      // vez de repetir la misma búsqueda dentro de la propia escena.
      const rotation = b % baseConcepts.length;
      const beatConcepts = [...baseConcepts.slice(rotation), ...baseConcepts.slice(0, rotation)];

      // La generación pagada solo se considera para el PRIMER beat de
      // cada escena — como mucho una imagen generada por escena del
      // guion, nunca una por cada sub-plano, para mantener el costo
      // acotado y predecible (documentado, no un límite oculto).
      const decision =
        b === 0
          ? decideResourceStrategy(storyboardScene, imagesRequestedCount, visualCostSpentUsd)
          : ({ useGeneration: false, reason: "solo el primer beat de cada escena es candidato a generación" } as const);

      let resolvedViaGeneration = false;
      if (decision.useGeneration && imageProvider) {
        imagesRequestedCount += 1;
        try {
          const remainingBudgetUsd = Math.max(0, getFeatureFlags().maxVisualCostUsd - visualCostSpentUsd);
          const generated = await resolveGeneratedImageForScene({
            supabase,
            bucket: STORAGE_BUCKET,
            requestId,
            sceneIndex: i,
            scene: decision.scene,
            imageProvider,
            remainingBudgetUsd: Math.min(remainingBudgetUsd, decision.estimatedCostUsd),
            signedUrlTtlSeconds: ASSET_SIGNED_URL_TTL_SECONDS,
          });

          storageBytes += generated.bufferBytes;
          visualCostSpentUsd += generated.costUsd;
          usedGeneratedImageProvider = generated.provider;
          usedGeneratedImageModel = generated.model ?? usedGeneratedImageModel;
          if (generated.width && generated.height) {
            usedGeneratedImageSize = `${generated.width}x${generated.height}`;
          }
          if (generated.status === "generated") imagesGeneratedCount += 1;
          else imagesReusedCount += 1;

          scenes.push({
            mediaUrl: generated.url,
            mediaType: "image",
            startSeconds: beat.start,
            endSeconds: beat.end,
          });
          visualPlan.push({
            ...buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], decision),
            provider: generated.provider,
            estimatedCostUsd: generated.costUsd,
          });
          console.log(
            "[atomivid:visual]",
            JSON.stringify({ requestId, sceneIndex: i, status: generated.status, provider: generated.provider, costUsd: generated.costUsd }),
          );
          resolvedViaGeneration = true;
        } catch (err) {
          // Nunca cae a otro proveedor de PAGO como sustituto silencioso —
          // solo se registra el fallo y se sigue con stock (gratis) abajo.
          console.warn(
            `[atomivid:visual] ${requestId} — falló la generación de imagen para la escena ${i}, se usa stock:`,
            err instanceof Error ? err.message : err,
          );
          visualPlan.push(buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], {
            useGeneration: false,
            reason: `fallo del proveedor de imagen, fallback a stock: ${err instanceof Error ? err.message : "error desconocido"}`,
          }));
        }
      } else if (b === 0) {
        visualPlan.push(buildScenePlanEntry(i, b, beatDuration, segment.text, beatConcepts[0], decision));
      }

      if (resolvedViaGeneration) continue;

      const outcome = await selectFootageForScene({
        provider: footageProvider,
        concepts: beatConcepts,
        minimumDurationSeconds: beatDuration + 0.5,
        state: footageState,
      });

      footageSelections.push({
        sceneIndex: i,
        beatIndex: b,
        queryUsed: outcome.queryUsed,
        conceptTier: outcome.conceptTier,
        usedFallbackQuery: outcome.usedFallbackQuery,
        candidatesConsidered: outcome.candidatesConsidered,
        reason: outcome.reason,
      });

      const footageBuffer = await footageProvider.downloadFootage(outcome.result.url);
      storageBytes += footageBuffer.byteLength;
      const { url: mediaUrl } = await uploadToStorage(
        supabase,
        `${artifactPrefix}/scene-${i}-${b}.${outcome.result.extension}`,
        footageBuffer,
        outcome.result.mimeType,
      );
      scenes.push({
        mediaUrl,
        mediaType: outcome.result.mediaType,
        startSeconds: beat.start,
        endSeconds: beat.end,
      });
    }
  }

  if (visualPlan.length > 0) {
    console.log(
      "[atomivid:visual-plan]",
      JSON.stringify({
        requestId,
        imagesRequestedCount,
        imagesGeneratedCount,
        imagesReusedCount,
        visualCostSpentUsd,
        plan: visualPlan,
      }),
    );
  }

  console.log(
    "[atomivid:footage] selección de clips",
    JSON.stringify({ requestId, totalBeats: scenes.length, selections: footageSelections }),
  );

  // Puerta de calidad preventiva (no bloqueante todavía — ver el
  // comentario en quality-gate.ts) — se calcula ANTES del paso más caro
  // en cómputo que queda (el render de Remotion), con los datos reales de
  // la selección de footage ya hecha.
  const qualityGate = evaluateQualityGate({
    totalBeats: scenes.length,
    // footage-select.ts garantiza por construcción que nunca se reutiliza
    // un sourceId dentro del mismo video (ver su `state.usedSourceIds`) —
    // por eso la cantidad de candidatos únicos es siempre igual al total
    // de beats; se registra igual como valor real, no supuesto, por si
    // esa garantía se rompiera algún día (el score de diversidad bajaría
    // y quedaría en los logs de este propio gate, no en silencio).
    uniqueSourceIds: footageState.usedSourceIds.size,
    fallbackCount: footageSelections.filter((s) => s.usedFallbackQuery).length,
    averageConceptTier:
      footageSelections.length > 0
        ? footageSelections.reduce((sum, s) => sum + s.conceptTier, 0) / footageSelections.length
        : 0,
    beatDurations: scenes.map((s) => s.endSeconds - s.startSeconds),
    durationWithinTolerance,
  });
  console.log(
    "[atomivid:quality-gate]",
    JSON.stringify({ requestId, ...qualityGate }),
  );
  if (!qualityGate.passed) {
    console.warn(
      `[atomivid:quality-gate] ${requestId} — score ${qualityGate.score} por debajo del mínimo ` +
        `sugerido (${QUALITY_GATE_MIN_SCORE}): ${qualityGate.reasons.join("; ")}`,
    );
  }

  // 4. Subir la narración generada
  storageBytes += voice.audioBuffer.byteLength;
  const { url: audioUrl } = await uploadToStorage(
    supabase,
    `${artifactPrefix}/voice.${voice.extension}`,
    voice.audioBuffer,
    voice.mimeType,
  );

  // 5. Música de fondo, seleccionada por tono (tema + estilo + guion) y
  // mezclada por debajo de la narración (ver remotion/audio-mix.ts). Un
  // fallo aquí (proveedor caído, sin coincidencia, descarga corrupta) NO
  // debe tumbar el video completo — se continúa sin música, mezclando la
  // razón claramente en logs y en el registro de costo, nunca en silencio
  // absoluto (ver Fase 4/6 de la especificación de esta etapa).
  await onProgress?.("music");
  const finalDurationSeconds = voice.durationSeconds + VIDEO_TAIL_SECONDS;
  let music: MusicResult | null = null;
  let musicFallbackReason: string | null = null;
  try {
    music = await musicProvider.getTrack({
      durationSeconds: finalDurationSeconds,
      style,
      topic,
      scriptText: fullText,
      language,
      seed: requestId,
    });
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "Error";
    const errorMessage = err instanceof Error ? err.message : String(err);
    musicFallbackReason = `${errorName}: ${errorMessage}`;
    console.warn(
      `[atomivid:music] ${requestId} — no se pudo obtener música, el video se genera sin ella:`,
      musicFallbackReason,
    );
  }

  let musicUrl: string | undefined;
  if (music) {
    storageBytes += music.audioBuffer.byteLength;
    const uploaded = await uploadToStorage(
      supabase,
      `${artifactPrefix}/music.${music.extension}`,
      music.audioBuffer,
      music.mimeType,
    );
    musicUrl = uploaded.url;
    console.log(
      "[atomivid:music] pista seleccionada",
      JSON.stringify({
        requestId,
        musicProvider: musicProvider.name,
        ...(music.track ?? { note: "sin metadata (modo MUSIC_TRACK_URLS sin manifest)" }),
      }),
    );
  }

  // 6. Subtítulos incrustados: frases naturales (corte en puntuación),
  // máximo 2 líneas, respetando finales de oración, con palabras clave
  // marcadas para énfasis visual (ver caption-emphasis.ts).
  const scriptEmphasisWords = script.segments.flatMap((s) => s.emphasisWords ?? []);
  const emphasisSet = buildEmphasisSet(scriptEmphasisWords);
  const captions = buildCaptions(voice.words, emphasisSet);
  const narrationGaps = computeNarrationGaps(voice.words);

  // 7. Ensamblar el video final con Remotion
  await onProgress?.("render");
  const renderStartedAt = Date.now();
  const rawOutputPath = await renderVerticalReel({
    audioUrl,
    musicUrl,
    scenes,
    captions,
    narrationGaps,
    durationSeconds: finalDurationSeconds,
  });
  const renderMs = Date.now() - renderStartedAt;

  // 7b. Masterizar el loudness del archivo final — causa raíz confirmada
  // de "la mezcla general está demasiado baja para redes sociales"
  // (audio-master.ts). Si ffmpeg no está disponible (p. ej. en desarrollo
  // local sin instalarlo), se sube el archivo sin masterizar en vez de
  // tumbar todo el render — se advierte claramente, nunca en silencio.
  let outputPath = rawOutputPath;
  try {
    const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
    const mastering = await masterAudioLoudness(rawOutputPath, masteredPath);
    outputPath = masteredPath;
    console.log(
      "[atomivid:audio] masterización de loudness",
      JSON.stringify({ requestId, target: LOUDNESS_TARGET, ...mastering }),
    );
  } catch (err) {
    console.warn(
      `[atomivid:audio] ${requestId} — no se pudo masterizar el loudness (¿falta ffmpeg?), ` +
        "se sube el video sin normalizar:",
      err instanceof Error ? err.message : err,
    );
  }

  // 8. Subir el video renderizado (se referencia por su ruta; la URL para
  // verlo/descargarlo se firma bajo demanda, después de validar dueño).
  await onProgress?.("uploading");
  const videoBuffer = await fs.readFile(outputPath);
  storageBytes += videoBuffer.byteLength;
  const { path: videoPath } = await uploadToStorage(
    supabase,
    `${artifactPrefix}/final.mp4`,
    videoBuffer,
    "video/mp4",
  );
  await fs.unlink(outputPath).catch(() => {});
  if (outputPath !== rawOutputPath) {
    await fs.unlink(rawOutputPath).catch(() => {});
  }

  // Costo estimado de esta etapa — no bloquea el resultado si falla (es
  // instrumentación, no debe tumbar un video que sí se generó bien).
  await recordVideoGeneration(supabase, requestId, {
    voiceProvider: voiceProvider.name,
    voiceCharacters: fullText.length,
    footageProvider: footageProvider.name,
    footageCount: scenes.length,
    // "none" dice explícitamente que el video se generó sin música por un
    // fallback (no confundir con "no se registró" — ver musicFallbackReason
    // en los logs de arriba para la causa exacta).
    musicProvider: music ? musicProvider.name : "none",
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
    creativeLayer:
      imagesRequestedCount > 0
        ? {
            imageProvider: usedGeneratedImageProvider ?? undefined,
            imageGenerationCount: imagesGeneratedCount,
            imageCostUsd: visualCostSpentUsd,
            imageRequestedCount: imagesRequestedCount,
            imageReusedCount: imagesReusedCount,
            imageDryRun: false,
            imageModel: usedGeneratedImageModel ?? undefined,
            imageSize: usedGeneratedImageSize ?? undefined,
          }
        : undefined,
  }).catch((err) => {
    console.warn(`No se pudo registrar el costo de ${requestId}:`, err);
  });

  return { videoPath };
}

function alignScenesToWords(
  segments: { text: string }[],
  words: WordTiming[],
): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  let wordIndex = 0;

  for (const segment of segments) {
    const wordCount = Math.max(
      segment.text.split(/\s+/).filter(Boolean).length,
      1,
    );
    const startIdx = Math.max(0, Math.min(wordIndex, words.length - 1));
    const endIdx = Math.max(
      0,
      Math.min(wordIndex + wordCount - 1, words.length - 1),
    );

    result.push({
      start: words[startIdx]?.startSeconds ?? 0,
      end: words[endIdx]?.endSeconds ?? words[startIdx]?.startSeconds ?? 0,
    });

    wordIndex += wordCount;
  }

  return result;
}

/**
 * Sube un archivo al bucket privado y devuelve tanto su ruta (para
 * guardarla y firmar una URL nueva más adelante) como una URL firmada de
 * corta duración (para que este mismo proceso de render pueda leerlo de
 * inmediato, p. ej. Remotion descargando una imagen o un audio).
 */
async function uploadToStorage(
  supabase: SupabaseClient,
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string; url: string }> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) {
    throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);
  }

  const { data, error: signError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(objectPath, ASSET_SIGNED_URL_TTL_SECONDS);

  if (signError || !data) {
    throw new Error(
      `No se pudo firmar la URL de ${objectPath}: ${signError?.message ?? "desconocido"}`,
    );
  }

  return { path: objectPath, url: data.signedUrl };
}

async function renderVerticalReel({
  audioUrl,
  musicUrl,
  scenes,
  captions,
  narrationGaps,
  durationSeconds,
}: {
  audioUrl: string;
  musicUrl?: string;
  scenes: Scene[];
  captions: Caption[];
  narrationGaps: NarrationGap[];
  durationSeconds: number;
}): Promise<string> {
  const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  // Chrome >= 132 quitó el "old headless mode" que Remotion usa por
  // defecto. Si apuntas REMOTION_BROWSER_EXECUTABLE a un chrome-headless-shell
  // (recomendado), configura también REMOTION_CHROME_MODE=headless-shell.
  const chromeMode =
    (process.env.REMOTION_CHROME_MODE as "chrome-for-testing" | "headless-shell" | undefined) ||
    undefined;

  const serveUrl = await bundle({ entryPoint });

  const inputProps = {
    audioUrl,
    musicUrl,
    scenes,
    captions,
    narrationGaps,
    durationSeconds,
    accentColor: getAccentColor(),
  };

  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    browserExecutable,
    chromeMode,
  });

  const outputLocation = path.join(
    os.tmpdir(),
    `atomivid-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    inputProps,
    browserExecutable,
    chromeMode,
    // Sin esto, Remotion usa un CRF cercano a sin-pérdida por defecto — con
    // fotos reales (no los placeholders planos del fixture) y Ken Burns,
    // eso produce archivos varias veces más grandes de lo necesario para
    // un reel vertical (llegó a exceder el límite de tamaño de Supabase
    // Storage). CRF 26 es suficiente para TikTok/Reels/Shorts, que de
    // todas formas re-comprimen el video al subirlo.
    crf: 26,
  });

  return outputLocation;
}
