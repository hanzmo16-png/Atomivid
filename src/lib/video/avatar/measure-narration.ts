import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

/** Fail closed if audio cannot be measured. Never estimate from text here. */
export async function measureNarrationSeconds(bytes: Buffer): Promise<number> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-narration-"));
  try {
    const file = path.join(dir, "audio");
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { timeout: 15000, maxBuffer: 4096 });
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid audio duration");
    return seconds;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
