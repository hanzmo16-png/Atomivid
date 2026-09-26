import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "../types";

const run = promisify(execFile);

/**
 * Proveedor de «Animación IA» SIMULADO para pruebas de integración gratuitas
 * (nunca en producción: readiness.ts solo lo acepta fuera de producción y
 * pedido explícitamente con REEL_ANIMATION_PROVIDER=fixture).
 *
 * Igual que Veo, exige la imagen de entrada y la descarga; produce un MP4
 * real 9:16 de la duración pedida a partir de ESA imagen, con un elemento
 * que se desplaza por encima (movimiento dentro del cuadro) para que el
 * render y ffprobe puedan comprobar el recorrido técnico. No representa la
 * calidad de una animación real.
 */
export const fixtureAnimationProvider: VideoProvider = {
  name: "fixture-animation",
  capabilities: { id: "fixture-animation", models: ["fixture-image-to-video"], formats: ["video/mp4"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
  isAvailable() {
    return true;
  },
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    if (!request.referenceImageUrl) {
      throw new GenerativeProviderError("fixture-animation: requiere imagen de entrada (image-to-video)", "fixture-animation", "invalid_request", undefined, undefined, "not_sent");
    }
    const operationName = `fixture-operations/${Buffer.from(request.referenceImageUrl).toString("base64url").slice(-16)}`;
    await request.onProviderJobAccepted?.(operationName);
    return render(request, operationName);
  },
  async resumeGeneration(operationName: string, request: VideoGenerationRequest): Promise<GenerativeAsset> {
    return render(request, operationName);
  },
};

async function render(request: VideoGenerationRequest, operationName: string): Promise<GenerativeAsset> {
  const res = await fetch(request.referenceImageUrl!);
  if (!res.ok) throw new GenerativeProviderError(`fixture-animation: imagen de entrada HTTP ${res.status}`, "fixture-animation", "invalid_request", undefined, operationName);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-anim-"));
  try {
    const input = path.join(dir, "in.png");
    const output = path.join(dir, "out.mp4");
    await fs.writeFile(input, Buffer.from(await res.arrayBuffer()));
    const seconds = request.durationSeconds;
    await run("ffmpeg", [
      "-v", "error", "-y", "-loop", "1", "-i", input,
      "-f", "lavfi", "-i", `color=c=white:s=120x120:d=${seconds}:r=24`,
      "-filter_complex",
      `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,format=yuv420p[bg];` +
        `[bg][1:v]overlay=x='40+(t/${seconds})*520':y=300:shortest=1,format=yuv420p[v]`,
      "-map", "[v]", "-t", String(seconds), "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", output,
    ]);
    const buffer = await fs.readFile(output);
    return { buffer, mimeType: "video/mp4", extension: "mp4", durationSeconds: seconds, model: "fixture-image-to-video", costUsd: 0, providerJobId: operationName };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
