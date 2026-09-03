import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";

import { generateScript } from "@/lib/ai/script";
import { synthesizeVoice, type WordTiming } from "@/lib/ai/voice";
import { downloadImage, fetchSceneImage } from "@/lib/ai/footage";
import type { Caption, Scene } from "../../../remotion/VerticalReel";

const STORAGE_BUCKET = "videos";
const CAPTION_WORDS_PER_CHUNK = 4;
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
  // 1. Guion (título + escenas) vía Claude
  const script = await generateScript({ topic, style, durationSeconds });

  // 2. Voz narrada completa en una sola llamada, con timestamps por
  // palabra (así toda la narración usa la misma voz y ritmo).
  const fullText = script.segments.map((s) => s.text).join(" ");
  const voice = await synthesizeVoice(fullText);

  // 3. Repartir el tiempo de la narración real entre las escenas del guion
  const sceneTimings = alignScenesToWords(script.segments, voice.words);

  // 4. Footage: una imagen de Pexels por escena, subida a Storage
  const scenes: Scene[] = [];
  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const timing = sceneTimings[i];
    const image = await fetchSceneImage(segment.visualQuery);
    const imageBuffer = await downloadImage(image.url);
    const imageUrl = await uploadToStorage(
      supabase,
      `${requestId}/scene-${i}.jpg`,
      imageBuffer,
      "image/jpeg",
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
    `${requestId}/voice.mp3`,
    voice.audioBuffer,
    "audio/mpeg",
  );

  // 6. Subtítulos incrustados: frases cortas de pocas palabras
  const captions = buildCaptions(voice.words);

  // 7. Ensamblar el video final con Remotion
  const finalDurationSeconds = voice.durationSeconds + 0.5;
  const outputPath = await renderVerticalReel({
    audioUrl,
    scenes,
    captions,
    durationSeconds: finalDurationSeconds,
  });

  // 8. Subir el video renderizado
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

function buildCaptions(words: WordTiming[]): Caption[] {
  const captions: Caption[] = [];

  for (let i = 0; i < words.length; i += CAPTION_WORDS_PER_CHUNK) {
    const chunk = words.slice(i, i + CAPTION_WORDS_PER_CHUNK);
    if (chunk.length === 0) continue;

    captions.push({
      text: chunk.map((w) => w.text).join(" "),
      startSeconds: chunk[0].startSeconds,
      endSeconds: chunk[chunk.length - 1].endSeconds,
    });
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
  scenes,
  captions,
  durationSeconds,
}: {
  audioUrl: string;
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

  const inputProps = { audioUrl, scenes, captions, durationSeconds };

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
