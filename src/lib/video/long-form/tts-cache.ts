/**
 * Persistencia/idempotencia POR BEAT de la síntesis de voz real
 * (ElevenLabs) — resuelve el gap documentado en HANDOFF-PRODUCTION-V1.md:
 * sin esto, si el orquestador se caía a mitad de sintetizar los 13 beats
 * de un run real y se volvía a correr, TODOS los beats se resintetizaban
 * (y se recobraban), no solo los que faltaban.
 *
 * Identidad determinística de cada entrada de caché: videoId + beatId +
 * texto EXACTO de la narración + voiceId + modelId + los parámetros de
 * voz relevantes (nunca `speed`, que es un ajuste por llamada, no de
 * identidad — ver getVoiceIdentity() en src/lib/ai/voice.ts) + idioma +
 * nombre del proveedor. Si cualquiera de estos cambia, la clave cambia, y
 * eso es exactamente lo que queremos: nunca reutilizar audio de un texto,
 * voz o modelo distinto.
 *
 * Tres estados por entrada:
 *  - (sin registro) → hay que sintetizar, es la primera vez.
 *  - STARTED → se llamó al proveedor pero el proceso no llegó a confirmar
 *    el resultado (crash a mitad de la llamada, por ejemplo). CONSUMO
 *    INCIERTO: nunca se reintenta solo — se lanza TtsUncertainCostStateError
 *    y se detiene la ejecución, para que un humano decida (revisar el
 *    dashboard de ElevenLabs, y si no se cobró, borrar el registro a mano
 *    para permitir un nuevo intento).
 *  - COMPLETED → hay un resultado válido. Si el archivo de audio en disco
 *    pasa validación (existe, checksum coincide, no está vacío), se
 *    REUTILIZA sin llamar al proveedor. Si no pasa validación (archivo
 *    corrupto/borrado), se trata como si no hubiera caché — nueva síntesis
 *    consciente, nunca se asume que el archivo corrupto es válido.
 *
 * El proveedor FIXTURE nunca toca este módulo — es gratis, y jamás debe
 * poder quedar registrado como si fuera una síntesis real completada
 * (ver synthesizeBeatNarrationCached: bypass total para name === "fixture").
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptLanguage, VoiceProvider, WordTiming } from "@/lib/providers/types";
import type { NarrativeBeat } from "./types";
import { synthesizeBeatNarration, type BeatNarrationResult } from "./timeline";

export type TtsCacheIdentity = {
  videoId: string;
  beatId: string;
  text: string;
  voiceId: string;
  modelId: string;
  /** JSON.stringify de los parámetros de voz relevantes (stability, similarity_boost, style, use_speaker_boost) — nunca `speed`. */
  voiceSettingsJson: string;
  language: string;
  providerName: string;
};

export type TtsCacheRecordStatus = "STARTED" | "COMPLETED" | "NEEDS_REVIEW";

export type TtsCacheRecord = {
  key: string;
  identity: TtsCacheIdentity;
  status: TtsCacheRecordStatus;
  audioPath?: string;
  audioChecksumSha256?: string;
  mimeType?: string;
  extension?: string;
  durationSeconds?: number;
  words?: WordTiming[];
  costUsd?: number;
  createdAtIso: string;
  updatedAtIso: string;
  note?: string;
};

/** Determinístico: la misma identidad SIEMPRE produce la misma clave, en cualquier proceso/máquina — es lo que hace posible detectar "mismo beat, mismos parámetros" entre ejecuciones distintas. */
export function computeTtsCacheKey(identity: TtsCacheIdentity): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(identity));
  return hash.digest("hex").slice(0, 20);
}

export function defaultTtsCacheDir(videoId: string): string {
  return `.atomivid-state/long-form/tts-cache/${videoId}`;
}

function recordPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}

function audioPathFor(cacheDir: string, key: string, extension: string): string {
  return join(cacheDir, `${key}.${extension}`);
}

export function readTtsCacheRecord(cacheDir: string, key: string): TtsCacheRecord | undefined {
  const filePath = recordPath(cacheDir, key);
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, "utf8")) as TtsCacheRecord;
}

/** Escritura SÍNCRONA — si el proceso se cae justo después, el registro ya quedó en disco para la siguiente ejecución. */
export function writeTtsCacheRecord(cacheDir: string, record: TtsCacheRecord): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(recordPath(cacheDir, record.key), JSON.stringify(record, null, 2));
}

export function computeChecksumSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** true solo si el archivo existe, no está vacío, y su checksum coincide EXACTO con el registrado al completar la síntesis — un archivo corrupto/truncado/reemplazado nunca pasa. */
export function validateCachedAudioFile(record: TtsCacheRecord): boolean {
  if (!record.audioPath || !record.audioChecksumSha256) return false;
  if (!existsSync(record.audioPath)) return false;
  const buffer = readFileSync(record.audioPath);
  if (buffer.byteLength === 0) return false;
  return computeChecksumSha256(buffer) === record.audioChecksumSha256;
}

