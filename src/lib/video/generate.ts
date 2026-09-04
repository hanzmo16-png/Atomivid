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
import type { WordTiming } from "@/lib/providers/types";
import type { Caption, Scene } from "../../../remotion/VerticalReel";

const STORAGE_BUCKET = "videos";
const MAX_CAPTION_WORDS = 7;
const MIN_CAPTION_WORDS = 2;
const COMPOSITION_ID = "VerticalReel";

export async function generateVideoForRequest({
  supabase,
  requestId,
  topic,
  style,
  durationSeconds,
}: {
  supabase: SupabaseClient;
  requestId: string;
  topic: string;
  style: string;
  durationSeconds: number;
}): Promise<{ videoUrl: string }> {
  const scriptProvider = getScriptProvider();
  const voiceProvider = getVoiceProvider();
  const footageProvider = getFootageProvider();
  const musicProvider = getMusicProvider();

  // 1. Guion (título + escenas)
  const script = await scriptProvider.generateScript({ topic, style, durationSeconds });

  // 2. Voz narrada completa en una sola llamada, con timestamps por
  // palabra (así toda la narración usa la misma voz y ritmo).
  const fullText = script.segments.map((s) => s.text).join(" ");
  const voice = await voiceProvider.synthesize(fullText);

  // 3. Repartir el tiempo de la narración real entre las escenas del guion
  const sceneTimings = alignScenesToWords(script.segments, voice.words);

  // 4. Footage: una imagen por escena, subida a Storage
  const scenes: Scene[] = [];
  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const image = await footageProvider.fetchImage(segment.visualQuery);
    const imageBuffer = await footageProvider.downloadImage(image.url);
    const imageUrl = await uploadToStorage(
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

  // 5. Subir la narración generada
  const audioUrl = await uploadToStorage(
    supabase,
    `${requestId}/voice.${voice.extension}`,
    voice.audioBuffer,
    voice.mimeType,
  );

  // 6. Música de fondo (por debajo del volumen de la narración)
  const finalDurationSeconds = voice.durationSeconds + 0.5;
  const music = await musicProvider.getTrack(finalDurationSeconds);
  const musicUrl = await uploadToStorage(
    supabase,
    `${requestId}/music.${music.extension}`,
    music.audioBuffer,
    music.mimeType,
  );

  // 7. Subtítulos incrustados: frases naturales (corte en puntuación),
  // nunca una sola palabra a la vez.
  const captions = buildCaptions(voice.words);

  // 8. Ensamblar el video final con Remotion
  const outputPath = await renderVerticalReel({
    audioUrl,
    musicUrl,
    scenes,
    captions,
    durationSeconds: finalDurationSeconds,
  });

  // 9. Subir el video renderizado
  const videoBuffer = await fs.readFile(outputPath);
  const videoUrl = await uploadToStorage(
    supabase,
    `${requestId}/final.mp4`,
    videoBuffer,
    "video/mp4",
  );
  await fs.unlink(outputPath).catch(() => {});

  return { videoUrl };
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

async function uploadToStorage(
  supabase: SupabaseClient,
  objectPath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, { contentType, upsert: true });

  if (error) {
    throw new Error(`No se pudo subir ${objectPath}: ${error.message}`);
  }

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
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
