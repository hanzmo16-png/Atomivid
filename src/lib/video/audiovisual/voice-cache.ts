/**
 * Voz reutilizable entre reintentos del Reel dirigido: si coinciden texto,
 * voz (proveedor + voiceId + modelo + ajustes), idioma y velocidad, se
 * reutilizan el audio y sus tiempos por palabra ya pagados. La síntesis de
 * corrección de duración (otra velocidad) es otra entrada del caché y otra
 * operación del registro de gasto («voice_retime»), así ambas se cuentan.
 *
 * Mismo diseño que production-tts-cache.ts de Long Form (STARTED →
 * COMPLETED con checksum), con estados explícitos para los fallos:
 *  - started: la llamada pudo cobrarse y no terminó → no se repite sola.
 *  - generated_unstored: se cobró y el audio no quedó guardado → no se repite sola.
 *  - completed: se reutiliza si el checksum coincide; si el audio falta o
 *    no coincide, se detiene (ya se pagó; repetir requiere revisión).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScriptLanguage, VoiceProvider, VoiceResult, WordTiming } from "@/lib/providers/types";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { NotSentError, type PaidLedger } from "./paid-ledger";
import { classifyVoiceFailure, voiceCostUsd, voiceReserveUsd } from "./paid-costs";
import { readJsonState, uploadWithRetry, writeJsonState, StorageStateUnknownError } from "./storage-state";

export type VoiceCacheIdentity = {
  provider: string;
  voice: { voiceId: string; modelId: string; voiceSettingsJson: string } | null;
  language: string;
  /** Velocidad pedida redondeada (null = la del proveedor por defecto). */
  speed: number | null;
  text: string;
};

export type VoiceCacheRecord = {
  key: string;
  status: "started" | "generated_unstored" | "completed";
  identity: Omit<VoiceCacheIdentity, "text"> & { textSha256: string; characters: number };
  audioPath?: string;
  audioSha256?: string;
  mimeType?: string;
  extension?: string;
  durationSeconds?: number;
  words?: WordTiming[];
  updatedAtIso: string;
  note?: string;
};

export class VoiceCacheUncertainError extends Error {
  constructor(public readonly key: string, status: string) {
    super(`La narración (${key.slice(0, 12)}) tiene un intento anterior en estado «${status}»: pudo cobrarse sin resultado guardado. No se vuelve a sintetizar automáticamente; requiere revisión.`);
    this.name = "VoiceCacheUncertainError";
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function voiceIdentityFor(provider: VoiceProvider, text: string, language: ScriptLanguage, speed?: number): VoiceCacheIdentity {
  return {
    provider: provider.name,
    voice: provider.name === "elevenlabs" ? getVoiceIdentity(language) : null,
    language,
    speed: speed === undefined ? null : Math.round(speed * 10000) / 10000,
    text,
  };
}

export function voiceCacheKey(identity: VoiceCacheIdentity): string {
  return sha256(JSON.stringify(identity));
}

export async function synthesizeNarrationCached({
  supabase,
  bucket,
  requestId,
  voiceProvider,
  text,
  language,
  speed,
  ledger,
  attempt,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  voiceProvider: VoiceProvider;
  text: string;
  language: ScriptLanguage;
  speed?: number;
  ledger?: PaidLedger;
  attempt?: number;
}): Promise<VoiceResult & { reused: boolean; key: string }> {
  const identity = voiceIdentityFor(voiceProvider, text, language, speed);
  const key = voiceCacheKey(identity);
  const recordPath = `${requestId}/state/voice/${key}.json`;
  const existing = await readJsonState<VoiceCacheRecord>(supabase, bucket, recordPath, "la narración guardada");

  if (existing.kind === "found") {
    const record = existing.data;
    if (record.status !== "completed") throw new VoiceCacheUncertainError(key, record.status);
    const { data, error } = await supabase.storage.from(bucket).download(record.audioPath!);
    if (error || !data) throw new StorageStateUnknownError("el audio de la narración guardada", error?.message ?? "vacío");
    const audioBuffer = Buffer.from(await data.arrayBuffer());
    if (sha256(audioBuffer) !== record.audioSha256) throw new VoiceCacheUncertainError(key, "completed con audio que no coincide");
    return {
      audioBuffer,
      durationSeconds: record.durationSeconds!,
      words: record.words!,
      mimeType: record.mimeType!,
      extension: record.extension!,
      reused: true,
      key,
    };
  }

  const baseRecord = {
    key,
    identity: { provider: identity.provider, voice: identity.voice, language: identity.language, speed: identity.speed, textSha256: sha256(text), characters: text.length },
  };
  const write = (status: VoiceCacheRecord["status"], extra: Partial<VoiceCacheRecord> = {}) =>
    writeJsonState(supabase, bucket, recordPath, { ...baseRecord, status, updatedAtIso: new Date().toISOString(), ...extra } satisfies VoiceCacheRecord);

  const call = async () => {
    try {
      await write("started");
    } catch (err) {
      throw new NotSentError(`No se pudo guardar el registro previo de la narración: ${err instanceof Error ? err.message : err}`);
    }
    return voiceProvider.synthesize(text, language, speed);
  };

  let voice: VoiceResult;
  try {
    voice = ledger
      ? await ledger.run(
          {
            key: `voice:${requestId}/${key}`,
            kind: speed === undefined ? "voice" : "voice_retime",
            provider: voiceProvider.name,
            reserveUsd: voiceProvider.name === "fixture" ? 0 : voiceReserveUsd(text.length),
            label: speed === undefined ? "narración" : `narración corregida (velocidad ${identity.speed})`,
            units: { characters: text.length },
          },
          async () => {
            const value = await call();
            return { value, settle: { actualUsd: voiceProvider.name === "fixture" ? 0 : voiceCostUsd(text.length), costBasis: "estimated" as const } };
          },
          classifyVoiceFailure,
          attempt,
        )
      : await call();
  } catch (err) {
    if (err instanceof NotSentError || classifyVoiceFailure(err) === "not_sent") {
      // Costo cero conocido: se borra el rastro «started» para permitir reintentar.
      await supabase.storage.from(bucket).remove([recordPath]).catch(() => {});
    }
    throw err;
  }

  const audioPath = `${requestId}/voice-cache/${key}.${voice.extension}`;
  try {
    await uploadWithRetry(supabase, bucket, audioPath, voice.audioBuffer, voice.mimeType);
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    await write("generated_unstored", { note }).catch(() => {});
    await ledger?.markResultLost(`voice:${requestId}/${key}`, `cobrada y no guardada: ${note}`).catch(() => {});
    throw new Error(`La narración (cobrada) no se pudo guardar: ${note}. No se volverá a sintetizar automáticamente.`);
  }
  await write("completed", {
    audioPath,
    audioSha256: sha256(voice.audioBuffer),
    mimeType: voice.mimeType,
    extension: voice.extension,
    durationSeconds: voice.durationSeconds,
    words: voice.words.map((w) => ({ text: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds })),
  }).catch((err) => {
    // El audio está guardado pero el registro no: el próximo intento verá «started» y se detendrá (conservador).
    console.warn("[atomivid:voice-cache] no se pudo cerrar el registro:", err instanceof Error ? err.message : err);
  });
  return { ...voice, reused: false, key };
}
