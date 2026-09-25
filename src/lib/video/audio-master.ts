import { spawn } from "node:child_process";

/**
 * Masterización de loudness del video final — causa raíz confirmada del
 * defecto "la mezcla general está demasiado baja para redes sociales"
 * (video auditado: -22.49 LUFS integrado, -8.52 dBTP de true peak — muy
 * por debajo del estándar comercial y con ~7dB de headroom sin usar, así
 * que no hay riesgo de distorsión al subir el nivel). La causa: el
 * pipeline anterior solo aplicaba ganancias RELATIVAS entre voz y música
 * dentro de Remotion (ver remotion/audio-mix.ts) — nunca medía ni
 * normalizaba el nivel absoluto del archivo final contra un objetivo de
 * loudness. No existe ningún paso de masterización.
 *
 * Usa el filtro `loudnorm` de ffmpeg en dos pasadas (medir, luego aplicar
 * con los valores medidos — más preciso que una sola pasada) — el
 * estándar de facto para normalización de loudness. ffmpeg NO viene
 * preinstalado en el runner de GitHub Actions (verificado: no aparece en
 * el inventario de software de la imagen ubuntu-latest) — se instala
 * explícitamente como paso del workflow (.github/workflows/render.yml,
 * `apt-get install -y ffmpeg`), software libre sin costo ni suscripción.
 */
export const LOUDNESS_TARGET = {
  /** LUFS integrado objetivo — estándar competitivo para TikTok/Reels/Shorts (ver justificación en el reporte de esta fase; configurable si -14 resulta más apropiado). */
  INTEGRATED_LUFS: -16,
  /** True peak máximo permitido, en dBTP. */
  TRUE_PEAK_DBTP: -1.5,
  /** Rango de loudness objetivo (LRA) — valor por defecto de ffmpeg, adecuado para narración + música. */
  LRA: 11,
} as const;

export type LoudnessMeasurement = {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
  threshold: number;
};

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg terminó con código ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** El filtro loudnorm imprime un bloque JSON en stderr al terminar — se extrae el último objeto `{...}` del texto. Exportado para poder probarlo sin invocar ffmpeg de verdad. */
export function parseLoudnormJson(stderr: string): Record<string, string> {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No se pudo leer la medición de loudnorm en la salida de ffmpeg");
  }
  return JSON.parse(stderr.slice(start, end + 1));
}

/** Mide el loudness actual de un archivo sin modificarlo (primera pasada de loudnorm, solo análisis). */
export async function measureLoudness(filePath: string): Promise<LoudnessMeasurement> {
  const filter =
    `loudnorm=I=${LOUDNESS_TARGET.INTEGRATED_LUFS}:TP=${LOUDNESS_TARGET.TRUE_PEAK_DBTP}:` +
    `LRA=${LOUDNESS_TARGET.LRA}:print_format=json`;
  const { stderr } = await runFfmpeg(["-i", filePath, "-af", filter, "-f", "null", "-"]);
  const json = parseLoudnormJson(stderr);
  return {
    integratedLufs: Number(json.input_i),
    truePeakDbtp: Number(json.input_tp),
    lra: Number(json.input_lra),
    threshold: Number(json.input_thresh),
  };
}

export type MasteringResult = {
  before: LoudnessMeasurement;
  after: LoudnessMeasurement;
};

/**
 * Normaliza el audio del video final a LOUDNESS_TARGET y lo escribe en
 * `outputPath` — el video (`-c:v copy`) no se reencoda, solo el audio.
 * Mide antes Y después (segunda medición real sobre el archivo ya
 * masterizado, no solo los parámetros configurados) para poder validar
 * el resultado con datos, no con la promesa de que el filtro funcionó.
 */
export async function masterAudioLoudness(
  inputPath: string,
  outputPath: string,
  /** `faststart` (solo Long Form): moov al inicio para que un archivo grande empiece a reproducirse sin descargarse entero. */
  opts: { faststart?: boolean } = {},
): Promise<MasteringResult> {
  const before = await measureLoudness(inputPath);

  const filter =
    `loudnorm=I=${LOUDNESS_TARGET.INTEGRATED_LUFS}:TP=${LOUDNESS_TARGET.TRUE_PEAK_DBTP}:` +
    `LRA=${LOUDNESS_TARGET.LRA}:measured_I=${before.integratedLufs}:measured_TP=${before.truePeakDbtp}:` +
    `measured_LRA=${before.lra}:measured_thresh=${before.threshold}:linear=true:print_format=summary`;

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-af",
    filter,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    ...(opts.faststart ? ["-movflags", "+faststart"] : []),
    outputPath,
  ]);

  const after = await measureLoudness(outputPath);
  return { before, after };
}
