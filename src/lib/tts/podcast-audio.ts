/**
 * Audio de «Texto a voz» para podcast (ffmpeg, software libre; el worker ya
 * lo instala). Tres pasos:
 *
 * 1. Unir la narración: fragmentos con sus pausas, micro-fundidos en cada
 *    borde (sin clics) y nivelado suave entre fragmentos (±3 dB como
 *    máximo, solo si uno se aparta más de 1,5 dB de la mediana) para que no
 *    haya saltos de volumen. Resultado sin pérdida (WAV en coma flotante).
 * 2. Masterizar a MP3 con verificación ACOTADA: ganancia hacia el objetivo
 *    de sonoridad, limitador, codificación y medición del pico real del MP3
 *    ya codificado. Si supera el techo, se corrige y se vuelve a codificar
 *    DESDE EL ORIGINAL SIN PÉRDIDA (nunca MP3 sobre MP3), hasta 4 veces; si
 *    aun así no cumple, se detiene con error en vez de entregar un archivo
 *    saturado. (La masterización compartida de video, audio-master.ts,
 *    corrige re-codificando la salida ya comprimida y su sobrepico no queda
 *    acotado; por eso no se usa aquí. Ver docs/VOICES.md.)
 * 3. Mezclar con música: entrada gradual, la música baja antes de que
 *    empiece la voz y se mantiene por debajo durante toda la narración,
 *    vuelve a subir al terminar y sale gradualmente. El fondo es un bucle
 *    perfecto (music-beds.ts) repetido tantas veces como haga falta.
 *
 * Objetivos (recomendación AES para podcast): narración mono −19 LUFS
 * (equivale a −16 en estéreo), mezcla estéreo −16 LUFS, pico real ≤ −1,5
 * dBTP en ambos.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export class PodcastAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodcastAudioError";
  }
}

export const NARRATION_TARGET = { lufs: -19, ceilingDbtp: -1.5, channels: 1 as const };
export const MIX_TARGET = { lufs: -16, ceilingDbtp: -1.5, channels: 2 as const };

/** Mezcla: segundos y niveles relativos a la voz (LU). */
export const MIX = {
  introSeconds: 6,
  fadeInSeconds: 3,
  duckSeconds: 2.5,
  riseDelaySeconds: 0.8,
  riseSeconds: 2.5,
  holdSeconds: 3,
  fadeOutSeconds: 5,
  /** Música sola (entrada y salida): 6 LU por debajo de la voz. */
  openRelativeLu: -6,
  /** Música bajo la narración: 20 LU por debajo de la voz. */
  underRelativeLu: -20,
} as const;

export function mixTailSeconds(): number {
  return MIX.riseDelaySeconds + MIX.riseSeconds + MIX.holdSeconds + MIX.fadeOutSeconds;
}

