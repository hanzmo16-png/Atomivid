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
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { coverErrors, validateCover, type CoverSpec } from "../../../../remotion/cover-rules";
import { provenanceLabel } from "../../../../remotion/long-form-card-fit";
import type { LongFormThumbnailProps } from "../../../../remotion/LongFormThumbnail";
import type { LongFormCaption, LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { NarrationGap } from "../../../../remotion/audio-mix";
import { assertRenderInputValid } from "./render-preflight";
import { assertApprovalReady, assertCardsFit } from "./render-approval";
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
  /**
   * "approval": render para aprobación editorial — se niega si alguna escena
   * sigue pendiente (carencia o revisión). "technical" (por defecto): se
   * renderiza, con las escenas pendientes marcadas de forma visible.
   */
  purpose?: "technical" | "approval";
  /** Portada de apertura opcional (validada aquí: legibilidad, márgenes, subtítulos y rótulos). */
  opening?: CoverSpec;
};

export class CoverValidationError extends Error {
  constructor(readonly target: "portada" | "miniatura", readonly issues: { code: string; message: string }[]) {
    super(`${target} inválida: ${issues.map((i) => i.message).join(" ")}`);
    this.name = "CoverValidationError";
  }
}

/** La portada se valida contra la primera escena: con rótulos arriba a la izquierda, el título no puede taparlos. */
export function assertOpeningValid(opening: CoverSpec, firstScene: LongFormShotScene | undefined): void {
  const labelsTopLeft = Boolean(firstScene && (provenanceLabel(firstScene.provenance) || firstScene.creditText || firstScene.pending));
  const errors = coverErrors(validateCover(opening, "video", { labelsTopLeft }));
  if (errors.length > 0) throw new CoverValidationError("portada", errors);
}

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
  assertCardsFit(input.scenes);
  if (input.purpose === "approval") assertApprovalReady(input.scenes);
  if (input.opening) assertOpeningValid(input.opening, input.scenes[0]);
  if (input.soundCues !== undefined && input.musicUrl) {
    // Las pistas explícitas REEMPLAZAN la música anterior (contrato de Work): pasar ambas es un error del llamador.
    throw new Error("render: soundCues y musicUrl a la vez — la música se duplicaría");
  }

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
    ...(input.opening ? { opening: input.opening } : {}),
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

/**
 * Miniatura de YouTube (JPEG 1280×720) con la misma identidad que la
 * portada. Validada antes de abrir el navegador; nunca llama a proveedores.
 */
export async function renderLongFormThumbnail(input: LongFormThumbnailProps): Promise<string> {
  const errors = coverErrors(validateCover(input.cover, "thumbnail"));
  if (errors.length > 0) throw new CoverValidationError("miniatura", errors);
  const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode =
    (process.env.REMOTION_CHROME_MODE as "chrome-for-testing" | "headless-shell" | undefined) || undefined;
  const serveUrl = await bundle({ entryPoint });
  const inputProps = { ...input } as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "LongFormThumbnail", inputProps, browserExecutable, chromeMode });
  const output = path.join(os.tmpdir(), `atomivid-thumbnail-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  await renderStill({ composition, serveUrl, output, inputProps, imageFormat: "jpeg", jpegQuality: 92, frame: 0, browserExecutable, chromeMode });
  return output;
}
