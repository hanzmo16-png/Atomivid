import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { validateMedia } from "./media";

const exec = promisify(execFile);

function wav(): Buffer {
  const sampleRate = 8000;
  const n = sampleRate;
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 2, 4); data.write("WAVE", 8); data.write("fmt ", 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 5000), 44 + i * 2);
  return data;
}

test("ffprobe mide un audio fixture y no aprueba sincronización labial", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ms-media-"));
  const file = path.join(dir, "flannan-fixture.wav");
  await writeFile(file, wav());
  const report = await validateMedia(file, { labeledFixture: true });
  assert.equal(report.exists, true);
  assert.equal(report.audioTracks, 1);
  assert.ok((report.durationSeconds ?? 0) > 0.5);
  assert.equal(report.lipSync.approved, false);
  assert.equal(report.lipSync.method, null);
  assert.equal(report.subjective, "no evaluado");
  assert.notEqual(report.technicalVerdict, "NO_MEDIDO");
  assert.equal(report.frameSample.extracted, false);
});

test("un archivo ilegible falla y no se presenta como silencio cero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ms-bad-"));
  const file = path.join(dir, "roto-fixture.mp3");
  await writeFile(file, Buffer.from("esto no es audio"));
  const report = await validateMedia(file, { labeledFixture: true });
  assert.equal(report.technicalVerdict, "FAIL");
  assert.ok(report.decodeErrors.length > 0);
});

test("un mp4 fixture tiene contenedor, códec, aspecto y un fotograma", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ms-mp4-"));
  const tone = path.join(dir, "tone.wav");
  const file = path.join(dir, "oceano-fixture.mp4");
  await writeFile(tone, wav());
  await exec(ffmpeg.path, ["-y", "-i", tone, "-f", "lavfi", "-i", "color=c=black:s=180x320:d=1:r=8", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file], { timeout: 30000 });
  const report = await validateMedia(file, { labeledFixture: true });
  assert.equal(report.videoCodec, "h264");
  assert.equal(report.aspect, "9:16");
  assert.equal(report.audioTracks, 1);
  assert.equal(report.frameSample.extracted, true);
  assert.ok(report.frameSample.bytes > 0);
  assert.equal(report.lipSync.approved, false);
});
