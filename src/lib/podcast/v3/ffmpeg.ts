/** Ejecutor mínimo de ffmpeg/ffprobe para Podcast 3.0 (sin shell; argumentos como lista). */
import { spawn } from "node:child_process";

export function ffmpeg(args: string[], bin = process.env.FFMPEG_BIN || "ffmpeg"): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-nostdin", ...args]);
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000); });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve({ stderr }) : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-1500)}`)));
  });
}

export function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", (code) => { const n = Number(out.trim()); code === 0 && Number.isFinite(n) ? resolve(n) : reject(new Error(`ffprobe ${code} ${file}`)); });
  });
}

/** Lee PCM mono f32 (para medir energía/espectro en pruebas y QC). */
export function readPcm(file: string, rate = 16000, extra: string[] = [], channels = 1): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", file, ...extra, "-map", "0:a:0", "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => { if (code !== 0) return reject(new Error(`pcm ${code}`)); const b = Buffer.concat(chunks); resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))); });
  });
}

/** RMS en dBFS de un tramo [start,end) en segundos. */
export function rmsDb(pcm: Float32Array, rate: number, start: number, end: number): number {
  const a = Math.max(0, Math.floor(start * rate)), b = Math.min(pcm.length, Math.floor(end * rate));
  if (b <= a) return -120;
  let s = 0; for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return 10 * Math.log10(s / (b - a) + 1e-12);
}

/** Medición EBU R128 (integrado y true peak) con ebur128. */
export async function ebur128(file: string): Promise<{ lufs: number; truePeak: number; clipped: number }> {
  const { stderr } = await ffmpeg(["-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const tail = stderr.slice(stderr.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(tail)?.[1]);
  const truePeak = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(tail.slice(tail.indexOf("True peak")))?.[1]);
  // Recortes por canal y a la frecuencia original (una mezcla a mono sumaría canales correlacionados y daría falsos recortes).
  const pcm = await readPcm(file, 48000, [], 2);
  let clipped = 0; for (const x of pcm) if (Math.abs(x) >= 0.999) clipped++;
  return { lufs, truePeak, clipped };
}
