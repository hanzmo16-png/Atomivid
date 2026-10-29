/**
 * Pista de subtítulos de Long Form.
 *
 * El render (Remotion) quema los subtítulos en la imagen y no escribe una
 * pista en el MP4 ni conserva el SRT. YouTube y la inspección del contenedor
 * ven entonces `tracks: 0`. Este paso muxa `mov_text` con copia de video y
 * audio (la imagen y el sonido no se reencodifican) y deja el SRT sidecar
 * que el paquete de YouTube espera (`subtitles.<idioma>.srt`).
 *
 * Falla cerrado: sin texto, tiempos no monótonos, un cue que termina fuera
 * de la duración, o un MP4 que sigue en cero pistas, no se entrega.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { parseSrt, toSrt } from "@/lib/delivery/youtube-package";
import type { ScriptLanguage } from "@/lib/providers/types";

export class LongFormSubtitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongFormSubtitleError";
  }
}

export type SubtitleCue = { startSeconds: number; endSeconds: number; text: string };

const ISO: Record<ScriptLanguage, string> = { es: "spa", en: "eng" };

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || ffmpegInstaller.path;
}
function ffprobeBin(): string {
  return process.env.FFPROBE_BIN || ffprobeInstaller.path;
}

function run(bin: string, args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 }));
  });
}

/** Número de pistas de subtítulos en el contenedor. `0` es el defecto observado. */
export async function subtitleTrackCount(filePath: string): Promise<number> {
  const { stdout, stderr, code } = await run(ffprobeBin(), ["-v", "error", "-select_streams", "s", "-show_entries", "stream=codec_type", "-of", "json", filePath]);
  if (code !== 0) throw new LongFormSubtitleError(`ffprobe no pudo leer ${path.basename(filePath)}: ${stderr.slice(-400)}`);
  const json = JSON.parse(stdout.toString("utf8")) as { streams?: unknown[] };
  return json.streams?.length ?? 0;
}

export function assertSubtitleTracks(tracks: number): void {
  if (tracks === 0) throw new LongFormSubtitleError("subtitle tracks: 0");
}

/**
 * Texto no vacío, tiempos monótonos (cada cue empieza cuando termina el
 * anterior, o después) y el final dentro de la duración del MP4.
 */
export function validateSubtitleCues(cues: SubtitleCue[], durationSeconds: number): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new LongFormSubtitleError("duración inválida");
  if (cues.length === 0) throw new LongFormSubtitleError("no hay subtítulos para muxar (subtitle tracks: 0)");
  let prevStart = -Infinity;
  let prevEnd = -Infinity;
  for (const [i, cue] of cues.entries()) {
    const text = cue.text?.trim() ?? "";
    const n = i + 1;
    if (!text) throw new LongFormSubtitleError(`subtítulo ${n} sin texto`);
    if (![cue.startSeconds, cue.endSeconds].every((v) => Number.isFinite(v))) throw new LongFormSubtitleError(`subtítulo ${n} con tiempo inválido`);
    if (cue.startSeconds < 0 || !(cue.endSeconds > cue.startSeconds)) throw new LongFormSubtitleError(`subtítulo ${n} no es un intervalo`);
    if (cue.startSeconds + 1e-3 < prevEnd || cue.startSeconds + 1e-6 < prevStart) throw new LongFormSubtitleError(`subtítulo ${n} no es monótono`);
    // ffprobe can report the container a frame shorter than the last caption clamped to the composition.
    if (cue.endSeconds > durationSeconds + 1 / 30) throw new LongFormSubtitleError(`subtítulo ${n} termina fuera de la duración (${cue.endSeconds} > ${durationSeconds})`);
    prevStart = cue.startSeconds;
    prevEnd = cue.endSeconds;
  }
}

