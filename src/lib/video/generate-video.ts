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
import { checkDuration, formatDurationWarning } from "@/lib/video/duration-check";
import { LOUDNESS_TARGET, masterAudioLoudness } from "@/lib/video/audio-master";
import { buildEmphasisSet, isEmphasisWord } from "@/lib/video/caption-emphasis";
import { getAccentColor } from "@/lib/video/brand";
import { evaluateQualityGate, QUALITY_GATE_MIN_SCORE } from "@/lib/video/quality-gate";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { buildStoryboard } from "@/lib/video/storyboard";

// Deliberadamente separado de generate-script.ts — ver el comentario ahí
// para la razón exacta (Remotion no debe cargarse en la ruta de guion).
// Este módulo (voz/footage/música/render) solo lo importan el worker
// inline (fallback de desarrollo, ver src/lib/video/run-job.ts) y el
// script de prueba end-to-end con fixtures.

const STORAGE_BUCKET = "videos";
const MAX_CAPTION_WORDS = 7;
const MIN_CAPTION_WORDS = 2;
// Presupuesto de caracteres para que el bloque quepa en 2 líneas — causa
// raíz confirmada de "subtítulos genéricos" que en la práctica podían
// exceder 2 líneas en pantalla: antes solo se limitaba por CANTIDAD de
// palabras (hasta 7), sin considerar su longitud real. ~28 caracteres por
// línea a un tamaño legible en 1080px de ancho con márgenes (ver
// VerticalReel.tsx) × 2 líneas, con margen de seguridad.
const MAX_CAPTION_CHARS = 52;
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
  script,
  style,
  topic,
  language = "es",
  targetDurationSeconds,
  onProgress,
}: {
  supabase: SupabaseClient;
  requestId: string;
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
  let storageBytes = 0;

  // 0. Storyboard semántico (Visual Director) — SOLO diagnóstico por ahora:
  // detrás de VISUAL_DIRECTOR_ENABLED (apagado por defecto, ver
  // feature-flags.ts), nunca bloquea el render si falla, y todavía NO
  // reemplaza las consultas de footage-select.ts (esa integración es el
  // siguiente paso, documentado como pendiente — ver docs/VISUAL_DIRECTOR.md).
  // Tampoco escribe en video_requests.storyboard_json/storyboard_source
  // porque esas columnas dependen de la migración 0010, que no se aplica
  // sola (ver supabase/migrations/0010_visual_director.sql).
  if (getFeatureFlags().visualDirectorEnabled) {
    try {
      const { storyboard, source } = await buildStoryboard(script, language);
      console.log(
        "[atomivid:storyboard]",
        JSON.stringify({
          requestId,
          source,
          totalScenes: storyboard.scenes.length,
          hookDescription: storyboard.hookDescription,
          closingDescription: storyboard.closingDescription,
          resourceTypes: storyboard.scenes.map((s) => s.resourceType),
        }),
      );
    } catch (err) {
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
  const voice = await voiceProvider.synthesize(fullText, language);

  // Verificación de duración REAL (no estimada) contra el objetivo de la
  // solicitud — nunca estira ni recorta nada (eso sonaría artificial),
  // solo advierte cuando el guion quedó fuera de tolerancia (±10%) para
  // poder recalibrar WORDS_PER_SECOND (script-pacing.ts) con datos reales
  // en vez de dejarlo pasar en silencio. Causa raíz confirmada del
  // defecto "duración ~28% menor que la pedida" en el video auditado.
  let durationWithinTolerance = true;
  if (targetDurationSeconds !== undefined) {
    const durationResult = checkDuration(targetDurationSeconds, voice.durationSeconds);
    durationWithinTolerance = durationResult.withinTolerance;
    if (!durationResult.withinTolerance) {
      console.warn(`[atomivid:duration] ${requestId} — ${formatDurationWarning(durationResult)}`);
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

  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const beats = splitIntoBeats(timing.start, timing.end);
    const baseConcepts =
      segment.visualConcepts && segment.visualConcepts.length > 0
        ? segment.visualConcepts
        : [segment.visualQuery];

    for (let b = 0; b < beats.length; b++) {
      const beat = beats[b];
      const beatDuration = Math.max(0, beat.end - beat.start);
      // Beats después del primero dentro de la misma escena empiezan por
      // un concepto distinto (si hay más de uno) para variar el plano en
      // vez de repetir la misma búsqueda dentro de la propia escena.
      const rotation = b % baseConcepts.length;
      const beatConcepts = [...baseConcepts.slice(rotation), ...baseConcepts.slice(0, rotation)];

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
        `${requestId}/scene-${i}-${b}.${outcome.result.extension}`,
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
    `${requestId}/voice.${voice.extension}`,
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
  const finalDurationSeconds = voice.durationSeconds + 0.5;
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
      `${requestId}/music.${music.extension}`,
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
  // máximo 2 líneas, nunca una sola palabra a la vez, con palabras clave
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
    `${requestId}/final.mp4`,
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
 * Agrupa palabras en subtítulos por frase natural (corta en puntuación),
 * con un máximo de palabras Y de caracteres por bloque (para que quepa en
 * 2 líneas — ver MAX_CAPTION_CHARS) y marca cuáles palabras deben
 * enfatizarse (ver caption-emphasis.ts). Nunca deja una sola palabra
 * visible a la vez (estilo karaoke) ni corta una palabra a la mitad.
 */
function buildCaptions(words: WordTiming[], emphasisSet: ReadonlySet<string>): Caption[] {
  const captions: Caption[] = [];
  let group: WordTiming[] = [];
  let groupChars = 0;

  const flush = () => {
    if (group.length === 0) return;
    const emphasisWords = group.filter((w) => isEmphasisWord(w.text, emphasisSet)).map((w) => w.text);
    captions.push({
      text: group.map((w) => w.text).join(" "),
      startSeconds: group[0].startSeconds,
      endSeconds: group[group.length - 1].endSeconds,
      ...(emphasisWords.length > 0 ? { emphasisWords } : {}),
    });
    group = [];
    groupChars = 0;
  };

  for (const word of words) {
    const nextChars = groupChars + (groupChars > 0 ? 1 : 0) + word.text.length;
    // Si esta palabra excede el presupuesto de caracteres, cierra el
    // bloque actual ANTES de agregarla (nunca corta una palabra a la
    // mitad) — salvo que el bloque siga vacío (una palabra muy larga sola).
    if (group.length > 0 && nextChars > MAX_CAPTION_CHARS) {
      flush();
    }
    group.push(word);
    groupChars += (groupChars > 0 ? 1 : 0) + word.text.length;

    const endsPhrase = /[,.;:!?]$/.test(word.text);
    const longEnough = group.length >= MIN_CAPTION_WORDS;

    if (group.length >= MAX_CAPTION_WORDS || groupChars >= MAX_CAPTION_CHARS || (endsPhrase && longEnough)) {
      flush();
    }
  }
  flush();

  // Si quedó un grupo final de una sola palabra, pégalo al anterior en vez
  // de mostrarlo solo.
  if (captions.length >= 2) {
    const last = captions[captions.length - 1];
    if (last.text.split(/\s+/).length < MIN_CAPTION_WORDS) {
      const prev = captions[captions.length - 2];
      prev.text = `${prev.text} ${last.text}`;
      prev.endSeconds = last.endSeconds;
      prev.emphasisWords = [...(prev.emphasisWords ?? []), ...(last.emphasisWords ?? [])];
      if (prev.emphasisWords.length === 0) delete prev.emphasisWords;
      captions.pop();
    }
  }

  return captions;
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
