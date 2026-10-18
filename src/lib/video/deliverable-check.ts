import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobe from "@ffprobe-installer/ffprobe";

/**
 * Control de costos (2026-10-18): a Reel/Avatar is «completed» only with a playable file. Before this, the
 * request was marked completed as soon as the upload returned without error (Long Form already verified
 * with ffprobe). This reads the local file that is about to be uploaded: it must have a video stream with
 * frames and a positive duration, and (when the narration length is known) last at least half of it.
 */
export class DeliverableUnverifiedError extends Error {
  readonly customerMessage = "El video se generó pero el archivo final no pasó la verificación, así que no se marcó como completado. Los pasos ya hechos se conservan y pueden haber tenido costo; no se repetirá ningún gasto sin revisión. Avisa a soporte.";
  readonly diagnosticId = "DELIVERABLE-UNVERIFIED";
  constructor(readonly reason: string) {
    super(`DELIVERABLE_UNVERIFIED:${reason}`);
    this.name = "DeliverableUnverifiedError";
  }
}

export type DeliverableProbe = { durationSeconds: number; width: number; height: number; videoCodec: string; hasAudio: boolean };

export async function verifyDeliverableMp4(path: string, opts: { minSeconds?: number; probe?: (path: string) => Promise<string> } = {}): Promise<DeliverableProbe> {
  const run = opts.probe ?? (async (p: string) => (await promisify(execFile)(ffprobe.path, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,nb_frames,duration", "-of", "json", p,
  ], { timeout: 20000, maxBuffer: 65536 })).stdout);
  let raw: string;
  try {
    raw = await run(path);
  } catch {
    throw new DeliverableUnverifiedError("probe failed");
  }
  let meta: { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; nb_frames?: string; duration?: string }[] };
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new DeliverableUnverifiedError("probe unreadable");
  }
  const video = meta.streams?.find(s => s.codec_type === "video");
  const duration = Number(meta.format?.duration ?? video?.duration);
  if (!video || !(Number(video.width) > 0) || !(Number(video.height) > 0)) throw new DeliverableUnverifiedError("no video stream");
  if (video.nb_frames !== undefined && video.nb_frames !== "N/A" && !(Number(video.nb_frames) > 0)) throw new DeliverableUnverifiedError("no frames");
  if (!Number.isFinite(duration) || !(duration > 0)) throw new DeliverableUnverifiedError("no duration");
  if (opts.minSeconds !== undefined && duration < opts.minSeconds) throw new DeliverableUnverifiedError("shorter than narration");
  return { durationSeconds: duration, width: Number(video.width), height: Number(video.height), videoCodec: video.codec_name ?? "unknown",
    hasAudio: Boolean(meta.streams?.some(s => s.codec_type === "audio")) };
}
