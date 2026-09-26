/** Dependencias reales del worker de «Mi voz» (servicio, ElevenLabs, ffmpeg). */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServiceClient } from "@/lib/supabase/service";
import { getVoiceProvider } from "@/lib/providers/voice";
import { addInstantVoiceClone, getVoiceCloneSlots } from "@/lib/ai/voice";
import { probeDurationSeconds } from "@/lib/tts/concat";
import { runVoiceCloneJob } from "./clone-job";

/** Cualquier formato admitido → MP3 mono 44,1 kHz 128 kbps, y su duración medida. */
export async function prepareSampleWithFfmpeg(audio: Buffer, extension: string): Promise<{ audio: Buffer; durationSeconds: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "atomivid-voice-"));
  try {
    const input = path.join(dir, `in.${extension.replace(/[^a-z0-9]/gi, "") || "bin"}`);
    const output = path.join(dir, "sample.mp3");
    await writeFile(input, audio);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", output]);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-800)}`))));
    });
    return { audio: await readFile(output), durationSeconds: await probeDurationSeconds(output) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function runVoiceCloneJobWithDefaults(voiceId: string) {
  return runVoiceCloneJob(voiceId, {
    service: createServiceClient(),
    voiceProvider: getVoiceProvider(),
    prepareSample: prepareSampleWithFfmpeg,
    slots: getVoiceCloneSlots,
    clone: addInstantVoiceClone,
  });
}
