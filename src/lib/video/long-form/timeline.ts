/**
 * Síntesis de voz POR BEAT y reconstrucción de la línea de tiempo real de
 * Long Form — a diferencia de Shorts (generate-video.ts), que sintetiza
 * TODO el guion en una sola llamada a `VoiceProvider.synthesize()`, un
 * documental de 8-10 min puede acercarse o superar el límite documentado
 * de eleven_multilingual_v2 (10,000 caracteres/request — ver MODEL_ID en
 * src/lib/ai/voice.ts). Este módulo NO duplica esa función: la reutiliza
 * una vez por beat y aquí solo une los resultados (audio + timestamps).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptLanguage, VoiceProvider, WordTiming } from "@/lib/providers/types";
import { shotsForSpan } from "./shots";
import type { BeatType, NarrativeBeat } from "./types";

/**
 * Margen de seguridad explícito bajo el límite documentado de
 * eleven_multilingual_v2 (10,000 caracteres/request). Sintetizar por beat
 * ya deja cada llamada muy por debajo de esto en un documental típico
 * (~150-250 palabras/beat ≈ 900-1500 caracteres) — esta partición es una
 * defensa adicional para el caso (no esperado) de un beat inusualmente largo.
 */
export const MAX_TTS_CHARS_PER_CALL = 9000;

/** Parte una narración larga en trozos que respetan límites de oración, nunca cortan una palabra. */
export function splitNarrationIntoSafeChunks(text: string, maxChars = MAX_TTS_CHARS_PER_CALL): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

export type NarrationPart = {
  audioBuffer: Buffer;
  mimeType: string;
  extension: string;
  durationSeconds: number;
  words: WordTiming[];
};

/** Concatena N partes de narración en una sola, re-offseteando los timestamps por palabra. */
export function stitchNarrationParts(parts: NarrationPart[]): NarrationPart {
  if (parts.length === 0) throw new Error("stitchNarrationParts: no hay partes que unir");
  if (parts.length === 1) return parts[0];

  const { buffer, mimeType, extension } = concatAudio(parts);
  let offset = 0;
  const words: WordTiming[] = [];
  for (const part of parts) {
    for (const w of part.words) {
      words.push({ text: w.text, startSeconds: w.startSeconds + offset, endSeconds: w.endSeconds + offset });
    }
    offset += part.durationSeconds;
  }
  return { audioBuffer: buffer, mimeType, extension, durationSeconds: offset, words };
}

export type BeatNarrationResult = NarrationPart & { beatId: string };

/** Sintetiza la narración de UN beat (partiéndola de forma segura si hiciera falta) con el VoiceProvider ya existente — real o fixture, sin distinción aquí. */
export async function synthesizeBeatNarration(
  voiceProvider: VoiceProvider,
  beat: Pick<NarrativeBeat, "id" | "narration">,
  language: ScriptLanguage = "es",
): Promise<BeatNarrationResult> {
  const chunks = splitNarrationIntoSafeChunks(beat.narration);
  const parts: NarrationPart[] = [];
  for (const chunk of chunks) {
    const result = await voiceProvider.synthesize(chunk, language);
    parts.push({
      audioBuffer: result.audioBuffer,
      mimeType: result.mimeType,
      extension: result.extension,
      durationSeconds: result.durationSeconds,
      words: result.words,
    });
  }
  const stitched = stitchNarrationParts(parts);
  return { beatId: beat.id, ...stitched };
}

export type LongFormTimeline = NarrationPart & {
  /** Beats con startTargetSec/endTargetSec REALES (medidos, no estimados por conteo de palabras) y shots recalculados contra esa duración real. */
  beats: NarrativeBeat[];
};

type TimelineBeatInput = Pick<
  NarrativeBeat,
  "id" | "type" | "purpose" | "narration" | "claims" | "sources" | "emotionalTone" | "patternInterrupt"
>;

/**
 * Genera los Shot[] de UN beat contra su span REAL narrado. Por defecto es
 * shotsForSpan() (ciclo genérico de tipos, ver shots.ts) — pásese
 * `shotsBuilder` para usar en su lugar un storyboard curado real (ver
 * buildShotsFromStoryboard en storyboard-shots.ts), sin duplicar esta
 * función ni el resto del pipeline.
 */
export type ShotsBuilder = (input: {
  beatId: string;
  beatType: NarrativeBeat["type"];
  startSec: number;
  endSec: number;
  narration: string;
  typeOffset?: number;
}) => ReturnType<typeof shotsForSpan>;

/**
 * Construye la línea de tiempo real completa: sintetiza cada beat, une el
 * audio en un solo archivo, y recalcula shots[] de cada beat contra su
 * duración REAL narrada (no la duración objetivo aproximada del guion) —
 * mismo shotsForSpan() ya validado en el P0 por defecto, nunca una copia.
 */
