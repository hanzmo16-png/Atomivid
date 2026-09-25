/**
 * Envoltorio de render para la composición Remotion "LongFormDoc" (16:9) —
 * independiente de generate-video.ts (Shorts/"VerticalReel"), al que este
 * archivo no importa ni modifica. Reutiliza exactamente el mismo patrón
 * (@remotion/bundler + @remotion/renderer, mismas variables de entorno
 * REMOTION_BROWSER_EXECUTABLE/REMOTION_CHROME_MODE) — no una copia
 * accidental, sino la misma técnica ya validada para Shorts, aplicada a
 * una composición distinta.
 */
import { validateDirection, type SoundCue } from "../../../../remotion/long-form-direction";
import path from "node:path";
import os from "node:os";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { LongFormCaption, LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { NarrationGap } from "../../../../remotion/audio-mix";
import { assertRenderInputValid } from "./render-preflight";
import { LEGACY_LONG_FORM_ENCODING, LONG_FORM_ENCODING_PROFILE } from "./output-policy";

const COMPOSITION_ID = "LongFormDoc";

export type RenderLongFormDocInput = {
  audioUrl: string;
  musicUrl?: string;
  soundCues?: SoundCue[];
  scenes: LongFormShotScene[];
  captions: LongFormCaption[];
  narrationGaps: NarrationGap[];
  durationSeconds: number;
  accentColor?: string;
  showLogo?: boolean;
  /** Progreso REAL del render (fotogramas renderizados / total de la composición) — nunca estimado. */
  onFrameProgress?: (progress: { renderedFrames: number; totalFrames: number }) => void;
  /**
   * Perfil de codificación (output-policy.ts). Por defecto el de Long Form
   * v1 (CRF 23 con tope de bitrate); "legacy_crf26" reproduce el render
   * anterior al P0 — solo para medir el equivalente del original.
   */
  encoding?: "long_form_h264_v1" | "legacy_crf26";
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

  validateDirection(input.scenes, input.soundCues, input.durationSeconds);

  const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode =
    (process.env.REMOTION_CHROME_MODE as "chrome-for-testing" | "headless-shell" | undefined) || undefined;

  const serveUrl = await bundle({ entryPoint });

  const inputProps = {
    audioUrl: input.audioUrl,
    musicUrl: input.musicUrl,
    soundCues: input.soundCues,
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
    // P0 2026-09-25: el CRF 26 SIN tope (el de Shorts) produjo un final.mp4
    // de ~300 s que Storage rechazó por tamaño. Long Form usa su propio
    // perfil: CRF 23 (más calidad a 1080p) con tope de bitrate, de modo que
    // el tamaño queda acotado por duración (ver estimateOutputBytes).
    ...(input.encoding === "legacy_crf26"
      ? { crf: LEGACY_LONG_FORM_ENCODING.crf }
      : {
          crf: LONG_FORM_ENCODING_PROFILE.crf,
          encodingMaxRate: `${LONG_FORM_ENCODING_PROFILE.maxVideoKbps}k`,
          encodingBufferSize: `${LONG_FORM_ENCODING_PROFILE.bufferKbps}k`,
          x264Preset: LONG_FORM_ENCODING_PROFILE.x264Preset,
        }),
    onProgress: input.onFrameProgress
      ? ({ renderedFrames }) => input.onFrameProgress?.({ renderedFrames, totalFrames: composition.durationInFrames })
      : undefined,
  });

  return outputLocation;
}
