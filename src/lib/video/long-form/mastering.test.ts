import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOUDNESS_TARGET } from "../audio-master";
import { LONG_FORM_AUDIO_SAMPLE_RATE, masterLongFormAudio } from "./mastering";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const sampleRate = (file: string) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,codec_name", "-of", "csv=p=0", file]);
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout.toString().trim();
};

test(
  "Long Form (worker y CLI): el master sale en AAC a 48 kHz con loudness y pico real dentro del objetivo",
  { skip: !hasFfmpeg && "ffmpeg/ffprobe no están disponibles en este entorno" },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-lf-master-"));
    try {
      const input = path.join(dir, "in.mp4");
      // Tono suave a 48 kHz (como la narración fixture): loudnorm pasa a modo dinámico y remuestrea a 192 kHz;
      // sin -ar el AAC salía a 96 kHz (reproducido localmente con masterAudioLoudness sin opciones).
      const gen = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=30:d=6",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:d=6,volume=0.05,aformat=channel_layouts=stereo",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", input]);
      assert.equal(gen.status, 0, String(gen.stderr));
      const out = path.join(dir, "out.mp4");
      const result = await masterLongFormAudio(input, out);
      assert.equal(sampleRate(out), `aac,${LONG_FORM_AUDIO_SAMPLE_RATE}`);
      assert.ok(result.after.truePeakDbtp <= LOUDNESS_TARGET.TRUE_PEAK_DBTP, `pico real ${result.after.truePeakDbtp} dBTP`);
      assert.ok(Math.abs(result.after.integratedLufs - LOUDNESS_TARGET.INTEGRATED_LUFS) <= 2, `sonoridad ${result.after.integratedLufs} LUFS`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test("la CLI local usa la misma masterización que el worker (nunca masterAudioLoudness sin opciones)", async () => {
  const cli = await fs.readFile(path.join(process.cwd(), "scripts/produce-long-form-video.ts"), "utf8");
  const produce = await fs.readFile(path.join(process.cwd(), "src/lib/video/long-form/produce.ts"), "utf8");
  assert.match(cli, /masterLongFormAudio\(rawOutputPath, masteredPath\)/);
  assert.doesNotMatch(cli, /masterAudioLoudness\(/);
  assert.match(produce, /masterLongFormAudio\(rawOutputPath, masteredPath\)/);
  assert.doesNotMatch(produce, /masterAudioLoudness\(/);
});
