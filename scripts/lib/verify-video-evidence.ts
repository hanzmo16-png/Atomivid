import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

/** Fail the E2E run if the output cannot be decoded or lacks vertical video/audio. */
export async function verifyVideoEvidence(file: string) {
  const run = promisify(execFile);
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file,
  ]);
  const probe = JSON.parse(stdout) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const video = probe.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height || Math.abs(video.width / video.height - 9 / 16) > 0.001
      || !probe.streams.some((s) => s.codec_type === "audio")
      || !(Number(probe.format.duration) > 0)) {
    throw new Error("Evidencia inválida: se requiere video 9:16, audio y duración positiva.");
  }
  await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { timeout: 120_000 });
  await writeFile(`${file}.ffprobe.json`, stdout);
  console.log(`MP4 decodificado: ${video.width}x${video.height}, ${probe.format.duration}s, audio presente.`);
}
