import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { measureNarrationSeconds } from "./measure-narration";
const run = promisify(execFile);
/** Decode the entire recording to PCM WAV; never trim, synthesize or change speed. */
export async function heygenAudio(bytes: Buffer) {
  const seconds = await measureNarrationSeconds(bytes);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-heygen-audio-"));
  try {
    const source = path.join(dir, "source"); const target = path.join(dir, "audio.wav");
    await fs.writeFile(source, bytes, { mode: 0o600 });
    await run(ffmpeg.path, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", source, "-map", "0:a:0", "-c:a", "pcm_s16le", target], { timeout: 30000, maxBuffer: 4096 });
    const audioBuffer = await fs.readFile(target);
    const decodedSeconds = await measureNarrationSeconds(audioBuffer);
    // Container duration may differ by one compressed frame; no intentional trimming.
    if (Math.abs(decodedSeconds - seconds) > 0.1) throw new Error("Decoded recording duration changed");
    return { audioBuffer, extension: "wav", mimeType: "audio/wav" };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
