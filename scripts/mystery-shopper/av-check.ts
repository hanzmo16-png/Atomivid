/**
 * Mystery Shopper 3.0 — medición de un MP4 entregado (USD 0, local): ffprobe (pistas, duraciones, inicio, tamaño),
 * ffmpeg decodificando TODO el archivo (corrupción), volumedetect y silencedetect. Las funciones de parseo son puras
 * para poder probarlas sin ffmpeg.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AvFacts } from "../../src/lib/mystery-shopper/v3/detect";

const run = promisify(execFile);
const num = (v: unknown): number | null => { const n = Number(v); return v === undefined || v === null || v === "" || v === "N/A" || !Number.isFinite(n) ? null : n; };

export type VideoMeasure = AvFacts & {
  container: string | null; durationSeconds: number | null; sizeBytes: number | null;
  decodeOk: boolean; decodeErrors: string[]; meanVolumeDb: number | null; maxSilenceSeconds: number | null;
};

/** Parseo de `ffprobe -show_streams -show_format -of json`. */
export function parseProbe(file: string, json: string): Pick<VideoMeasure, "file" | "video" | "audio" | "container" | "durationSeconds" | "sizeBytes"> {
  const j = JSON.parse(json) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && (s.disposition as { attached_pic?: number } | undefined)?.attached_pic !== 1);
  const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
  const f = j.format ?? {};
  return {
    file: path.basename(file),
    container: typeof f.format_name === "string" ? f.format_name : null,
    durationSeconds: num(f.duration),
    sizeBytes: num(f.size),
    video: v ? { codec: String(v.codec_name ?? "") || null, durationSeconds: num(v.duration) ?? num(f.duration), startSeconds: num(v.start_time), frames: num(v.nb_frames), width: num(v.width), height: num(v.height) } : null,
    audio: a ? { codec: String(a.codec_name ?? "") || null, durationSeconds: num(a.duration) ?? num(f.duration), startSeconds: num(a.start_time), channels: num(a.channels) } : null,
  };
}

/** Parseo del stderr de ffmpeg con volumedetect + silencedetect; errores de decodificación = líneas que no son de esos filtros. */
export function parseDecode(stderr: string): Pick<VideoMeasure, "decodeOk" | "decodeErrors" | "meanVolumeDb" | "maxSilenceSeconds"> {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  const silences = [...stderr.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const errors = lines.filter((l) => !/Parsed_(volumedetect|silencedetect)|^\s*\[(volumedetect|silencedetect)|silence_(start|end|duration)|mean_volume|max_volume|histogram_|n_samples/.test(l)).filter((l) => /error|invalid|corrupt|missing|non-existing|decode/i.test(l));
  return { decodeOk: errors.length === 0, decodeErrors: errors.slice(0, 10), meanVolumeDb: mean ? Number(mean[1]) : null, maxSilenceSeconds: silences.length ? Math.max(...silences) : 0 };
}

export async function measureVideo(file: string, bins: { ffprobe?: string; ffmpeg?: string } = {}): Promise<VideoMeasure> {
  const ffprobe = bins.ffprobe || "ffprobe", ffmpeg = bins.ffmpeg || "ffmpeg";
  let probe: ReturnType<typeof parseProbe> = { file: path.basename(file), video: null, audio: null, container: null, durationSeconds: null, sizeBytes: null };
  try { probe = parseProbe(file, (await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { maxBuffer: 1 << 24 })).stdout); }
  catch (e) { return { ...probe, decodeOk: false, decodeErrors: [e instanceof Error ? e.message.slice(0, 300) : String(e)], meanVolumeDb: null, maxSilenceSeconds: null }; }
  const dec = await run(ffmpeg, ["-hide_banner", "-nostats", "-v", "error", "-i", file, "-map", "0:v:0?", "-map", "0:a:0?", "-af", "volumedetect,silencedetect=n=-50dB:d=1", "-f", "null", "-"], { maxBuffer: 1 << 26 })
    .then((r) => r.stderr, (e: { stderr?: string; message?: string }) => `${e.stderr ?? ""}\nerror: ${e.message ?? "ffmpeg falló"}`);
  // -v error oculta los informes de los filtros: se repite solo el audio con nivel info para leerlos.
  const lv = probe.audio ? await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect,silencedetect=n=-50dB:d=1", "-f", "null", "-"], { maxBuffer: 1 << 26 }).then((r) => r.stderr, () => "") : "";
  const d = parseDecode(dec), l = parseDecode(lv);
  return { ...probe, decodeOk: d.decodeOk, decodeErrors: d.decodeErrors, meanVolumeDb: l.meanVolumeDb, maxSilenceSeconds: probe.audio ? l.maxSilenceSeconds : null };
}
