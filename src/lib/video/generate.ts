import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getScriptProvider } from "@/lib/providers/script";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getFootageProvider } from "@/lib/providers/footage";
import { getMusicProvider } from "@/lib/providers/music";
import type { GeneratedScript, WordTiming } from "@/lib/providers/types";
import type { RenderStage } from "@/lib/video/stages";
import type { Caption, Scene } from "../../../remotion/VerticalReel";

const STORAGE_BUCKET = "videos";
const MAX_CAPTION_WORDS = 7;
const MIN_CAPTION_WORDS = 2;
const COMPOSITION_ID = "VerticalReel";
// El bucket es privado: los assets intermedios (voz/footage/música) se
// firman por un rato corto, solo el tiempo que tarda este mismo proceso en
// leerlos para el render — no necesitan durar más que eso.
const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

type OnProgress = (stage: RenderStage) => void | Promise<void>;

/**
 * Etapa 1 del pipeline: solo el guion. Se guarda para que el usuario lo
 * revise/edite (y pueda regenerar una escena puntual) antes de gastar en
 * voz, footage, música y render.
 */
export async function generateScriptForRequest({
  topic,
  style,
  durationSeconds,
}: {
  topic: string;
  style: string;
  durationSeconds: number;
}): Promise<GeneratedScript> {
  const scriptProvider = getScriptProvider();
  return scriptProvider.generateScript({ topic, style, durationSeconds });
}

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
  onProgress,
}: {
  supabase: SupabaseClient;
  requestId: string;
  script: GeneratedScript;
  /** Estilo elegido por el usuario (p. ej. "Motivacional") — usado para elegir música acorde. */
  style?: string;
  onProgress?: OnProgress;
}): Promise<{ videoPath: string }> {
  const voiceProvider = getVoiceProvider();
  const footageProvider = getFootageProvider();
  const musicProvider = getMusicProvider();

  // 1. Voz narrada completa en una sola llamada, con timestamps por
  // palabra (así toda la narración usa la misma voz y ritmo).
  await onProgress?.("voice");
  const fullText = script.segments.map((s) => s.text).join(" ");
  const voice = await voiceProvider.synthesize(fullText);

  // 2. Repartir el tiempo de la narración real entre las escenas del guion
  const sceneTimings = alignScenesToWords(script.segments, voice.words);

  // 3. Footage: una imagen por escena, subida a Storage
  await onProgress?.("footage");
  const scenes: Scene[] = [];
  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const image = await footageProvider.fetchImage(segment.visualQuery);
    const imageBuffer = await footageProvider.downloadImage(image.url);
    const { url: imageUrl } = await uploadToStorage(
      supabase,
      `${requestId}/scene-${i}.${image.extension}`,
      imageBuffer,
      image.mimeType,
    );
    scenes.push({
      imageUrl,
      startSeconds: timing.start,
      endSeconds: timing.end,
    });
  }

  // 4. Subir la narración generada
  const { url: audioUrl } = await uploadToStorage(
    supabase,
    `${requestId}/voice.${voice.extension}`,
    voice.audioBuffer,
    voice.mimeType,
  );

  // 5. Música de fondo (por debajo del volumen de la narración)
  await onProgress?.("music");
  const finalDurationSeconds = voice.durationSeconds + 0.5;
  const music = await musicProvider.getTrack(finalDurationSeconds, style);
  const { url: musicUrl } = await uploadToStorage(
    supabase,
    `${requestId}/music.${music.extension}`,
    music.audioBuffer,
    music.mimeType,
  );

  // 6. Subtítulos incrustados: frases naturales (corte en puntuación),
  // nunca una sola palabra a la vez.
  const captions = buildCaptions(voice.words);

  // 7. Ensamblar el video final con Remotion
  await onProgress?.("render");
  const outputPath = await renderVerticalReel({
    audioUrl,
    musicUrl,
    scenes,
    captions,
    durationSeconds: finalDurationSeconds,
  });

  // 8. Subir el video renderizado (se referencia por su ruta; la URL para
  // verlo/descargarlo se firma bajo demanda, después de validar dueño).
  await onProgress?.("uploading");
  const videoBuffer = await fs.readFile(outputPath);
  const { path: videoPath } = await uploadToStorage(
    supabase,
    `${requestId}/final.mp4`,
    videoBuffer,
    "video/mp4",
  );
  await fs.unlink(outputPath).catch(() => {});

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
 * con un máximo de palabras por línea para que no queden demasiado largas.
 * Nunca deja una sola palabra visible a la vez (estilo karaoke).
 */
function buildCaptions(words: WordTiming[]): Caption[] {
  const captions: Caption[] = [];
  let group: WordTiming[] = [];

  const flush = () => {
    if (group.length === 0) return;
    captions.push({
      text: group.map((w) => w.text).join(" "),
      startSeconds: group[0].startSeconds,
      endSeconds: group[group.length - 1].endSeconds,
    });
    group = [];
  };

  for (const word of words) {
    group.push(word);
    const endsPhrase = /[,.;:!?]$/.test(word.text);
    const longEnough = group.length >= MIN_CAPTION_WORDS;

    if (group.length >= MAX_CAPTION_WORDS || (endsPhrase && longEnough)) {
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
  durationSeconds,
}: {
  audioUrl: string;
  musicUrl?: string;
  scenes: Scene[];
  captions: Caption[];
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

  const inputProps = { audioUrl, musicUrl, scenes, captions, durationSeconds };

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
  });

  return outputLocation;
}
