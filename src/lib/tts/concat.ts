/**
 * Une los fragmentos de «Texto a voz» en un solo MP3 con los silencios de
 * cada pausa (ffmpeg; mismo binario libre que ya usa audio-master.ts en el
 * worker). No normaliza ni procesa la voz: solo concatena y codifica.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ConcatPart = { audio: Buffer; extension: string; pauseAfterMs: number };

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} terminó con código ${code}: ${stderr.slice(-1500)}`))));
  });
}

/** Argumentos de ffmpeg: cada fragmento seguido de su silencio, a 44,1 kHz mono, MP3 128 kbps. Exportado para probarlo sin ffmpeg. */
export function concatArgs(inputs: string[], pausesMs: number[], output: string): string[] {
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);
  const labels: string[] = [];
  const filters: string[] = [];
  inputs.forEach((_, i) => {
    filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`);
    labels.push(`[a${i}]`);
    const pause = pausesMs[i] ?? 0;
    if (pause > 0) {
      filters.push(`anullsrc=r=44100:cl=mono,atrim=duration=${(pause / 1000).toFixed(3)}[s${i}]`);
      labels.push(`[s${i}]`);
    }
  });
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "128k", output);
  return args;
}

export async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error("No se pudo medir la duración del audio final.");
  return value;
}

export async function concatToMp3(parts: ConcatPart[]): Promise<{ audio: Buffer; durationSeconds: number }> {
  if (!parts.length) throw new Error("No hay fragmentos para unir.");
  const dir = await mkdtemp(path.join(tmpdir(), "atomivid-tts-"));
  try {
    const inputs = await Promise.all(
      parts.map(async (part, i) => {
        const file = path.join(dir, `part-${String(i).padStart(4, "0")}.${part.extension}`);
        await writeFile(file, part.audio);
        return file;
      }),
    );
    const output = path.join(dir, "final.mp3");
    await run("ffmpeg", concatArgs(inputs, parts.map((p) => p.pauseAfterMs), output));
    return { audio: await readFile(output), durationSeconds: await probeDurationSeconds(output) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
