import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import { reelVisibleCrop } from "../../../remotion/reel-framing";

const execute = promisify(execFile);
const MIN_NATIVE_WIDTH = 720;
const MIN_NATIVE_HEIGHT = 1280;
const REVIEW_WIDTH = 512;
const REVIEW_HEIGHT = 910;

/** A defective candidate may be skipped. Infrastructure/provider/budget failures may not. */
export class VisualAssetQualityError extends Error {
  constructor(message: string) { super(message); this.name = "VisualAssetQualityError"; }
}

async function imageViews(buffer: Buffer, isHook: boolean): Promise<string[]> {
  try {
    const image = sharp(buffer, { limitInputPixels: 32_000_000, failOn: "warning" }).autoOrient();
    const meta = await image.metadata();
    if (!meta.width || !meta.height || (meta.pages ?? 1) > 1 || meta.format === "svg") {
      throw new VisualAssetQualityError("La imagen necesita ser un archivo raster estático válido.");
    }
    const { width, height } = meta.autoOrient;
    const base = reelVisibleCrop(width, height, isHook, false);
    // Floor applies to native pixels after the vertical cover crop, before camera zoom.
    // Upscaling a small file must not manufacture eligibility.
    if (base.width < MIN_NATIVE_WIDTH || base.height < MIN_NATIVE_HEIGHT) {
      throw new VisualAssetQualityError(`El recorte vertical solo conserva ${base.width}×${base.height} píxeles; se requieren al menos 720×1280.`);
    }
    const views: string[] = [];
    for (const zoomed of [false, true]) {
      const crop = reelVisibleCrop(width, height, isHook, zoomed);
      const bytes = await image.clone().extract(crop).resize(REVIEW_WIDTH, REVIEW_HEIGHT).flatten({ background: "black" }).jpeg({ quality: 90 }).toBuffer();
      views.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    }
    return views;
  } catch (error) {
    if (error instanceof VisualAssetQualityError) throw error;
    throw new VisualAssetQualityError("No se pudo decodificar la imagen con calidad suficiente.");
  }
}

function badVideo(error: unknown): never {
  const processError = error as { code?: string | number; killed?: boolean };
  // A missing executable or a timeout is an operational failure, not permission
  // to switch to paid generation or to treat an unavailable check as acceptance.
  if (typeof processError.code === "string" || processError.killed) throw error;
  throw new VisualAssetQualityError("El clip no contiene video decodificable y verificable.");
}

/** Base and maximum-camera views, at beginning/middle/end of the portion actually used. */
export async function visualReviewFrames(buffer: Buffer, mediaType: "image" | "video", durationSeconds: number, sceneIndex = 0): Promise<string[]> {
  if (!buffer.length || buffer.length > 50 * 1024 * 1024) throw new VisualAssetQualityError("El recurso visual está vacío o supera 50 MB.");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("La duración de la escena no es válida para su revisión.");
  if (mediaType === "image") return imageViews(buffer, sceneIndex === 0);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-visual-review-"));
  try {
    const input = path.join(directory, "input.mp4");
    await fs.writeFile(input, buffer);
    let probe: { streams?: Array<{ width?: number; height?: number; duration?: string; sample_aspect_ratio?: string }>; format?: { duration?: string } };
    try {
      const { stdout } = await execute(ffprobe.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,sample_aspect_ratio:format=duration", "-of", "json", input], { timeout: 10_000, maxBuffer: 64 * 1024 });
      probe = JSON.parse(stdout);
    } catch (error) { badVideo(error); }
    const stream = probe.streams?.[0];
    if (!stream?.width || !stream.height || stream.width * stream.height > 32_000_000) throw new VisualAssetQualityError("El clip no tiene dimensiones de video válidas.");
    if (stream.sample_aspect_ratio && !["1:1", "N/A", "0:1"].includes(stream.sample_aspect_ratio)) throw new VisualAssetQualityError("El clip utiliza píxeles no cuadrados; necesita normalizarse antes de su revisión.");
    const streamDuration = Number(stream.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration + 0.05 < durationSeconds) throw new VisualAssetQualityError("El clip es demasiado corto para cubrir la escena completa.");
    const usedDuration = Math.min(duration, durationSeconds);
    const times = [Math.min(0.05, usedDuration / 4), usedDuration / 2, Math.max(usedDuration / 2, usedDuration - 0.1)];
    const frames: string[] = [];
    for (const [index, second] of times.entries()) {
      const output = path.join(directory, `frame-${index}.jpg`);
      try {
        await execute(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-ss", String(second), "-i", input, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-y", output], { timeout: 20_000, maxBuffer: 64 * 1024 });
      } catch (error) { badVideo(error); }
      let pixels: Buffer;
      try { pixels = await fs.readFile(output); }
      catch { throw new VisualAssetQualityError("Falta un fotograma de la parte del clip que se utilizará."); }
      frames.push(...await imageViews(pixels, sceneIndex === 0));
    }
    return frames;
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