export class TtsUncertainCostStateError extends Error {
  constructor(
    public readonly beatId: string,
    public readonly key: string,
  ) {
    super(
      `Beat "${beatId}" (clave de caché ${key}) tiene un registro TTS en estado STARTED sin un COMPLETED válido — ` +
        `consumo incierto (pudo haberse cobrado del lado de ElevenLabs sin que este proceso llegara a confirmarlo). ` +
        `Nunca se reintenta automáticamente en este caso: revisa el dashboard de ElevenLabs para confirmar si se cobró, ` +
        `y si no se cobró, borra manualmente el registro de caché correspondiente antes de volver a correr.`,
    );
    this.name = "TtsUncertainCostStateError";
  }
}

export type TtsCostGuard = {
  /** Estimación de costo ANTES de llamar al proveedor — nunca el costo real (eso se sabe después). */
  estimateCostUsd(text: string): number;
  /** Debe lanzar si el gasto no está permitido — se llama ANTES de la llamada real, nunca después. */
  assertCanSpend(amountUsd: number): void;
  /** Se llama SOLO tras una síntesis nueva exitosa — nunca para un resultado reutilizado. */
  recordSpend(amountUsd: number, note: string): void;
};

export type SynthesizeBeatCachedResult = BeatNarrationResult & { reused: boolean; costUsd: number };

function toRecordWordTimings(words: WordTiming[]): WordTiming[] {
  return words.map((w) => ({ text: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds }));
}

/**
 * Versión con caché/idempotencia de synthesizeBeatNarration() — mismo
 * resultado (BeatNarrationResult), más `reused`/`costUsd`. El proveedor
 * FIXTURE nunca pasa por el caché (bypass total, ver arriba). Para el
 * proveedor real: consulta el registro antes de llamar, reutiliza si hay
 * un COMPLETED válido, lanza TtsUncertainCostStateError si hay un STARTED
 * sin resolver, y solo entonces sintetiza de nuevo — registrando STARTED
 * antes de la llamada y COMPLETED (con checksum) inmediatamente después.
 */
export async function synthesizeBeatNarrationCached(
  voiceProvider: VoiceProvider,
  beat: Pick<NarrativeBeat, "id" | "narration">,
  language: ScriptLanguage,
  ctx: {
    videoId: string;
    cacheDir?: string;
    voiceIdentity: { voiceId: string; modelId: string; voiceSettingsJson: string };
    costGuard?: TtsCostGuard;
  },
): Promise<SynthesizeBeatCachedResult> {
  if (voiceProvider.name === "fixture") {
    // Gratis, y nunca debe quedar registrado como si fuera una síntesis
    // real completada — bypass total del caché, sin excepciones.
    const result = await synthesizeBeatNarration(voiceProvider, beat, language);
    return { ...result, reused: false, costUsd: 0 };
  }

  const cacheDir = ctx.cacheDir ?? defaultTtsCacheDir(ctx.videoId);
  const identity: TtsCacheIdentity = {
    videoId: ctx.videoId,
    beatId: beat.id,
    text: beat.narration,
    voiceId: ctx.voiceIdentity.voiceId,
    modelId: ctx.voiceIdentity.modelId,
    voiceSettingsJson: ctx.voiceIdentity.voiceSettingsJson,
    language,
    providerName: voiceProvider.name,
  };
  const key = computeTtsCacheKey(identity);
  const existing = readTtsCacheRecord(cacheDir, key);

  if (existing?.status === "COMPLETED" && validateCachedAudioFile(existing)) {
    const audioBuffer = readFileSync(existing.audioPath!);
    return {
      beatId: beat.id,
      audioBuffer,
      mimeType: existing.mimeType!,
      extension: existing.extension!,
      durationSeconds: existing.durationSeconds!,
      words: existing.words!,
      reused: true,
      costUsd: 0,
    };
  }

  if (existing?.status === "STARTED") {
    throw new TtsUncertainCostStateError(beat.id, key);
  }

  // Sin caché válido (nunca sintetizado, o COMPLETED con archivo corrupto/faltante): síntesis nueva y consciente.
  const now = new Date().toISOString();
  const estimatedCostUsd = ctx.costGuard?.estimateCostUsd(beat.narration) ?? 0;
  if (ctx.costGuard) ctx.costGuard.assertCanSpend(estimatedCostUsd);

  writeTtsCacheRecord(cacheDir, { key, identity, status: "STARTED", createdAtIso: now, updatedAtIso: now });

  const result = await synthesizeBeatNarration(voiceProvider, beat, language);

  const audioPath = audioPathFor(cacheDir, key, result.extension);
  writeFileSync(audioPath, result.audioBuffer);
  const checksum = computeChecksumSha256(result.audioBuffer);

  writeTtsCacheRecord(cacheDir, {
    key,
    identity,
    status: "COMPLETED",
    audioPath,
    audioChecksumSha256: checksum,
    mimeType: result.mimeType,
    extension: result.extension,
    durationSeconds: result.durationSeconds,
    words: toRecordWordTimings(result.words),
    costUsd: estimatedCostUsd,
    createdAtIso: now,
    updatedAtIso: new Date().toISOString(),
  });

  if (ctx.costGuard) ctx.costGuard.recordSpend(estimatedCostUsd, `TTS beat ${beat.id}`);

  return { ...result, reused: false, costUsd: estimatedCostUsd };
}
