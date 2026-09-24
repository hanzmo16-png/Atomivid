import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  probeVideoFile,
  evaluateVideoProbe,
  assertVideoQc,
  LongFormQcFailedError,
  evaluateProductionReportForRealRun,
  assertProductionReportForRealRun,
  detectAnomalousSilences,
} from "./long-form-qc";

const run = promisify(execFile);

/** Genera un .mp4 real (testsrc + tono) con ffmpeg — mismo criterio del proyecto de probar contra ffprobe/ffmpeg reales, no mocks, para este tipo de verificación. */
async function makeTestVideo(dir: string, opts: { width: number; height: number; fps: number; durationSeconds: number; withAudio?: boolean }): Promise<string> {
  const outPath = join(dir, "test.mp4");
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${opts.width}x${opts.height}:rate=${opts.fps}:duration=${opts.durationSeconds}`,
  ];
  if (opts.withAudio ?? true) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${opts.durationSeconds}`, "-c:a", "aac");
  }
  args.push("-c:v", "libx264", "-shortest", outPath, "-v", "error");
  await run(ffmpegInstaller.path, args, { timeout: 30000 });
  return outPath;
}

async function makeSilentAudioVideo(dir: string, durationSeconds: number): Promise<string> {
  const outPath = join(dir, "silent.mp4");
  await run(
    ffmpegInstaller.path,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=10:duration=${durationSeconds}`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono",
      "-t",
      String(durationSeconds),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      outPath,
      "-v",
      "error",
    ],
    { timeout: 30000 },
  );
  return outPath;
}

test("probeVideoFile lee correctamente resolución/fps/duración/streams de un .mp4 real generado con ffmpeg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 1920, height: 1080, fps: 30, durationSeconds: 2 });
    const info = await probeVideoFile(file);
    assert.equal(info.hasVideoStream, true);
    assert.equal(info.hasAudioStream, true);
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.ok(Math.abs(info.fps - 30) < 0.1);
    assert.ok(Math.abs(info.durationSeconds - 2) < 0.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeVideoFile lanza (no devuelve datos falsos) si el archivo no existe/es ilegible", async () => {
  await assert.rejects(() => probeVideoFile("/no/existe/nunca.mp4"));
});

test("evaluateVideoProbe no reporta problemas cuando el archivo real cumple las expectativas de Long Form (1920x1080/30fps)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 1920, height: 1080, fps: 30, durationSeconds: 2 });
    const info = await probeVideoFile(file);
    const issues = evaluateVideoProbe(info, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 2 });
    assert.deepEqual(issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateVideoProbe detecta resolution_mismatch y fps_mismatch contra un archivo real con otras dimensiones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 1280, height: 720, fps: 24, durationSeconds: 2 });
    const info = await probeVideoFile(file);
    const issues = evaluateVideoProbe(info, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 2 });
    assert.ok(issues.some((i) => i.code === "resolution_mismatch"));
    assert.ok(issues.some((i) => i.code === "fps_mismatch"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateVideoProbe detecta duration_out_of_tolerance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 1920, height: 1080, fps: 30, durationSeconds: 2 });
    const info = await probeVideoFile(file);
    const issues = evaluateVideoProbe(info, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 10 });
    assert.ok(issues.some((i) => i.code === "duration_out_of_tolerance"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateVideoProbe detecta no_audio_stream contra un archivo real sin audio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 1920, height: 1080, fps: 30, durationSeconds: 2, withAudio: false });
    const info = await probeVideoFile(file);
    const issues = evaluateVideoProbe(info, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 2 });
    assert.ok(issues.some((i) => i.code === "no_audio_stream"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertVideoQc lanza LongFormQcFailedError contra un archivo real que no cumple, y no lanza contra uno que sí cumple", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const good = await makeTestVideo(dir, { width: 1920, height: 1080, fps: 30, durationSeconds: 2 });
    await assert.doesNotReject(() => assertVideoQc(good, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 2 }));

    const bad = await makeTestVideo(join(dir), { width: 640, height: 480, fps: 25, durationSeconds: 2 });
    await assert.rejects(() => assertVideoQc(bad, { width: 1920, height: 1080, fps: 30, expectedDurationSeconds: 2 }), LongFormQcFailedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateProductionReportForRealRun no reporta problemas para un reporte real válido", () => {
  const issues = evaluateProductionReportForRealRun(
    { mode: "real", isFixtureContent: false, paidApisCalled: true, shotCount: 45 },
    45,
  );
  assert.deepEqual(issues, []);
});

test("evaluateProductionReportForRealRun detecta mode=simulation, isFixtureContent, paidApisCalled=false, y shotCount incorrecto, TODOS a la vez", () => {
  const issues = evaluateProductionReportForRealRun(
    { mode: "simulation", isFixtureContent: true, paidApisCalled: false, shotCount: 10 },
    45,
  );
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("not_real_mode"));
  assert.ok(codes.includes("fixture_content"));
  assert.ok(codes.includes("no_paid_apis_called"));
  assert.ok(codes.includes("shot_count_mismatch"));
});

test("assertProductionReportForRealRun lanza LongFormQcFailedError para un reporte inválido", () => {
  assert.throws(
    () => assertProductionReportForRealRun({ mode: "simulation", isFixtureContent: true, paidApisCalled: false, shotCount: 1 }, 45),
    LongFormQcFailedError,
  );
});

test("detectAnomalousSilences detecta un silencio real de 5s generado con ffmpeg (audio silencioso real, no mockeado)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeSilentAudioVideo(dir, 5);
    const silences = await detectAnomalousSilences(file, 3);
    assert.ok(silences.length >= 1);
    assert.ok(silences[0].durationSeconds >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectAnomalousSilences no reporta nada para un audio real con tono constante (sin silencios largos)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-test-"));
  try {
    const file = await makeTestVideo(dir, { width: 320, height: 240, fps: 10, durationSeconds: 4 });
    const silences = await detectAnomalousSilences(file, 3);
    assert.deepEqual(silences, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