export async function buildLongFormTimeline(
  voiceProvider: VoiceProvider,
  beats: TimelineBeatInput[],
  language: ScriptLanguage = "es",
  shotsBuilder: ShotsBuilder = shotsForSpan,
): Promise<LongFormTimeline> {
  if (beats.length === 0) throw new Error("buildLongFormTimeline: se necesita al menos un beat");

  const perBeat: BeatNarrationResult[] = [];
  for (const beat of beats) {
    perBeat.push(await synthesizeBeatNarration(voiceProvider, beat, language));
  }

  const finalBeats: NarrativeBeat[] = [];
  let cursor = 0;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const narrated = perBeat[i];
    const startTargetSec = cursor;
    const endTargetSec = cursor + narrated.durationSeconds;

    // shotsForSpan() (o el shotsBuilder inyectado) lanza si el span no se
    // puede convertir en shots válidos — deliberado: preferimos un error
    // claro a distorsionar la línea de tiempo real con un piso artificial
    // (ver duration-check.ts para el mismo criterio de "nunca
    // estirar/recortar en silencio").
    const shots = shotsBuilder({
      beatId: beat.id,
      beatType: beat.type,
      startSec: startTargetSec,
      endSec: endTargetSec,
      narration: beat.narration,
      typeOffset: i * 2,
    });

    finalBeats.push({ ...beat, startTargetSec, endTargetSec, shots });
    cursor = endTargetSec;
  }

  const stitched = stitchNarrationParts(perBeat);
  return { ...stitched, beats: finalBeats };
}

// --- Concatenación de audio ------------------------------------------------

function concatAudio(parts: { audioBuffer: Buffer; mimeType: string; extension: string }[]): {
  buffer: Buffer;
  mimeType: string;
  extension: string;
} {
  const extensions = new Set(parts.map((p) => p.extension));
  if (extensions.size > 1) {
    throw new Error(`concatAudio: no se puede unir audio de formatos distintos (${[...extensions].join(", ")})`);
  }
  const extension = parts[0].extension;
  const mimeType = parts[0].mimeType;

  if (extension === "wav") {
    return { buffer: concatWav(parts.map((p) => p.audioBuffer)), mimeType, extension };
  }
  return concatWithFfmpeg(parts.map((p) => p.audioBuffer), extension, mimeType);
}

type WavInfo = { sampleRate: number; numChannels: number; bitsPerSample: number; pcm: Buffer };

function parseWav(buffer: Buffer): WavInfo {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("parseWav: el buffer no es un WAV válido (falta cabecera RIFF/WAVE)");
  }
  let offset = 12;
  let fmt: { numChannels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let pcm: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        numChannels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      pcm = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || !pcm) throw new Error("parseWav: faltan los chunks 'fmt ' o 'data'");
  return { sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, bitsPerSample: fmt.bitsPerSample, pcm };
}

function buildWav(pcm: Buffer, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Concatenación WAV pura en JS (sin ffmpeg) — usada por el proveedor fixture, que siempre produce el mismo formato PCM (ver providers/wav.ts). */
function concatWav(buffers: Buffer[]): Buffer {
  const infos = buffers.map(parseWav);
  const [first, ...rest] = infos;
  for (const info of rest) {
    if (
      info.sampleRate !== first.sampleRate ||
      info.numChannels !== first.numChannels ||
      info.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error("concatWav: no se puede unir audio WAV con formato distinto (sampleRate/canales/bits)");
    }
  }
  const pcm = Buffer.concat(infos.map((i) => i.pcm));
  return buildWav(pcm, first.sampleRate, first.numChannels, first.bitsPerSample);
}

/** Concatenación vía ffmpeg (demuxer concat) — usada para mp3 real (ElevenLabs). Mismo binario que ya usa audio-master.ts. */
function concatWithFfmpeg(
  buffers: Buffer[],
  extension: string,
  mimeType: string,
): { buffer: Buffer; mimeType: string; extension: string } {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-longform-tts-"));
  try {
    const files = buffers.map((buf, i) => {
      const filePath = join(dir, `part-${i}.${extension}`);
      writeFileSync(filePath, buf);
      return filePath;
    });
    const listPath = join(dir, "list.txt");
    writeFileSync(listPath, files.map((f) => `file '${f}'`).join("\n"));
    const outPath = join(dir, `out.${extension}`);

    const result = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`ffmpeg concat falló: ${result.stderr || result.stdout}`);
    }
    return { buffer: readFileSync(outPath), mimeType, extension };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Re-exportado solo para pruebas unitarias del parser/writer WAV.
export const __internal = { parseWav, buildWav, concatWav };
export type { BeatType };