export function mixTotalSeconds(narrationSeconds: number): number {
  return MIX.introSeconds + narrationSeconds + mixTailSeconds();
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} terminó con código ${code}: ${stderr.slice(-1500)}`))));
  });
}

export type Loudness = { integratedLufs: number; truePeakDbtp: number; lra: number };

/** Lee el resumen de ebur128 (I, LRA y pico real). Exportado para probarlo sin ffmpeg. */
export function parseEbur128Summary(stderr: string): Loudness {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    if (!m) return NaN;
    return m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  const result = { integratedLufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), lra: num(/LRA:\s+(-?[\d.]+)\s+LU/), truePeakDbtp: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) };
  if (Number.isNaN(result.integratedLufs) || Number.isNaN(result.truePeakDbtp)) throw new PodcastAudioError("No se pudo leer la medición de sonoridad.");
  return result;
}

/** Sonoridad integrada (LUFS), rango (LU) y pico real (dBTP, sobremuestreo x4) del archivo. */
export async function measureLoudness(file: string): Promise<Loudness> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"]);
  return parseEbur128Summary(stderr);
}

export async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const value = Number(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new PodcastAudioError("No se pudo medir la duración del audio.");
  return value;
}

/**
 * Nivelado entre fragmentos: solo corrige lo que se aparta de la mediana más
 * de `deadbandDb`, y como máximo `maxDb`. Fragmentos sin medición fiable
 * (null, silencio) quedan igual. Lógica pura.
 */
export function levelMatchGains(loudness: (number | null)[], opts: { deadbandDb?: number; maxDb?: number } = {}): number[] {
  const deadband = opts.deadbandDb ?? 1.5;
  const max = opts.maxDb ?? 3;
  const valid = loudness.filter((l): l is number => l !== null && Number.isFinite(l) && l > -60).sort((a, b) => a - b);
  if (valid.length < 2) return loudness.map(() => 0);
  const mid = valid.length % 2 ? valid[(valid.length - 1) / 2] : (valid[valid.length / 2 - 1] + valid[valid.length / 2]) / 2;
  return loudness.map((l) => {
    if (l === null || !Number.isFinite(l) || l <= -60) return 0;
    const diff = mid - l;
    const beyond = Math.max(0, Math.abs(diff) - deadband);
    return Math.round(Math.sign(diff) * Math.min(beyond, max) * 100) / 100 + 0; // + 0: sin «-0»
  });
}

/**
 * Argumentos de la unión (exportado para probarlo sin ffmpeg): cada
 * fragmento remuestreado a 44,1 kHz mono, con su ganancia de nivelado,
 * fundido de 8 ms al entrar y de 15 ms al salir (sin clics), y su silencio.
 * Salida WAV en coma flotante (sin pérdida ni recorte antes de masterizar).
 */
export function narrationConcatArgs(inputs: string[], pausesMs: number[], gainsDb: number[], output: string): string[] {
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);
  const labels: string[] = [];
  const filters: string[] = [];
  inputs.forEach((_, i) => {
    const gain = gainsDb[i] ?? 0;
    filters.push(
      `[${i}:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=mono,volume=${gain.toFixed(2)}dB,afade=t=in:d=0.008,areverse,afade=t=in:d=0.015,areverse[a${i}]`,
    );
    labels.push(`[a${i}]`);
    const pause = pausesMs[i] ?? 0;
    if (pause > 0) {
      filters.push(`anullsrc=r=44100:cl=mono,atrim=duration=${(pause / 1000).toFixed(3)},aformat=sample_fmts=flt[s${i}]`);
      labels.push(`[s${i}]`);
    }
  });
  filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "pcm_f32le", output);
  return args;
}

export type NarrationPart = { audio: Buffer; extension: string; pauseAfterMs: number };

/** Une los fragmentos en `dir/narration.wav`. Devuelve la ruta, la duración y las ganancias aplicadas. */
export async function concatNarrationWav(parts: NarrationPart[], dir: string): Promise<{ wavPath: string; durationSeconds: number; gainsDb: number[] }> {
  if (!parts.length) throw new PodcastAudioError("No hay fragmentos para unir.");
  const inputs = await Promise.all(
    parts.map(async (part, i) => {
      const file = path.join(dir, `part-${String(i).padStart(4, "0")}.${part.extension}`);
      await writeFile(file, part.audio);
      return file;
    }),
  );
  const loudness: (number | null)[] = [];
  for (let i = 0; i < inputs.length; i += 4) {
    const batch = await Promise.all(inputs.slice(i, i + 4).map((f) => measureLoudness(f).then((l) => l.integratedLufs).catch(() => null)));
    loudness.push(...batch);
  }
  const gainsDb = levelMatchGains(loudness);
  const wavPath = path.join(dir, "narration.wav");
  await run("ffmpeg", narrationConcatArgs(inputs, parts.map((p) => p.pauseAfterMs), gainsDb, wavPath));
  return { wavPath, durationSeconds: await probeDurationSeconds(wavPath), gainsDb };
}

const MiB = 1024 * 1024;
/** Techo por archivo: el límite de subida de Storage demostrado es 50 MiB (output-policy.ts); se deja margen. */
export const DEFAULT_MAX_OBJECT_BYTES = 47 * MiB;
const BITRATES = [128, 112, 96, 80, 64];

/** Mayor tasa (kbps) con la que el MP3 cabe en el techo de Storage; null si ni la mínima cabe. */
export function podcastBitrateKbps(durationSeconds: number, maxBytes = DEFAULT_MAX_OBJECT_BYTES): number | null {
  for (const kbps of BITRATES) {
    const bytes = ((kbps * 1000) / 8) * durationSeconds * 1.01 + 64 * 1024;
    if (bytes <= maxBytes) return kbps;
  }
  return null;
}

export type MasterReport = {
  before: Loudness;
  after: Loudness;
  gainDb: number;
  limiterDb: number;
  attempts: number;
  bitrateKbps: number;
};

const dbToLinear = (db: number) => 10 ** (db / 20);

/**
 * Masteriza `input` (sin pérdida) a MP3 en `output`, con el pico real del
 * MP3 final verificado. Cada corrección vuelve a partir de `input`.
 */
export async function masterToMp3(
  input: string,
  output: string,
  target: { lufs: number; ceilingDbtp: number; channels: 1 | 2 },
  opts: { durationSeconds: number; maxBytes?: number; maxAttempts?: number },
): Promise<MasterReport> {
  const bitrateKbps = podcastBitrateKbps(opts.durationSeconds, opts.maxBytes);
  if (!bitrateKbps) throw new PodcastAudioError("El audio es demasiado largo para guardarlo como un solo archivo.");
  const before = await measureLoudness(input);
  if (!Number.isFinite(before.integratedLufs)) throw new PodcastAudioError("El audio está en silencio.");
  let gainDb = Math.max(-30, Math.min(30, target.lufs - before.integratedLufs));
  // Techo inicial del limitador 1 dB bajo el objetivo: la codificación MP3 añade sobrepico.
  let limiterDb = target.ceilingDbtp - 1;
  let refined = false;
  const maxAttempts = opts.maxAttempts ?? 5;
  let last: Loudness | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const filter = `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${dbToLinear(limiterDb).toFixed(5)}:attack=5:release=80:level=false:latency=true`;
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-af", filter, "-ar", "44100", "-ac", String(target.channels), "-c:a", "libmp3lame", "-b:a", `${bitrateKbps}k`, output]);
    last = await measureLoudness(output);
    if (last.truePeakDbtp > target.ceilingDbtp) {
      limiterDb -= last.truePeakDbtp - target.ceilingDbtp + 0.3;
      if (limiterDb < -24) break;
      continue;
    }
    // Una sola corrección fina de sonoridad (la medición del MP3 difiere unas décimas del original).
    const off = target.lufs - last.integratedLufs;
    if (!refined && Math.abs(off) > 0.3) {
      gainDb += off;
      refined = true;
      continue;
    }
    return { before, after: last, gainDb, limiterDb, attempts: attempt, bitrateKbps };
  }
  throw new PodcastAudioError(`No se pudo dejar el pico real bajo ${target.ceilingDbtp} dBTP (medido ${last?.truePeakDbtp ?? "?"}).`);
}

/**
 * Curva de ganancia de la música (dB, relativa a su nivel «abierto»):
 * abierta en la entrada, baja hasta «bajo la voz» justo antes de que empiece
 * la narración, se mantiene así hasta que termina y vuelve a subir. Rampas
 * lineales en dB; los fundidos de entrada/salida van aparte. Pura.
 */
export function musicCurvePoints(narrationSeconds: number): { t: number; db: number }[] {
  const duck = MIX.underRelativeLu - MIX.openRelativeLu;
  const voiceEnd = MIX.introSeconds + narrationSeconds;
  const riseStart = voiceEnd + MIX.riseDelaySeconds;
  return [
    { t: 0, db: 0 },
    { t: MIX.introSeconds - MIX.duckSeconds, db: 0 },
    { t: MIX.introSeconds, db: duck },
    { t: riseStart, db: duck },
    { t: riseStart + MIX.riseSeconds, db: 0 },
    { t: mixTotalSeconds(narrationSeconds), db: 0 },
  ];
}

/** Valor de la curva en `t` (misma interpolación que la expresión de ffmpeg). */
export function musicCurveAt(points: { t: number; db: number }[], t: number): number {
  if (t <= points[0].t) return points[0].db;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) return b.t === a.t ? b.db : a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1].db;
}

/** La curva como expresión de `volume` (eval=frame), con `offsetDb` sumado. */
export function musicVolumeExpression(points: { t: number; db: number }[], offsetDb: number): string {
  let expr = `${points[points.length - 1].db.toFixed(3)}`;
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1];
    const b = points[i];
    const seg = b.t === a.t ? `${b.db.toFixed(3)}` : `${a.db.toFixed(3)}+(${(b.db - a.db).toFixed(3)})*(t-${a.t.toFixed(3)})/${(b.t - a.t).toFixed(3)}`;
    expr = `if(lt(t\\,${b.t.toFixed(3)})\\,${seg}\\,${expr})`;
  }
  return `pow(10\\,(${offsetDb.toFixed(3)}+${expr})/20)`;
}

export type MixLevels = { voiceStereoLufs: number; bedLufs: number; openGainDb: number };

/** Ganancia del fondo para que la música «abierta» quede MIX.openRelativeLu por debajo de la voz (estéreo). */
export function musicOpenGainDb(narrationMonoLufs: number, bedLufs: number): MixLevels {
  const voiceStereoLufs = narrationMonoLufs + 3.01; // mono duplicado en dos canales
  return { voiceStereoLufs, bedLufs, openGainDb: Math.round((voiceStereoLufs + MIX.openRelativeLu - bedLufs) * 100) / 100 };
}

/**
 * Argumentos de la mezcla (exportado para probarlo sin ffmpeg). `stem`
 * permite renderizar solo la voz o solo la música con la MISMA curva (para
 * medir la relación voz/música en las pruebas).
 */
export function mixArgs(o: { narration: string; bed: string; output: string; narrationSeconds: number; openGainDb: number; stem?: "voice" | "music" }): string[] {
  const total = mixTotalSeconds(o.narrationSeconds);
  const delayMs = Math.round(MIX.introSeconds * 1000);
  const voiceGain = o.stem === "music" ? "volume=0," : "";
  const musicMute = o.stem === "voice" ? "volume=0," : "";
  const expr = musicVolumeExpression(musicCurvePoints(o.narrationSeconds), o.openGainDb);
  const graph = [
    `[0:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=mono,${voiceGain}pan=stereo|c0=c0|c1=c0,adelay=${delayMs}|${delayMs},apad=whole_dur=${total.toFixed(3)}[v]`,
    `[1:a]aformat=sample_fmts=flt:channel_layouts=stereo,atrim=duration=${total.toFixed(3)},asetpts=N/SR/TB,highpass=f=60,equalizer=f=2200:t=q:w=0.9:g=-4,${musicMute}volume='${expr}':eval=frame,afade=t=in:d=${MIX.fadeInSeconds}:curve=qsin,afade=t=out:st=${(total - MIX.fadeOutSeconds).toFixed(3)}:d=${MIX.fadeOutSeconds}:curve=qsin[m]`,
    `[v][m]amix=inputs=2:duration=first:normalize=0,atrim=duration=${total.toFixed(3)}[out]`,
  ].join(";");
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", o.narration, "-stream_loop", "-1", "-i", o.bed, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_f32le", o.output];
}

/** Mezcla la narración (MP3 masterizado) con el fondo en bucle; devuelve un WAV sin pérdida para masterizar. */
export async function mixNarrationWithBed(o: { narration: string; bed: string; output: string; stem?: "voice" | "music" }): Promise<{ wavPath: string; narrationSeconds: number; durationSeconds: number; levels: MixLevels }> {
  const [narrationSeconds, voice, bed] = await Promise.all([probeDurationSeconds(o.narration), measureLoudness(o.narration), measureLoudness(o.bed)]);
  const levels = musicOpenGainDb(voice.integratedLufs, bed.integratedLufs);
  await run("ffmpeg", mixArgs({ narration: o.narration, bed: o.bed, output: o.output, narrationSeconds, openGainDb: levels.openGainDb, stem: o.stem }));
  return { wavPath: o.output, narrationSeconds, durationSeconds: await probeDurationSeconds(o.output), levels };
}
