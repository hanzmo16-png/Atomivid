/**
 * Worker de «Texto a voz» (corre en GitHub Actions, workflow tts.yml).
 *
 * 1. Reclama la pieza con un UPDATE condicional (queued → processing,
 *    attempts + 1): dos disparos del mismo trabajo nunca corren a la vez.
 * 2. Vuelve a comprobar la voz (catálogo o «Mi voz» de la PROPIA dueña de
 *    la pieza): si se eliminó entre el envío y ahora, se detiene con el
 *    motivo. Nunca cambia de voz.
 * 3. Comprueba que a la cuenta de ElevenLabs le queden caracteres para lo
 *    que falta (consulta gratuita) antes de gastar nada.
 * 4. Sintetiza fragmento por fragmento con la caché de voz durable
 *    (voice-cache.ts) y el registro de gasto (paid-ledger.ts): un
 *    fragmento ya generado se reutiliza en un reintento, sin volver a
 *    cobrarse; uno en estado incierto (pudo cobrarse) detiene la pieza en
 *    vez de repetirlo.
 * 5. Une los fragmentos con sus pausas en un MP3, lo guarda y marca la
 *    pieza como completada (UPDATE condicional al mismo intento).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceProvider } from "@/lib/providers/types";
import { UncertainPaidOperationError, PaidBudgetExceededError, type PaidLedger } from "@/lib/video/audiovisual/paid-ledger";
import { openStorageLedger, voiceReserveUsd } from "@/lib/video/audiovisual/paid-costs";
import { synthesizeNarrationCached, VoiceCacheUncertainError } from "@/lib/video/audiovisual/voice-cache";
import { uploadWithRetry } from "@/lib/video/audiovisual/storage-state";
import { parseVoiceChoice } from "@/lib/voices/catalog";
import { resolveVoiceChoice, VoiceUnavailableError } from "@/lib/voices/resolve";
import { billableCharacters, segmentScript } from "./segment";
import type { ConcatPart } from "./concat";

export const TTS_BUCKET = "videos";

export type TtsJobRow = {
  id: string;
  user_id: string;
  title: string;
  language: "es" | "en";
  voice_choice: string;
  script: string;
  characters: number;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  segments_done: number | null;
};

export const ttsStoragePrefix = (jobId: string) => `tts/${jobId}`;
export const ttsAudioPath = (jobId: string) => `${ttsStoragePrefix(jobId)}/audio.mp3`;

/** Error con mensaje apto para la usuaria (se guarda tal cual en error_message). */
export class TtsJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsJobError";
  }
}

export type TtsDeps = {
  service: SupabaseClient;
  voiceProvider: VoiceProvider;
  concat: (parts: ConcatPart[]) => Promise<{ audio: Buffer; durationSeconds: number }>;
  /** Caracteres que le quedan a la cuenta del proveedor; null = no se pudo consultar. */
  quota: () => Promise<{ remaining: number } | null>;
  now?: () => Date;
};

/**
 * Traduce cualquier fallo a un mensaje para la usuaria, sin rutas internas
 * ni detalles del proveedor. `uncertainOpen`: el registro de gasto tiene un
 * fragmento que pudo cobrarse (timeout, 5xx, respuesta rota): entonces no
 * se promete que reintentar sea gratis.
 */
export function ttsFailureMessage(err: unknown, uncertainOpen = false): string {
  if (err instanceof TtsJobError || err instanceof VoiceUnavailableError) return err.message;
  if (uncertainOpen || err instanceof VoiceCacheUncertainError || err instanceof UncertainPaidOperationError) {
    return "Un fragmento quedó en un estado incierto (pudo haberse cobrado) y no se repetirá automáticamente para no cobrarlo dos veces. Escríbenos para revisarlo.";
  }
  if (err instanceof PaidBudgetExceededError) return "La pieza superó el gasto previsto y se detuvo. Escríbenos para revisarlo.";
  const message = err instanceof Error ? err.message : "";
  if (/ElevenLabs respondió 401/.test(message)) return "El servicio de voz rechazó la credencial. Escríbenos: no es un problema de tu texto.";
  if (/ElevenLabs respondió 429/.test(message)) return "El servicio de voz está saturado. Reintenta en unos minutos; lo ya generado se conserva.";
  if (/quota|ElevenLabs respondió 402/i.test(message)) return "El servicio de voz no tiene saldo suficiente en este momento. Escríbenos.";
  return "No se pudo completar el audio. Los fragmentos ya generados se conservan: puedes reintentar sin volver a pagarlos.";
}