/** SHA-256 del flujo elemental (video H.264 en Annex B, o audio AAC en ADTS). Null si esa pista no existe. */
export async function elementarySha256(filePath: string, kind: "v" | "a"): Promise<string | null> {
  const selector = kind === "v" ? "v" : "a";
  const listed = await run(ffprobeBin(), ["-v", "error", "-select_streams", selector, "-show_entries", "stream=index", "-of", "csv=p=0", filePath]);
  if (listed.code !== 0) throw new LongFormSubtitleError(`ffprobe: ${listed.stderr.slice(-300)}`);
  if (!listed.stdout.toString().trim()) return null;
  const args = kind === "v"
    ? ["-v", "error", "-i", filePath, "-map", "0:v:0", "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"]
    : ["-v", "error", "-i", filePath, "-map", "0:a:0", "-c", "copy", "-f", "adts", "-"];
  const dumped = await run(ffmpegBin(), args);
  if (dumped.code !== 0) throw new LongFormSubtitleError(`no se pudo copiar la pista ${kind}: ${dumped.stderr.slice(-400)}`);
  return createHash("sha256").update(dumped.stdout).digest("hex");
}

/** El demuxer SRT de algunos ffmpeg envuelve el texto mov_text en `<font>`. El sample del contenedor no lo trae. */
function plainCueText(text: string): string {
  const wrapped = text.trim().match(/^<font\b[^>]*>([\s\S]*)<\/font>$/);
  return (wrapped ? wrapped[1] : text).trim();
}

export async function readSubtitleCues(filePath: string): Promise<SubtitleCue[]> {
  const dumped = await run(ffmpegBin(), ["-v", "error", "-i", filePath, "-map", "0:s:0", "-f", "srt", "-"]);
  if (dumped.code !== 0) throw new LongFormSubtitleError(`no se pudo extraer la pista de subtítulos: ${dumped.stderr.slice(-400)}`);
  return parseSrt(dumped.stdout.toString("utf8")).map((c) => ({ startSeconds: c.start, endSeconds: c.end, text: plainCueText(c.text) }));
}

/**
 * Escribe el SRT y muxa una pista mov_text. No modifica `videoPath`.
 * Video y audio van con `-c copy`.
 */
export async function attachLongFormSubtitles(input: {
  videoPath: string;
  captions: { startSeconds: number; endSeconds: number; text: string }[];
  durationSeconds: number;
  language: ScriptLanguage;
}): Promise<{ videoPath: string; sidecarPath: string; directory: string; tracks: number }> {
  const cues: SubtitleCue[] = input.captions.map((c) => ({ startSeconds: c.startSeconds, endSeconds: c.endSeconds, text: c.text }));
  validateSubtitleCues(cues, input.durationSeconds);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-subs-"));
  try {
    const sidecarPath = path.join(directory, `subtitles.${input.language}.srt`);
    const videoPath = path.join(directory, "with-subtitles.mp4");
    const srt = toSrt(cues.map((c) => ({ start: c.startSeconds, end: c.endSeconds, text: c.text.trim() })));
    await fs.writeFile(sidecarPath, srt.endsWith("\n") ? srt : `${srt}\n`);
    const muxed = await run(ffmpegBin(), [
      "-y", "-v", "error",
      "-i", input.videoPath,
      "-i", sidecarPath,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-map", "1:0",
      "-c:v", "copy",
      "-c:a", "copy",
      "-c:s", "mov_text",
      "-metadata:s:s:0", `language=${ISO[input.language]}`,
      "-movflags", "+faststart",
      videoPath,
    ]);
    if (muxed.code !== 0) throw new LongFormSubtitleError(`no se pudo muxar la pista de subtítulos: ${muxed.stderr.slice(-500)}`);
    const tracks = await subtitleTrackCount(videoPath);
    assertSubtitleTracks(tracks);
    const readBack = await readSubtitleCues(videoPath);
    if (readBack.length !== cues.length) throw new LongFormSubtitleError("la pista muxada no tiene los mismos subtítulos que el sidecar");
    for (let i = 0; i < cues.length; i++) {
      if (readBack[i].text.trim() !== cues[i].text.trim()) throw new LongFormSubtitleError("el texto de la pista no coincide con el sidecar");
    }
    return { videoPath, sidecarPath, directory, tracks };
  } catch (err) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
