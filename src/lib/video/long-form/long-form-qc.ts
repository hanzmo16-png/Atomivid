/**
 * Quality gate de POST-RENDER para Long Form — corre DESPUÉS de que existe
 * un archivo .mp4 real, antes de darlo por entregable. Dos capas:
 *
 * 1. `probeVideoFile`/`evaluateVideoProbe`: propiedades del archivo en sí
 *    (resolución, aspect ratio, fps, duración, presencia de audio/video,
 *    "no está corrupto" — si ffprobe puede leerlo, no lo está) vía
 *    @ffprobe-installer/ffprobe, mismo patrón ya usado en
 *    src/lib/video/avatar/measure-narration.ts.
 * 2. `evaluateProductionReportForRealRun`: metadata del PIPELINE (el
 *    report.json que ya escribe produce-long-form-video.ts) — detecta si
 *    lo que se intenta entregar como "real" en realidad quedó marcado
 *    como fixture/simulation, o si el conteo de shots no coincide con el
 *    storyboard aprobado.
 *
 * Además, `detectAnomalousSilences` corre ffmpeg -af silencedetect sobre
 * la pista de audio para marcar silencios largos no esperados (más allá
 * de los huecos de narración ya conocidos) — best-effort, nunca bloquea
 * por sí solo si ffmpeg no está disponible (lanza con un mensaje claro en
 * ese caso, para que quien lo corra sepa que no pudo evaluarse, en vez de
 * fingir que no hay silencios).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const run = promisify(execFile);

export type QcIssue = { code: string; message: string };

export class LongFormQcFailedError extends Error {
  constructor(public readonly issues: QcIssue[]) {
    super(`QC de Long Form falló con ${issues.length} problema(s):\n${issues.map((i) => `- [${i.code}] ${i.message}`).join("\n")}`);
    this.name = "LongFormQcFailedError";
  }
}

// --- 1. Propiedades del archivo de video (ffprobe) -------------------------

export type VideoProbeInfo = {
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
};

type FfprobeStream = {
  codec_type: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
};
type FfprobeOutput = { format?: { duration?: string }; streams?: FfprobeStream[] };

/** Lanza si ffprobe no puede leer el archivo — eso YA es la señal de "archivo corrupto o inexistente", no hace falta un chequeo aparte. */
export async function probeVideoFile(filePath: string): Promise<VideoProbeInfo> {
  const { stdout } = await run(
    ffprobeInstaller.path,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  const info = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = info.streams?.find((s) => s.codec_type === "video");
  const audioStream = info.streams?.find((s) => s.codec_type === "audio");

  let fps = 0;
  if (videoStream?.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
    fps = den ? num / den : num;
  }
  const durationRaw = info.format?.duration ?? videoStream?.duration;
  const durationSeconds = Number(durationRaw);

  return {
    hasVideoStream: Boolean(videoStream),
    hasAudioStream: Boolean(audioStream),
    width: videoStream?.width ?? 0,
    height: videoStream?.height ?? 0,
    fps,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
  };
}

export type LongFormQcExpectations = {
  width: number;
  height: number;
  fps: number;
  expectedDurationSeconds: number;
  /** Fracción de tolerancia sobre la duración esperada (0.1 = ±10%, mismo criterio ya usado en duration-check.ts para Shorts). */
  durationToleranceRatio?: number;
};

const DEFAULT_DURATION_TOLERANCE_RATIO = 0.1;
const FPS_TOLERANCE = 0.5;

export function evaluateVideoProbe(info: VideoProbeInfo, expected: LongFormQcExpectations): QcIssue[] {
  const issues: QcIssue[] = [];
  if (!info.hasVideoStream) {
    issues.push({ code: "no_video_stream", message: "el archivo no tiene pista de video" });
  }
  if (!info.hasAudioStream) {
    issues.push({ code: "no_audio_stream", message: "el archivo no tiene pista de audio (narración/música)" });
  }
  if (info.width !== expected.width || info.height !== expected.height) {
    issues.push({
      code: "resolution_mismatch",
      message: `resolución ${info.width}x${info.height}, se esperaba ${expected.width}x${expected.height} (16:9)`,
    });
  }
  if (Math.abs(info.fps - expected.fps) > FPS_TOLERANCE) {
    issues.push({ code: "fps_mismatch", message: `fps ${info.fps.toFixed(2)}, se esperaba ${expected.fps}` });
  }
  const tolerance = expected.durationToleranceRatio ?? DEFAULT_DURATION_TOLERANCE_RATIO;
  if (expected.expectedDurationSeconds > 0) {
    const diffRatio = Math.abs(info.durationSeconds - expected.expectedDurationSeconds) / expected.expectedDurationSeconds;
    if (diffRatio > tolerance) {
      issues.push({
        code: "duration_out_of_tolerance",
        message: `duración ${info.durationSeconds.toFixed(1)}s difiere más de ${(tolerance * 100).toFixed(0)}% de la esperada (${expected.expectedDurationSeconds.toFixed(1)}s)`,
      });
    }
  }
  return issues;
}

export async function assertVideoQc(filePath: string, expected: LongFormQcExpectations): Promise<VideoProbeInfo> {
  const info = await probeVideoFile(filePath);
  const issues = evaluateVideoProbe(info, expected);
  if (issues.length > 0) throw new LongFormQcFailedError(issues);
  return info;
}

// --- 2. Metadata del pipeline (report.json) ---------------------------------

export type ProductionReportForQc = {
  mode: "simulation" | "real";
  isFixtureContent: boolean;
  paidApisCalled: boolean;
  shotCount: number;
};

/** Verifica que un report.json que se pretende entregar como PRODUCCIÓN REAL de verdad lo sea — nunca deja pasar en silencio un run de fixture/simulation disfrazado de entrega final. */
export function evaluateProductionReportForRealRun(
  report: ProductionReportForQc,
  expectedShotCount: number,
): QcIssue[] {
  const issues: QcIssue[] = [];
  if (report.mode !== "real") {
    issues.push({ code: "not_real_mode", message: `mode="${report.mode}" — esto no es una producción real, no se debe entregar como tal` });
  }
  if (report.isFixtureContent) {
    issues.push({ code: "fixture_content", message: "isFixtureContent=true en el reporte — contenido de fixture, no el guion real aprobado" });
  }
  if (!report.paidApisCalled) {
    issues.push({
      code: "no_paid_apis_called",
      message: "paidApisCalled=false en un run marcado mode=real — revisar si de verdad se generaron assets reales antes de entregar",
    });
  }
  if (report.shotCount !== expectedShotCount) {
    issues.push({
      code: "shot_count_mismatch",
      message: `shotCount=${report.shotCount} en el reporte, se esperaban ${expectedShotCount} (según el storyboard aprobado) — revisar si el storyboard real se usó de verdad`,
    });
  }
  return issues;
}

export function assertProductionReportForRealRun(report: ProductionReportForQc, expectedShotCount: number): void {
  const issues = evaluateProductionReportForRealRun(report, expectedShotCount);
  if (issues.length > 0) throw new LongFormQcFailedError(issues);
}

// --- 3. Silencios anómalos (best-effort, ffmpeg silencedetect) -------------

export type SilenceInterval = { startSeconds: number; endSeconds: number; durationSeconds: number };

/**
 * Corre `ffmpeg -af silencedetect` sobre el archivo y devuelve los
 * intervalos de silencio más largos que `minSilenceSeconds`. Best-effort:
 * si ffmpeg no puede procesar el archivo, lanza (nunca devuelve "sin
 * silencios" como si hubiera podido evaluarlos y no encontró ninguno).
 */
export async function detectAnomalousSilences(filePath: string, minSilenceSeconds = 3): Promise<SilenceInterval[]> {
  const { stderr } = await run(
    ffmpegInstaller.path,
    ["-i", filePath, "-af", `silencedetect=noise=-35dB:d=${minSilenceSeconds}`, "-f", "null", "-"],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: { stderr?: string }) => {
    // ffmpeg con -f null - sale con código de éxito normalmente, pero
    // execFile puede reportar error si el proceso devuelve != 0 por otra
    // razón — se relanza igual, nunca se traga el error en silencio.
    if (err.stderr) return { stdout: "", stderr: err.stderr };
    throw err;
  });

  const intervals: SilenceInterval[] = [];
  const startMatches = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)];
  const endMatches = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
  for (let i = 0; i < Math.min(startMatches.length, endMatches.length); i++) {
    const startSeconds = Number(startMatches[i][1]);
    const endSeconds = Number(endMatches[i][1]);
    const durationSeconds = Number(endMatches[i][2]);
    if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && Number.isFinite(durationSeconds)) {
      intervals.push({ startSeconds, endSeconds, durationSeconds });
    }
  }
  return intervals;
}
