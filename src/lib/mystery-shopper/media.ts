/**
 * Validación audiovisual local con ffprobe y ffmpeg. USD 0.
 * Separa lo medido de lo subjetivo. La sincronización labial no se aprueba: no hay método medible aquí.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import type { MediaReport } from "./types";

const run = promisify(execFile);

type ProbeJson = {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; channels?: number }[];
};

const LIPSYNC_REASON = "No hay un método medible de sincronización labial en Mystery Shopper 1.0. No se aprueba.";

function aspectOf(w: number | null, h: number | null): string | null {
  if (!w || !h) return null;
  const r = w / h;
  if (Math.abs(r - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(r - 9 / 16) < 0.05) return "9:16";
  if (Math.abs(r - 1) < 0.05) return "1:1";
  return `${w}:${h}`;
}

function fpsOf(raw: string | undefined): number | null {
  if (!raw || !raw.includes("/")) return null;
  const [a, b] = raw.split("/").map(Number);
  if (!b || !Number.isFinite(a)) return null;
  return Math.round((a / b) * 100) / 100;
}

function pairs(text: string, startKey: string, endKey: string): [number, number][] {
  const starts = [...text.matchAll(new RegExp(`${startKey}:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
  const ends = [...text.matchAll(new RegExp(`${endKey}:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
  return starts.map((s, i) => [s, ends[i] ?? s] as [number, number]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

export async function validateMedia(filePath: string, opts: { labeledFixture?: boolean } = {}): Promise<MediaReport> {
  const base: MediaReport = {
    path: filePath,
    labeledFixture: Boolean(opts.labeledFixture),
    exists: false,
    container: null,
    videoCodec: null,
    audioCodec: null,
    durationSeconds: null,
    width: null,
    height: null,
    aspect: null,
    fps: null,
    audioTracks: 0,
    silenceRanges: [],
    blackRanges: [],
    meanVolumeDb: null,
    maxVolumeDb: null,
    decodeErrors: [],
    frameSample: { extracted: false, bytes: 0, reason: null },
    lipSync: { approved: false, method: null, reason: LIPSYNC_REASON },
    technicalVerdict: "NO_MEDIDO",
    technicalNotes: [],
    subjective: "no evaluado",
  };
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) {
      base.decodeErrors.push("El archivo no existe o está vacío.");
      base.technicalVerdict = "FAIL";
      return base;
    }
    base.exists = true;
  } catch {
    base.decodeErrors.push("El archivo no existe.");
    base.technicalVerdict = "FAIL";
    return base;
  }

  let probe: ProbeJson;
  try {
    const { stdout } = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,channels", "-of", "json", filePath], { timeout: 20000, maxBuffer: 1_000_000, encoding: "utf8" });
    probe = JSON.parse(stdout) as ProbeJson;
  } catch (e) {
    base.decodeErrors.push(e instanceof Error ? e.message.slice(0, 200) : "ffprobe falló");
    base.technicalVerdict = "FAIL";
    return base;
  }

  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  base.container = probe.format?.format_name ?? null;
  base.videoCodec = video?.codec_name ?? null;
  base.audioCodec = audios[0]?.codec_name ?? null;
  base.audioTracks = audios.length;
  const duration = Number(probe.format?.duration);
  base.durationSeconds = Number.isFinite(duration) ? duration : null;
  base.width = video?.width ?? null;
  base.height = video?.height ?? null;
  base.aspect = aspectOf(base.width, base.height);
  base.fps = fpsOf(video?.avg_frame_rate);

  try {
    await run(ffmpeg.path, ["-v", "error", "-xerror", "-i", filePath, "-f", "null", "-"], { timeout: 30000, maxBuffer: 1_000_000, encoding: "utf8" });
  } catch (e) {
    base.decodeErrors.push(e instanceof Error ? e.message.slice(0, 200) : "la decodificación falló");
  }

  if (audios.length) {
    try {
      const { stderr } = await run(ffmpeg.path, ["-i", filePath, "-af", "silencedetect=n=-50dB:d=0.4,volumedetect", "-f", "null", "-"], { timeout: 30000, maxBuffer: 1_000_000, encoding: "utf8" });
      const log = stderr ?? "";
      base.silenceRanges = pairs(log, "silence_start", "silence_end");
      const mean = log.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
      const max = log.match(/max_volume:\s*(-?[0-9.]+)\s*dB/);
      base.meanVolumeDb = mean ? Number(mean[1]) : null;
      base.maxVolumeDb = max ? Number(max[1]) : null;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      const log = err.stderr ?? "";
      if (log.includes("silence_") || log.includes("mean_volume")) {
        base.silenceRanges = pairs(log, "silence_start", "silence_end");
        const mean = log.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
        const max = log.match(/max_volume:\s*(-?[0-9.]+)\s*dB/);
        base.meanVolumeDb = mean ? Number(mean[1]) : null;
        base.maxVolumeDb = max ? Number(max[1]) : null;
      } else {
        base.technicalNotes.push("No se pudo medir silencio o volumen.");
      }
    }
  }

  if (video) {
    try {
      const { stderr } = await run(ffmpeg.path, ["-i", filePath, "-vf", "blackdetect=d=0.2:pix_th=0.10", "-an", "-f", "null", "-"], { timeout: 30000, maxBuffer: 1_000_000, encoding: "utf8" });
      base.blackRanges = pairs(stderr ?? "", "black_start", "black_end");
    } catch (e) {
      const log = (e as { stderr?: string }).stderr ?? "";
      if (log.includes("black_")) base.blackRanges = pairs(log, "black_start", "black_end");
      else base.technicalNotes.push("No se pudo medir fotogramas negros.");
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "ms-frame-"));
    const frame = path.join(dir, "frame.png");
    try {
      await run(ffmpeg.path, ["-y", "-ss", "0.1", "-i", filePath, "-frames:v", "1", frame], { timeout: 20000, encoding: "utf8" });
      const st = await stat(frame);
      base.frameSample = { extracted: st.size > 0, bytes: st.size, reason: st.size > 0 ? null : "el fotograma salió vacío" };
    } catch (e) {
      base.frameSample = { extracted: false, bytes: 0, reason: e instanceof Error ? e.message.slice(0, 160) : "no se pudo extraer un fotograma" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    base.frameSample = { extracted: false, bytes: 0, reason: "no aplica: el archivo no tiene video" };
  }

  if (!opts.labeledFixture) base.technicalNotes.push("El archivo no está marcado como fixture.");
  if (base.durationSeconds === null) base.technicalNotes.push("La duración no se pudo leer.");
  if (base.audioTracks === 0) base.technicalNotes.push("No hay pista de audio.");
  if (base.decodeErrors.length) base.technicalNotes.push("Hay errores de decodificación.");
  if (base.maxVolumeDb !== null && base.maxVolumeDb >= -0.1) base.technicalNotes.push("El pico de volumen está en el límite.");

  const hard = base.decodeErrors.length > 0 || !base.exists || base.durationSeconds === null || (video ? base.width === null : base.audioTracks === 0);
  base.technicalVerdict = hard ? "FAIL" : base.technicalNotes.length ? "PASS_WITH_WARNINGS" : "PASS";
  return base;
}
