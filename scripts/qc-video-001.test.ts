/**
 * QC post-render de VIDEO #001 como PROCESO HIJO real (T-20261126-0522): el gate `blackdetect` debe impedir que un MP4
 * con un tramo negro/casi negro largo produzca un qc-report aprobado o termine con código 0. Fixtures MP4 reales
 * generados con el ffmpeg empaquetado; reportes temporales válidos. Sin red, proveedores ni secretos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const run = promisify(execFile);
const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts", "qc-video-001.ts");
const dir = mkdtempSync(join(tmpdir(), "qc-video-001-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

type Seg = { src: "testsrc" | "black"; seconds: number };
async function mp4(name: string, segs: Seg[], size = "1920x1080"): Promise<string> {
  const out = join(dir, name);
  const total = segs.reduce((a, s) => a + s.seconds, 0);
  const args = ["-y"];
  for (const s of segs) args.push("-f", "lavfi", "-i", `${s.src === "testsrc" ? "testsrc=" : "color=c=black:"}size=${size}:rate=30:duration=${s.seconds}`);
  args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${total}`);
  args.push("-filter_complex", `${segs.map((_, i) => `[${i}:v]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`, "-map", "[v]", "-map", `${segs.length}:a`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out, "-v", "error");
  await run(ffmpegInstaller.path, args, { timeout: 120000 });
  return out;
}

function report(name: string, actualDurationSeconds: number): string {
  const p = join(dir, `${name}.report.json`);
  writeFileSync(p, JSON.stringify({ mode: "real", isFixtureContent: false, paidApisCalled: true, shotCount: 45, actualDurationSeconds, assetRegistry: [] }));
  return p;
}

type QcReport = {
  passed: boolean;
  hardFailures: { code: string; message: string }[];
  blackDetect?: { maxAllowedSeconds: number; params: Record<string, number>; intervals: { startSeconds: number; endSeconds: number; durationSeconds: number }[]; error?: string };
};
function qc(mp4Path: string, reportPath: string, name: string): { status: number | null; out: string; qc?: QcReport } {
  const qcOutput = join(dir, `${name}.qc-report.json`);
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, `--mp4=${mp4Path}`, `--report=${reportPath}`, `--qc-output=${qcOutput}`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, qc: existsSync(qcOutput) ? (JSON.parse(readFileSync(qcOutput, "utf8")) as QcReport) : undefined };
}

test("MP4 visible (1920x1080/30fps, con audio): código 0, passed:true, blackdetect registrado sin intervalos", async () => {
  const file = await mp4("visible.mp4", [{ src: "testsrc", seconds: 10 }]);
  const r = qc(file, report("visible", 10), "visible");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.qc?.passed, true, r.out);
  assert.deepEqual(r.qc?.hardFailures, []);
  assert.ok(r.qc?.blackDetect, "el reporte registra la evaluación blackdetect");
  assert.deepEqual(r.qc.blackDetect.intervals, []);
  assert.equal(r.qc.blackDetect.maxAllowedSeconds, 2);
  assert.deepEqual(r.qc.blackDetect.params, { minDurationSeconds: 1, pictureBlackRatio: 0.98, pixelThreshold: 0.1, timeoutMs: 600000 });
  assert.equal(r.qc.blackDetect.error, undefined);
});

test("RED/GREEN: tramo negro real de 4 s (3–7 s) → código ≠ 0, passed:false, black_interval_too_long e intervalo plausible", async () => {
  const file = await mp4("negro.mp4", [{ src: "testsrc", seconds: 3 }, { src: "black", seconds: 4 }, { src: "testsrc", seconds: 3 }]);
  const r = qc(file, report("negro", 10), "negro");
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.qc, "se escribe el reporte de evidencia aunque falle");
  assert.equal(r.qc.passed, false);
  const hit = r.qc.hardFailures.filter((f) => f.code === "black_interval_too_long");
  assert.equal(hit.length, 1, JSON.stringify(r.qc.hardFailures));
  assert.equal(r.qc.hardFailures.length, 1, "ningún otro criterio cambia: solo falla el tramo negro");
  const iv = r.qc.blackDetect?.intervals ?? [];
  assert.equal(iv.length, 1, JSON.stringify(iv));
  assert.ok(Math.abs(iv[0].startSeconds - 3) <= 0.3 && Math.abs(iv[0].endSeconds - 7) <= 0.3 && Math.abs(iv[0].durationSeconds - 4) <= 0.3, JSON.stringify(iv[0]));
});

test("detección fallida (MP4 sin pista de video): hard failure black_detect_failed, nunca «cero intervalos», código ≠ 0", async () => {
  const audioOnly = join(dir, "solo-audio.mp4");
  await run(ffmpegInstaller.path, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "aac", audioOnly, "-v", "error"], { timeout: 30000 });
  const r = qc(audioOnly, report("solo-audio", 4), "solo-audio");
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.qc);
  assert.equal(r.qc.passed, false);
  assert.ok(r.qc.hardFailures.some((f) => f.code === "black_detect_failed"), JSON.stringify(r.qc.hardFailures));
  assert.ok(r.qc.hardFailures.some((f) => f.code === "no_video_stream"), "el criterio existente sigue presente");
  assert.match(r.qc.blackDetect?.error ?? "", /blackdetect no pudo evaluar/);
  assert.deepEqual(r.qc.blackDetect?.intervals, [], "sin intervalos porque no se pudo analizar, y queda marcado como error");
});

test("MP4 inválido: código ≠ 0 y nunca un qc-report aprobado", () => {
  const bad = join(dir, "invalido.mp4");
  writeFileSync(bad, "esto no es un mp4");
  const r = qc(bad, report("invalido", 10), "invalido");
  assert.notEqual(r.status, 0, r.out);
  assert.notEqual(r.qc?.passed, true);
});

test("criterios existentes intactos: 1280x720 visible sigue fallando por resolution_mismatch aunque no haya negro", async () => {
  const file = await mp4("720p.mp4", [{ src: "testsrc", seconds: 4 }], "1280x720");
  const r = qc(file, report("720p", 4), "720p");
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(r.qc?.hardFailures.map((f) => f.code), ["resolution_mismatch"]);
});
