import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  detectBlackIntervals,
  evaluateBlackIntervals,
  assertNoLongBlackIntervals,
  parseBlackDetectOutput,
  BlackDetectFailedError,
  BLACK_DETECT_DEFAULTS,
  DEFAULT_MAX_BLACK_SECONDS,
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

// --- Tramos negros / casi negros (blackdetect, T-20261126-0415) ------------

/** MP4 real: segmentos lavfi concatenados (imagen visible / negro / casi negro), sin red ni proveedores. */
async function makeSegmentsVideo(dir: string, name: string, segments: { src: "testsrc" | "black" | "nearblack"; seconds: number }[]): Promise<string> {
  const outPath = join(dir, name);
  const args = ["-y"];
  for (const s of segments) {
    const src = s.src === "testsrc" ? "testsrc=" : `color=c=${s.src === "black" ? "black" : "0x0A0A0A"}:`;
    args.push("-f", "lavfi", "-i", `${src}size=320x240:rate=10:duration=${s.seconds}`);
  }
  const inputs = segments.map((_, i) => `[${i}:v]`).join("");
  args.push("-filter_complex", `${inputs}concat=n=${segments.length}:v=1:a=0[v]`, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", outPath, "-v", "error");
  await run(ffmpegInstaller.path, args, { timeout: 30000 });
  return outPath;
}

test("blackdetect: un video normal (imagen visible continua) no produce tramos ni dispara el gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-black-"));
  try {
    const file = await makeTestVideo(dir, { width: 320, height: 240, fps: 10, durationSeconds: 8 });
    const intervals = await detectBlackIntervals(file);
    assert.deepEqual(intervals, []);
    assert.deepEqual(evaluateBlackIntervals(intervals), []);
    await assert.doesNotReject(() => assertNoLongBlackIntervals(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blackdetect RED/GREEN: un tramo negro real de 4 s entre imágenes visibles se detecta con tiempos plausibles y bloquea", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-black-"));
  try {
    const file = await makeSegmentsVideo(dir, "black-mid.mp4", [{ src: "testsrc", seconds: 3 }, { src: "black", seconds: 4 }, { src: "testsrc", seconds: 3 }]);
    const intervals = await detectBlackIntervals(file);
    assert.equal(intervals.length, 1, JSON.stringify(intervals));
    const [b] = intervals;
    assert.ok(Math.abs(b.startSeconds - 3) <= 0.3, `inicio ${b.startSeconds}`);
    assert.ok(Math.abs(b.endSeconds - 7) <= 0.3, `fin ${b.endSeconds}`);
    assert.ok(Math.abs(b.durationSeconds - 4) <= 0.3, `duración ${b.durationSeconds}`);
    const issues = evaluateBlackIntervals(intervals);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "black_interval_too_long");
    assert.match(issues[0].message, /entre 3\.\d+s y [67]\.\d+s/);
    await assert.rejects(() => assertNoLongBlackIntervals(file), (err: unknown) => err instanceof LongFormQcFailedError && err.issues[0].code === "black_interval_too_long");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blackdetect: «casi negro» (luma ≈ 10/255) también cuenta; varios tramos salen ordenados; un fundido corto (1.5 s) no bloquea", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-black-"));
  try {
    const file = await makeSegmentsVideo(dir, "multi.mp4", [
      { src: "testsrc", seconds: 2 },
      { src: "nearblack", seconds: 3 },
      { src: "testsrc", seconds: 2 },
      { src: "black", seconds: 1.5 },
      { src: "testsrc", seconds: 2 },
    ]);
    const intervals = await detectBlackIntervals(file);
    assert.equal(intervals.length, 2, JSON.stringify(intervals));
    assert.ok(intervals[0].startSeconds < intervals[1].startSeconds, "ordenados por inicio");
    assert.ok(Math.abs(intervals[0].startSeconds - 2) <= 0.3 && Math.abs(intervals[0].durationSeconds - 3) <= 0.3, JSON.stringify(intervals[0]));
    assert.ok(Math.abs(intervals[1].startSeconds - 7) <= 0.3 && Math.abs(intervals[1].durationSeconds - 1.5) <= 0.3, JSON.stringify(intervals[1]));
    const issues = evaluateBlackIntervals(intervals);
    assert.equal(issues.length, 1, "solo el tramo de 3 s excede el máximo de 2 s");
    assert.match(issues[0].message, /entre 2\.\d+s/);
    assert.equal(evaluateBlackIntervals(intervals, 5).length, 0, "el máximo es explícito y configurable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blackdetect: un tramo negro al final del video también se reporta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-black-"));
  try {
    const file = await makeSegmentsVideo(dir, "black-tail.mp4", [{ src: "testsrc", seconds: 3 }, { src: "black", seconds: 4 }]);
    const issues = evaluateBlackIntervals(await detectBlackIntervals(file));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "black_interval_too_long");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blackdetect fail-closed: archivo inexistente, inválido, vacío o sin pista de video → rechazo explícito, nunca lista vacía", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-qc-black-"));
  try {
    await assert.rejects(() => detectBlackIntervals(join(dir, "no-existe.mp4")), BlackDetectFailedError);
    const bad = join(dir, "bad.mp4");
    writeFileSync(bad, "esto no es un mp4");
    await assert.rejects(() => detectBlackIntervals(bad), BlackDetectFailedError);
    const empty = join(dir, "empty.mp4");
    writeFileSync(empty, "");
    await assert.rejects(() => detectBlackIntervals(empty), BlackDetectFailedError);
    await assert.rejects(() => detectBlackIntervals(dir), BlackDetectFailedError, "un directorio no es un video");
    const audioOnly = join(dir, "audio.m4a");
    await run(ffmpegInstaller.path, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", audioOnly, "-v", "error"], { timeout: 30000 });
    await assert.rejects(() => detectBlackIntervals(audioOnly), BlackDetectFailedError);
    await assert.rejects(() => assertNoLongBlackIntervals(bad), BlackDetectFailedError, "el gate propaga el fallo, no aprueba");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blackdetect: parámetros fuera de rango se rechazan antes de invocar ffmpeg; salida malformada lanza", async () => {
  await assert.rejects(() => detectBlackIntervals("/x.mp4", { pixelThreshold: 2 }), RangeError);
  await assert.rejects(() => detectBlackIntervals("/x.mp4", { minDurationSeconds: 0 }), RangeError);
  await assert.rejects(() => detectBlackIntervals("/x.mp4", { pictureBlackRatio: Number.NaN }), RangeError);
  assert.throws(() => evaluateBlackIntervals([], -1), RangeError);
  assert.deepEqual(
    parseBlackDetectOutput("[blackdetect @ 0x1] black_start:9.5 black_end:12 black_duration:2.5\n[blackdetect @ 0x1] black_start:1 black_end:4 black_duration:3\n"),
    [{ startSeconds: 1, endSeconds: 4, durationSeconds: 3 }, { startSeconds: 9.5, endSeconds: 12, durationSeconds: 2.5 }],
  );
  assert.throws(() => parseBlackDetectOutput("[blackdetect @ 0x1] black_start:3 black_end:"), BlackDetectFailedError);
  assert.deepEqual(BLACK_DETECT_DEFAULTS, { minDurationSeconds: 1, pictureBlackRatio: 0.98, pixelThreshold: 0.1, timeoutMs: 600_000 });
  assert.equal(DEFAULT_MAX_BLACK_SECONDS, 2);
});
