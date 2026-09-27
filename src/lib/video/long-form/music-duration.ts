import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffprobe from "@ffprobe-installer/ffprobe";

const run = promisify(execFile);

/** Library providers can report the requested video length instead of the source length. */
export async function measureMusicSourceSeconds(bytes: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "atomivid-music-duration-"));
  try {
    const file = join(dir, "audio");
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeout: 15000, maxBuffer: 4096 });
    const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] };
    const seconds = Number(info.format?.duration);
    if (!info.streams?.some(s => s.codec_type === "audio") || !Number.isFinite(seconds) || seconds <= 0.5) {
      throw new Error("Music source has no valid audio duration");
    }
    return seconds;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
