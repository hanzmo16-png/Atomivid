import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import path from "node:path";

const run = promisify(execFile);

/** Fail closed if audio cannot be measured. Never estimate from text here. */
export async function measureNarrationSeconds(bytes: Buffer): Promise<number> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-narration-"));
  try {
    const file = path.join(dir, "audio");
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeout: 15000, maxBuffer: 4096 });
    const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] };
    if (!info.streams?.some(s => s.codec_type === "audio") || info.streams.some(s => s.codec_type === "video")) throw new Error("Expected audio-only recording");
    const seconds = Number(info.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid audio duration");
    await run(ffmpeg.path, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", file, "-map", "0:a:0", "-f", "null", "-"], { timeout: 20000, maxBuffer: 4096 });
    return seconds;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
