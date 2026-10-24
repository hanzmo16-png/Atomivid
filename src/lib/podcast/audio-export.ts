/**
 * Audio-only deliverables of a narrated episode (Travis Walton Ep. 2): the stored master is AAC in an
 * audio-only MP4 container (.m4a, audio/mp4). MP3 and WAV are derived locally with ffmpeg from that master:
 * no provider call, no video stream (-vn), no cost. Never re-synthesizes anything.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type AudioExportFormat = "mp3" | "wav";
export const AUDIO_EXPORT_MIME: Record<AudioExportFormat, string> = { mp3: "audio/mpeg", wav: "audio/wav" };

export async function exportAudioOnly(master: Buffer, format: AudioExportFormat): Promise<{ bytes: Buffer; mimeType: string; extension: AudioExportFormat }> {
  const dir = await mkdtemp(path.join(tmpdir(), "podcast-export-"));
  try {
    const src = path.join(dir, "master.m4a"), out = path.join(dir, `episode.${format}`);
    await writeFile(src, master);
    const codec = format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "192k"] : ["-c:a", "pcm_s16le"];
    await new Promise<void>((res, rej) => {
      const p = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-sn", "-dn", "-map", "0:a:0", ...codec, out]);
      let e = ""; p.stderr.on("data", (d) => { e += d; });
      p.on("error", rej); p.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${e.slice(-300)}`))));
    });
    return { bytes: await readFile(out), mimeType: AUDIO_EXPORT_MIME[format], extension: format };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
