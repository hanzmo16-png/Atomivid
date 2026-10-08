/**
 * Own recorded voice (no cloning): the file is uploaded with a one-time signed URL, then the server
 * checks the real container from its bytes, decodes it fully (audio only, valid duration) and masters it
 * with the same loudness target as the synthetic narration.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { masterAudioLoudness, type LoudnessMeasurement } from "@/lib/video/audio-master";

export const RECORDING_MAX_BYTES = 150 * 1024 * 1024;
export const RECORDING_MAX_SECONDS = 2 * 3600;
export const RECORDING_MIME = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg"] as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const recordingUploadPath = (userId: string, episodeId: string) => `${userId}/podcasts/${episodeId}/uploads/${randomUUID()}`;
export function isRecordingPathFor(userId: string, episodeId: string, p: string): boolean {
  const safe = (s: string) => s.replace(/[^0-9a-f-]/gi, "");
  return new RegExp(`^${safe(userId)}/podcasts/${safe(episodeId)}/uploads/${UUID}$`).test(p);
}

/** Container from the bytes (the declared MIME is ignored). */
export function sniffAudio(buf: Buffer): "mp3" | "m4a" | "wav" | "webm" | "ogg" | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  if (buf.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (buf.toString("ascii", 0, 4) === "OggS") return "ogg";
  return null;
}

export type MasteredRecording = { bytes: Buffer; sha256: string; durationSeconds: number; loudness: LoudnessMeasurement };

export async function masterRecording(buf: Buffer, measureSeconds: (b: Buffer) => Promise<number>): Promise<MasteredRecording | { error: string }> {
  if (buf.length === 0) return { error: "archivo vacío" };
  if (buf.length > RECORDING_MAX_BYTES) return { error: `el archivo supera ${RECORDING_MAX_BYTES / 1024 / 1024} MB` };
  const kind = sniffAudio(buf);
  if (!kind) return { error: "no es un audio MP3, M4A, WAV, WebM u Ogg" };
  let seconds: number;
  try { seconds = await measureSeconds(buf); } catch { return { error: "el audio no se pudo leer completo (o contiene video)" }; }
  if (seconds > RECORDING_MAX_SECONDS) return { error: "la grabación supera 2 horas" };
  const dir = await mkdtemp(path.join(tmpdir(), "podcast-rec-"));
  try {
    const input = path.join(dir, `in.${kind}`), out = path.join(dir, "episode.m4a");
    await writeFile(input, buf);
    const m = await masterAudioLoudness(input, out, { truePeakMarginDb: 1, faststart: true });
    const bytes = await readFile(out);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), durationSeconds: seconds, loudness: m.after };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