export async function runTtsJob(jobId: string, deps: TtsDeps): Promise<"completed" | "skipped" | "failed"> {
  const { service } = deps;
  const read = await service
    .from("tts_jobs")
    .select("id, user_id, title, language, voice_choice, script, characters, status, attempts, segments_done")
    .eq("id", jobId)
    .maybeSingle<TtsJobRow>();
  if (read.error) throw new Error(`No se pudo leer la pieza: ${read.error.message}`);
  const row = read.data;
  if (!row || row.status !== "queued") return "skipped";

  const attempt = row.attempts + 1;
  const claim = await service
    .from("tts_jobs")
    .update({ status: "processing", attempts: attempt, error_message: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .eq("attempts", row.attempts)
    .select("id")
    .maybeSingle();
  if (claim.error || !claim.data) return "skipped";

  // Todas las escrituras posteriores exigen seguir siendo el mismo intento.
  const update = (values: Record<string, unknown>) =>
    service.from("tts_jobs").update({ ...values, updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "processing").eq("attempts", attempt);

  let ledger: PaidLedger | undefined;
  try {
    const choice = parseVoiceChoice(row.voice_choice);
    if (!choice) throw new TtsJobError("La voz guardada en esta pieza no es válida. Crea la pieza de nuevo eligiendo una voz.");
    const voice = await resolveVoiceChoice({ service, userId: row.user_id, choice, language: row.language });

    const segments = segmentScript(row.script);
    if (!segments.length) throw new TtsJobError("La pieza no tiene texto para narrar.");
    const characters = billableCharacters(segments);
    await update({ segments_total: segments.length });

    const pending = segments.slice(row.segments_done ?? 0);
    if (deps.voiceProvider.name !== "fixture") {
      const quota = await deps.quota();
      const needed = billableCharacters(pending);
      if (quota && quota.remaining < needed) {
        throw new TtsJobError("El servicio de voz no tiene caracteres suficientes este mes para terminar esta pieza. No se cobró nada de lo que falta; escríbenos.");
      }
    }

    // Tope = la reserva de todos los fragmentos (cada uno reserva su costo +20 %); nunca se amplía en un reintento.
    ledger = await openStorageLedger(service, TTS_BUCKET, ttsStoragePrefix(jobId), {
      capUsd: deps.voiceProvider.name === "fixture" ? 0 : voiceReserveUsd(characters) + 0.01,
    });

    const parts: ConcatPart[] = [];
    for (const segment of segments) {
      const result = await synthesizeNarrationCached({
        supabase: service,
        bucket: TTS_BUCKET,
        requestId: ttsStoragePrefix(jobId),
        voiceProvider: deps.voiceProvider,
        text: segment.text,
        language: row.language,
        ledger,
        attempt,
        voice,
        previousText: segment.previousText,
        nextText: segment.nextText,
      });
      parts.push({ audio: result.audioBuffer, extension: result.extension, pauseAfterMs: segment.pauseAfterMs });
      const progress = await update({ segments_done: segment.index + 1 }).select("id").maybeSingle();
      if (progress.error || !progress.data) throw new TtsJobError("La pieza cambió de estado mientras se generaba. No se repetirá automáticamente.");
    }

    const final = await deps.concat(parts);
    await uploadWithRetry(service, TTS_BUCKET, ttsAudioPath(jobId), final.audio, "audio/mpeg");
    const done = await update({
      status: "completed",
      audio_path: ttsAudioPath(jobId),
      duration_seconds: Math.round(final.durationSeconds * 10) / 10,
      completed_at: (deps.now?.() ?? new Date()).toISOString(),
      error_message: null,
    })
      .select("id")
      .maybeSingle();
    if (done.error || !done.data) throw new Error("No se pudo marcar la pieza como completada.");
    return "completed";
  } catch (err) {
    console.error(`[atomivid:tts] pieza ${jobId} intento ${attempt}:`, err instanceof Error ? err.message : err);
    const uncertainOpen = (ledger?.summary().openUncertainKeys.length ?? 0) > 0;
    await update({ status: "failed", error_message: ttsFailureMessage(err, uncertainOpen) });
    return "failed";
  }
}
