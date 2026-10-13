import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Storage-only compression of intermediate audio (voice / music) before it is uploaded next to the attempt.
 * Uncompressed WAV is re-encoded to MP3 at 192 kbps (same sample rate and channels); anything already
 * compressed (the real ElevenLabs voice and Beatoven music are MP3) is returned untouched — never re-encoded.
 * The render reads the uploaded file exactly as it reads the real MP3 voice today. Any encoder problem keeps
 * the original bytes: compression never fails a render.
 */
export type StoredAudio = { audioBuffer: Buffer; mimeType: string; extension: string; compressedFrom?: string };

const WAV_MIME = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
export const STORAGE_MP3_BITRATE = "192k";

export function isUncompressedWav(mimeType: string, extension: string): boolean {
  return WAV_MIME.has(mimeType.toLowerCase()) || extension.toLowerCase() === "wav";
}

export type Encoder = (input: Buffer) => Promise<Buffer>;

/** ffmpeg (PATH, or FFMPEG_BIN like audio-master.ts): WAV → MP3 CBR 192 kbps, no resampling, no channel change. */
export const ffmpegMp3Encoder: Encoder = async (input) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomivid-audio-"));
  try {
    const src = path.join(dir, "in.wav"), dst = path.join(dir, "out.mp3");
    await writeFile(src, input);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-codec:a", "libmp3lame", "-b:a", STORAGE_MP3_BITRATE, "-write_xing", "1", dst]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += String(d); });
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-500)}`))));
    });
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export async function compressAudioForStorage(
  audio: { audioBuffer: Buffer; mimeType: string; extension: string },
  encoder: Encoder = ffmpegMp3Encoder,
): Promise<StoredAudio> {
  if (!isUncompressedWav(audio.mimeType, audio.extension)) return audio;
  try {
    const mp3 = await encoder(audio.audioBuffer);
    if (mp3.byteLength === 0 || mp3.byteLength >= audio.audioBuffer.byteLength) return audio;
    return { audioBuffer: mp3, mimeType: "audio/mpeg", extension: "mp3", compressedFrom: audio.extension };
  } catch (err) {
    console.warn("[atomivid:audio-storage] compresión omitida, se guarda el original:", err instanceof Error ? err.message : err);
    return audio;
  }
}
