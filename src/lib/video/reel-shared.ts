/**
 * Piezas compartidas del pipeline de Reel (flujo anterior en
 * generate-video.ts y flujo dirigido en audiovisual/directed-reel.ts):
 * alineación escena↔palabras, subida a Storage y render de VerticalReel.
 * Movidas sin cambios de comportamiento desde generate-video.ts; el render
 * acepta además props opcionales (movimiento, grado, mezcla) que el flujo
 * anterior nunca envía.
 */
import path from "node:path";
import os from "node:os";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WordTiming } from "@/lib/providers/types";
import type { Caption, Scene, VerticalReelProps } from "../../../remotion/VerticalReel";
import type { NarrationGap } from "../../../remotion/audio-mix";
import { getAccentColor, shouldShowLogo } from "@/lib/video/brand";

export const STORAGE_BUCKET = "videos";
const COMPOSITION_ID = "VerticalReel";
// El bucket es privado: los assets intermedios (voz/footage/música) se
// firman por un rato corto, solo el tiempo que tarda este mismo proceso en
// leerlos para el render — no necesitan durar más que eso.
export const ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60;

export function alignScenesToWords(
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
export async function uploadToStorage(
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

export async function renderVerticalReel({
  audioUrl,
  musicUrl,
  scenes,
  captions,
  narrationGaps,
  durationSeconds,
  look,
  mix,
}: {
  audioUrl: string;
  musicUrl?: string;
  scenes: Scene[];
  captions: Caption[];
  narrationGaps: NarrationGap[];
  durationSeconds: number;
  /** Solo flujo dirigido (dirección audiovisual); ausente = render idéntico al anterior. */
  look?: VerticalReelProps["look"];
  mix?: VerticalReelProps["mix"];
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
    showLogo: shouldShowLogo(),
    ...(look ? { look } : {}),
    ...(mix ? { mix } : {}),
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
