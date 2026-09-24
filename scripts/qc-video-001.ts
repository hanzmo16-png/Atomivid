/**
 * QC obligatorio POST-RENDER para VIDEO #001 (Göbekli Tepe) — corre DESPUÉS
 * de que produce-long-form-video.ts ya escribió el .mp4 final y su
 * report.json. Reutiliza long-form-qc.ts (ffprobe + validación de
 * report.json + detección de silencios) sin duplicar lógica — este script
 * solo aplica las EXPECTATIVAS concretas de VIDEO #001 (1920x1080, 30fps,
 * 45/45 shots, mode=real, sin fixtures) y escribe un reporte QC propio
 * (qc-report.json) que se sube como artifact de GitHub Actions.
 *
 * FAIL CLOSED: cualquier verificación objetiva (resolución/fps/duración/
 * audio/mode/shotCount) que falle hace que este script salga con código
 * != 0 — el workflow NO debe marcar el run como exitoso si esto falla.
 * Los silencios detectados se REPORTAN siempre (nunca bloquean solos —
 * distinguir una pausa narrativa normal de una anomalía real requiere
 * revisión humana, que es el checkpoint siguiente ya acordado).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  probeVideoFile,
  evaluateVideoProbe,
  evaluateProductionReportForRealRun,
  detectAnomalousSilences,
  type ProductionReportForQc,
} from "../src/lib/video/long-form/long-form-qc";

const EXPECTED_SHOT_COUNT = 45;
const EXPECTED_WIDTH = 1920;
const EXPECTED_HEIGHT = 1080;
const EXPECTED_FPS = 30;

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  const mp4 = get("mp4");
  const report = get("report");
  if (!mp4 || !report) {
    throw new Error("Uso: qc-video-001.ts --mp4=<ruta.mp4> --report=<ruta.report.json> [--qc-output=<ruta.qc-report.json>]");
  }
  return { mp4, report, qcOutput: get("qc-output") ?? mp4.replace(/\.mp4$/, ".qc-report.json") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[qc-video-001] MP4="${args.mp4}" report="${args.report}"`);

  const reportRaw = JSON.parse(readFileSync(args.report, "utf8")) as ProductionReportForQc & {
    actualDurationSeconds: number;
    assetRegistry?: { provider: string; shotId: string; source: string }[];
  };

  const issues: { code: string; message: string }[] = [];

  const probe = await probeVideoFile(args.mp4);
  issues.push(
    ...evaluateVideoProbe(probe, {
      width: EXPECTED_WIDTH,
      height: EXPECTED_HEIGHT,
      fps: EXPECTED_FPS,
      expectedDurationSeconds: reportRaw.actualDurationSeconds,
      durationToleranceRatio: 0.05,
    }),
  );

  issues.push(...evaluateProductionReportForRealRun(reportRaw, EXPECTED_SHOT_COUNT));

  // Defensa adicional específica de VIDEO #001: ningún shot del registro
  // por-shot (ver produce-long-form-video.ts, assetRegistry) puede haber
  // usado un proveedor "fixture" en un run mode=real — el report.json base
  // ya lo comprueba a nivel global (isFixtureContent), esto lo confirma
  // también a nivel de cada asset individual.
  const fixtureAssets = (reportRaw.assetRegistry ?? []).filter((a) => a.provider.toLowerCase().includes("fixture"));
  if (fixtureAssets.length > 0) {
    issues.push({
      code: "fixture_assets_in_real_run",
      message: `${fixtureAssets.length} asset(s) usaron un proveedor fixture en un run mode=real: ${fixtureAssets.map((a) => a.shotId).join(", ")}`,
    });
  }

  let silences: Awaited<ReturnType<typeof detectAnomalousSilences>> = [];
  let silenceDetectionError: string | undefined;
  try {
    silences = await detectAnomalousSilences(args.mp4, 4);
  } catch (err) {
    silenceDetectionError = String(err);
  }

  const qcReport = {
    videoId: "gobekli-tepe-001",
    mp4Path: args.mp4,
    probe,
    expected: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, fps: EXPECTED_FPS, shotCount: EXPECTED_SHOT_COUNT },
    reportMode: reportRaw.mode,
    reportShotCount: reportRaw.shotCount,
    isFixtureContent: reportRaw.isFixtureContent,
    paidApisCalled: reportRaw.paidApisCalled,
    silences: silences.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, durationSeconds: s.durationSeconds })),
    silenceDetectionError,
    hardFailures: issues,
    passed: issues.length === 0,
  };

  await import("node:fs").then(({ mkdirSync }) => mkdirSync(path.dirname(args.qcOutput), { recursive: true }));
  writeFileSync(args.qcOutput, JSON.stringify(qcReport, null, 2));
  console.log(JSON.stringify(qcReport, null, 2));

  if (silences.length > 0) {
    console.warn(
      `[qc-video-001] ${silences.length} silencio(s) >=4s detectados — reportados en el QC, requieren revisión humana (no bloquean por sí solos, ver contact sheet/revisión del MP4).`,
    );
  }

  if (issues.length > 0) {
    console.error(`[qc-video-001] QC FALLÓ con ${issues.length} problema(s) objetivo(s) — ver qc-report.json.`);
    process.exit(1);
  }
  console.log("[qc-video-001] QC objetivo: PASA (resolución/fps/duración/audio/mode/shotCount/0-fixtures).");
}

main().catch((err) => {
  console.error("[qc-video-001] error inesperado:", err);
  process.exit(1);
});
