/**
 * I/O de medios para la entrega de Long Form: medir el MP4 ya renderizado
 * (ffprobe) y, si Storage no lo acepta por tamaño, ajustarlo desde ESE
 * MISMO archivo (ffmpeg 2-pass a un bitrate calculado). Nunca re-renderiza
 * ni llama a un proveedor.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OutputMediaMetrics = {
  bytes: number;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  totalKbps: number;
  videoKbps: number | null;
  audioKbps: number | null;
};

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} terminó con código ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/** Métricas reales del archivo (tamaño en disco + ffprobe). */
export async function probeOutput(filePath: string): Promise<OutputMediaMetrics> {
  const stat = await fs.stat(filePath);
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath]);
  const json = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; bit_rate?: string }[];
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(json.format?.duration ?? 0);
  const kbps = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Math.round(Number(v) / 1000) : null);
  return {
    bytes: stat.size,
    durationSeconds,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    totalKbps: durationSeconds > 0 ? Math.round((stat.size * 8) / durationSeconds / 1000) : 0,
    videoKbps: kbps(video?.bit_rate),
    audioKbps: kbps(audio?.bit_rate),
  };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Ajusta el tamaño con x264 2-pass (bitrate medio exacto → tamaño
 * predecible) desde el archivo ya renderizado. Mantiene resolución, fps y
 * duración; `+faststart` para que el reproductor arranque sin descargar
 * todo el archivo.
 */
export async function transcodeToFit(input: { sourcePath: string; outputPath: string; videoKbps: number; audioKbps: number }): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-fit-"));
  const passlog = path.join(workDir, "pass");
  const common = ["-c:v", "libx264", "-preset", "medium", "-b:v", `${input.videoKbps}k`, "-maxrate", `${Math.round(input.videoKbps * 1.5)}k`, "-bufsize", `${input.videoKbps * 2}k`, "-pix_fmt", "yuv420p"];
  try {
    await run("ffmpeg", ["-y", "-i", input.sourcePath, ...common, "-pass", "1", "-passlogfile", passlog, "-an", "-f", "mp4", os.platform() === "win32" ? "NUL" : "/dev/null"]);
    await run("ffmpeg", [
      "-y",
      "-i",
      input.sourcePath,
      ...common,
      "-pass",
      "2",
      "-passlogfile",
      passlog,
      "-c:a",
      "aac",
      "-b:a",
      `${input.audioKbps}k`,
      "-movflags",
      "+faststart",
      input.outputPath,
    ]);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
