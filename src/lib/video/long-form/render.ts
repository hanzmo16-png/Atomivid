/**
 * Envoltorio de render para la composición Remotion "LongFormDoc" (16:9) —
 * independiente de generate-video.ts (Shorts/"VerticalReel"), al que este
 * archivo no importa ni modifica. Reutiliza exactamente el mismo patrón
 * (@remotion/bundler + @remotion/renderer, mismas variables de entorno
 * REMOTION_BROWSER_EXECUTABLE/REMOTION_CHROME_MODE) — no una copia
 * accidental, sino la misma técnica ya validada para Shorts, aplicada a
 * una composición distinta.
 */
import path from "node:path";
import os from "node:os";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { LongFormCaption, LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { NarrationGap } from "../../../../remotion/audio-mix";
import { assertRenderInputValid } from "./render-preflight";

const COMPOSITION_ID = "LongFormDoc";

export type RenderLongFormDocInput = {
  audioUrl: string;
  musicUrl?: string;
  scenes: LongFormShotScene[];
  captions: LongFormCaption[];
  narrationGaps: NarrationGap[];
  durationSeconds: number;
  accentColor?: string;
  showLogo?: boolean;
};

export async function renderLongFormDoc(input: RenderLongFormDocInput): Promise<string> {
  // Preflight ESTÁTICO antes de gastar tiempo de bundle/render — sobre
  // todo importante en modo real, donde los assets de las escenas ya se
  // pagaron: un hueco o desalineación aquí se detecta ANTES de renderizar
  // un video roto con contenido que ya costó dinero.
  assertRenderInputValid({
    scenes: input.scenes.map((s) => ({ id: s.id, startSeconds: s.startSeconds, endSeconds: s.endSeconds })),
    captions: input.captions.map((c) => ({ startSeconds: c.startSeconds, endSeconds: c.endSeconds })),
    durationSeconds: input.durationSeconds,
    audioUrl: input.audioUrl,
  });

  const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode =
    (process.env.REMOTION_CHROME_MODE as "chrome-for-testing" | "headless-shell" | undefined) || undefined;

  const serveUrl = await bundle({ entryPoint });

  const inputProps = {
    audioUrl: input.audioUrl,
    musicUrl: input.musicUrl,
    scenes: input.scenes,
    captions: input.captions,
    narrationGaps: input.narrationGaps,
    durationSeconds: input.durationSeconds,
    accentColor: input.accentColor,
    showLogo: input.showLogo ?? false,
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
    `atomivid-longform-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    inputProps,
    browserExecutable,
    chromeMode,
    // Mismo CRF que Shorts (ver comentario en generate-video.ts) — suficiente
    // para YouTube, que igual re-comprime el video al subirlo.
    crf: 26,
  });

  return outputLocation;
}
