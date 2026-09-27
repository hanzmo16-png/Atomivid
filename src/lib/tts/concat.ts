/**
 * Archivos finales de «Texto a voz» (ffmpeg; ver podcast-audio.ts):
 * - narración: une los fragmentos (pausas, micro-fundidos, nivelado) y la
 *   masteriza a MP3 mono con el pico real verificado;
 * - podcast con música: mezcla esa narración con un fondo en bucle y
 *   masteriza a MP3 estéreo.
 * Todo en una carpeta temporal que se borra al terminar.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderMusicBedWav, type MusicBed } from "./music-beds";
import {
  concatNarrationWav,
  masterToMp3,
  mixNarrationWithBed,
  MIX_TARGET,
  NARRATION_TARGET,
  probeDurationSeconds,
  type MasterReport,
  type MixLevels,
  type NarrationPart,
} from "./podcast-audio";

export type ConcatPart = NarrationPart;

export { probeDurationSeconds };

/** Resumen guardado con la pieza (tts_jobs.narration_loudness / mix_loudness). */
export type LoudnessSummary = {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
  targetLufs: number;
  bitrateKbps: number;
  attempts: number;
};

export function summarizeMaster(report: MasterReport, targetLufs: number): LoudnessSummary {
  return {
    integratedLufs: report.after.integratedLufs,
    truePeakDbtp: report.after.truePeakDbtp,
    lra: report.after.lra,
    targetLufs,
    bitrateKbps: report.bitrateKbps,
    attempts: report.attempts,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "atomivid-tts-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function concatToMp3(parts: ConcatPart[]): Promise<{ audio: Buffer; durationSeconds: number; loudness: LoudnessSummary; gainsDb: number[] }> {
  return withTempDir(async (dir) => {
    const joined = await concatNarrationWav(parts, dir);
    const output = path.join(dir, "narracion.mp3");
    const report = await masterToMp3(joined.wavPath, output, NARRATION_TARGET, { durationSeconds: joined.durationSeconds });
    return {
      audio: await readFile(output),
      durationSeconds: await probeDurationSeconds(output),
      loudness: summarizeMaster(report, NARRATION_TARGET.lufs),
      gainsDb: joined.gainsDb,
    };
  });
}

export async function mixToMp3(input: { narration: Buffer; bed: MusicBed }): Promise<{ audio: Buffer; durationSeconds: number; loudness: LoudnessSummary; levels: MixLevels }> {
  return withTempDir(async (dir) => {
    const narration = path.join(dir, "narracion.mp3");
    const bed = path.join(dir, "fondo.wav");
    await writeFile(narration, input.narration);
    await writeFile(bed, renderMusicBedWav(input.bed));
    const mixed = await mixNarrationWithBed({ narration, bed, output: path.join(dir, "mezcla.wav") });
    const output = path.join(dir, "podcast-con-musica.mp3");
    const report = await masterToMp3(mixed.wavPath, output, MIX_TARGET, { durationSeconds: mixed.durationSeconds });
    return { audio: await readFile(output), durationSeconds: await probeDurationSeconds(output), loudness: summarizeMaster(report, MIX_TARGET.lufs), levels: mixed.levels };
  });
}
