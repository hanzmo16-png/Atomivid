/**
 * Worker de «Texto a voz» (corre en GitHub Actions, workflow tts.yml).
 *
 * Narración (pieza «en cola»):
 * 1. Reclama la pieza con un UPDATE condicional (queued → processing,
 *    attempts + 1): dos disparos del mismo trabajo nunca corren a la vez.
 * 2. Vuelve a comprobar la voz (catálogo o «Mi voz» de la PROPIA dueña de
 *    la pieza): si se eliminó entre el envío y ahora, se detiene con el
 *    motivo. Nunca cambia de voz.
 * 3. Antes de gastar: saldo del proveedor (consulta gratuita) menos las
 *    otras piezas en curso. Un episodio largo (piloto) además deja libre una
 *    reserva para Reel, Avatar y Long Form, no empieza si hay videos
 *    generándose (usan la misma cuenta y no reservan caracteres) y vuelve a
 *    comprobar el saldo cada pocos fragmentos: si bajó, se detiene ANTES de
 *    agotarlo.
 * 4. Sintetiza fragmento por fragmento con la caché de voz durable
 *    (voice-cache.ts) y el registro de gasto (paid-ledger.ts): un
 *    fragmento ya generado se reutiliza al reanudar, sin volver a cobrarse;
 *    uno en estado incierto (pudo cobrarse) detiene la pieza en vez de
 *    repetirlo.
 * 5. Presupuesto de tiempo: entre fragmentos, si no queda tiempo para el
 *    siguiente (o para unir), se detiene limpiamente como «pausada»; al
 *    reanudar sigue donde quedó. Nunca se corta a mitad de una llamada.
 * 6. Une, masteriza y guarda la narración (narracion.mp3).
 *
 * Mezcla (si la pieza tiene música, en la misma ejecución o al pedir otro
 * acompañamiento): estado propio (mix_status) con su propio reclamo; usa la
 * narración guardada —nunca vuelve a sintetizar— y si falla, la narración
 * queda intacta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceProvider } from "@/lib/providers/types";
import { UncertainPaidOperationError, PaidBudgetExceededError, type PaidLedger } from "@/lib/video/audiovisual/paid-ledger";
import { openStorageLedger, voiceReserveUsd } from "@/lib/video/audiovisual/paid-costs";
import { synthesizeNarrationCached, VoiceCacheUncertainError } from "@/lib/video/audiovisual/voice-cache";
import { uploadWithRetry } from "@/lib/video/audiovisual/storage-state";
import { parseVoiceChoice } from "@/lib/voices/catalog";
import { resolveVoiceChoice, VoiceUnavailableError } from "@/lib/voices/resolve";
import { billableCharacters, formatCount, segmentScript } from "./segment";
import { DEFAULT_PROVIDER_RESERVE_CHARS, providerHasRoom, reservedByOthers } from "./limits";
import { findMusicBed, pickMusicBed, type MusicBed, type MusicChoice } from "./music-beds";
import type { ConcatPart, LoudnessSummary } from "./concat";

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
  long_pilot: boolean | null;
  music_choice: MusicChoice | null;
  music_track_id: string | null;
  mix_status: "pending" | "processing" | "completed" | "failed" | null;
  mix_attempts: number | null;
  audio_path: string | null;
};

const JOB_COLUMNS =
  "id, user_id, title, language, voice_choice, script, characters, status, attempts, segments_done, long_pilot, music_choice, music_track_id, mix_status, mix_attempts, audio_path";

export const ttsStoragePrefix = (jobId: string) => `tts/${jobId}`;
/** Narración de piezas nuevas (las anteriores conservan su audio_path «audio.mp3»). */
export const ttsAudioPath = (jobId: string) => `${ttsStoragePrefix(jobId)}/narracion.mp3`;
export const ttsMixPath = (jobId: string) => `${ttsStoragePrefix(jobId)}/podcast-con-musica.mp3`;

/** Cada cuántos fragmentos sintetizados un episodio largo vuelve a consultar el saldo del proveedor. */
export const LONG_QUOTA_RECHECK_EVERY = 8;

/** Error con mensaje apto para la usuaria (se guarda tal cual en error_message). */
export class TtsJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsJobError";
  }
}

/** Parada limpia por tiempo: lo generado queda guardado y «Reanudar» sigue desde ahí. */
export class TtsPausedError extends TtsJobError {
  constructor(done: number, total: number) {
    super(`Se generaron ${done} de ${total} fragmentos en esta ejecución. Pulsa «Reanudar» para continuar: lo ya generado se conserva y no se vuelve a cobrar.`);
    this.name = "TtsPausedError";
  }
}

export type TtsMixResult = { audio: Buffer; durationSeconds: number; loudness: LoudnessSummary };

export type TtsDeps = {
  service: SupabaseClient;
  voiceProvider: VoiceProvider;
  concat: (parts: ConcatPart[]) => Promise<{ audio: Buffer; durationSeconds: number; loudness?: LoudnessSummary }>;
  mix?: (input: { narration: Buffer; bed: MusicBed }) => Promise<TtsMixResult>;
  /** Caracteres que le quedan a la cuenta del proveedor; null = no se pudo consultar. */
  quota: () => Promise<{ remaining: number } | null>;
  /** Videos (Reel, Avatar, Long Form) generándose ahora; null = no se pudo consultar. Solo para episodios largos. */
  otherVoiceWork?: () => Promise<number | null>;
  /** Reserva para el resto del producto (episodios largos). */
  providerReserveChars?: number;
  /** Momento límite (ms desde epoch) para empezar trabajo nuevo en esta ejecución. */
  deadlineMs?: number;
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
  // El saldo agotado llega como 401 con «quota_exceeded» (o 402): se reconoce ANTES que la credencial para no confundirlos.
  if (/quota|ElevenLabs respondió 402/i.test(message)) {
    return "El servicio de voz se quedó sin caracteres mientras se generaba (la cuenta es compartida con el resto de Atomivid). Lo ya generado se conserva y «Reanudar» no lo vuelve a cobrar cuando haya saldo.";
  }
  if (/ElevenLabs respondió 401/.test(message)) return "El servicio de voz rechazó la credencial. Escríbenos: no es un problema de tu texto.";
  if (/ElevenLabs respondió 429/.test(message)) return "El servicio de voz está saturado. Reintenta en unos minutos; lo ya generado se conserva.";
  return "No se pudo completar el audio. Los fragmentos ya generados se conservan: puedes reintentar sin volver a pagarlos.";
}

export const MIX_FAILED_MESSAGE = "No se pudo preparar la versión con música. La narración está lista y se conserva; puedes reintentar la mezcla sin volver a generar la voz.";
export const MIX_NO_TIME_MESSAGE = "La versión con música no alcanzó a prepararse en esta ejecución. La narración está lista; pulsa «Preparar mezcla» (no se vuelve a generar la voz).";

/**
 * Segundos estimados de trabajo local (unir y masterizar, o mezclar y
 * masterizar) para `audioSeconds` de audio, con margen. Medido en la
 * validación local de 45 min (scripts/podcast-local-validation.ts): unir y
 * masterizar ≈ 107 s, mezclar y masterizar ≈ 207 s → 0,1 s por segundo de
 * audio + 30 s cubre ambos.
 */
export function assemblySecondsEstimate(audioSeconds: number): number {
  return 30 + audioSeconds * 0.1;
}

export async function runTtsJob(jobId: string, deps: TtsDeps): Promise<"completed" | "skipped" | "failed" | "paused"> {
  const { service } = deps;
  const read = await service.from("tts_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle<TtsJobRow>();
  if (read.error) throw new Error(`No se pudo leer la pieza: ${read.error.message}`);
  const row = read.data;
  if (!row) return "skipped";
  if (row.status === "completed" && row.mix_status === "pending") return runMixPhase(row, deps);
  if (row.status !== "queued") return "skipped";

  const narration = await runNarrationPhase(row, deps);
  if (narration.result !== "completed") return narration.result;
  if ((row.music_choice ?? "none") === "none") return "completed";
  const fresh = await service.from("tts_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle<TtsJobRow>();
  if (fresh.error || !fresh.data || fresh.data.mix_status !== "pending") return "completed";
  const mixed = await runMixPhase(fresh.data, deps, narration.durationSeconds);
  return mixed === "skipped" ? "completed" : mixed;
}

async function runNarrationPhase(row: TtsJobRow, deps: TtsDeps): Promise<{ result: "completed" | "skipped" | "failed" | "paused"; durationSeconds?: number }> {
  const { service } = deps;
  const jobId = row.id;
  const now = () => (deps.now?.() ?? new Date()).getTime();
  const attempt = row.attempts + 1;
  const claim = await service
    .from("tts_jobs")
    .update({ status: "processing", attempts: attempt, error_message: null, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .eq("attempts", row.attempts)
    .select("id")
    .maybeSingle();
  if (claim.error || !claim.data) return { result: "skipped" };

  // Todas las escrituras posteriores exigen seguir siendo el mismo intento.
  const update = (values: Record<string, unknown>) =>
    service.from("tts_jobs").update({ ...values, updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "processing").eq("attempts", attempt);

  const long = Boolean(row.long_pilot);
  const reserve = long ? (deps.providerReserveChars ?? DEFAULT_PROVIDER_RESERVE_CHARS) : 0;
  let ledger: PaidLedger | undefined;
  try {
    const choice = parseVoiceChoice(row.voice_choice);
    if (!choice) throw new TtsJobError("La voz guardada en esta pieza no es válida. Crea la pieza de nuevo eligiendo una voz.");
    const voice = await resolveVoiceChoice({ service, userId: row.user_id, choice, language: row.language });

    const segments = segmentScript(row.script);
    if (!segments.length) throw new TtsJobError("La pieza no tiene texto para narrar.");
    const characters = billableCharacters(segments);
    await update({ segments_total: segments.length });

    const real = deps.voiceProvider.name !== "fixture";
    const othersInFlight = async () => {
      const others = await service.from("tts_jobs").select("id, characters").eq("status", "processing").neq("id", jobId);
      if (others.error) throw new TtsJobError("No se pudo comprobar la capacidad del servicio de voz. Reintenta en unos minutos; no se cobró nada.");
      return reservedByOthers((others.data ?? []) as { characters: number }[]);
    };
    const checkRoom = async (needed: number, midway: boolean) => {
      const quota = await deps.quota();
      if (!quota) throw new TtsJobError("No se pudo comprobar la capacidad del servicio de voz. Reintenta en unos minutos; no se cobró nada de lo que falta.");
      // Otras piezas en curso ya pudieron comprobar el mismo saldo: se descuentan (conservador).
      const othersReserved = await othersInFlight();
      if (!providerHasRoom({ remaining: quota.remaining, needed, othersReserved, reserve })) {
        const available = Math.max(0, quota.remaining - othersReserved - reserve);
        const detail = `Faltan ${formatCount(needed)} caracteres y hay ${formatCount(available)} disponibles${
          reserve ? ` (saldo ${formatCount(quota.remaining)}, menos ${formatCount(reserve)} reservados para el resto de Atomivid${othersReserved ? ` y ${formatCount(othersReserved)} de otras piezas en curso` : ""})` : ""
        }.`;
        throw new TtsJobError(
          midway
            ? `El saldo del servicio de voz bajó mientras se generaba (otras funciones usan la misma cuenta). ${detail} Se detuvo antes de agotarlo: lo generado se conserva y «Reanudar» no lo vuelve a cobrar.`
            : `El servicio de voz no tiene caracteres suficientes para terminar esta pieza. ${detail} No se cobró nada de lo que falta; puedes reanudarla cuando haya saldo.`,
        );
      }
    };

    const pending = segments.slice(row.segments_done ?? 0);
    if (real) {
      if (long) {
        const busy = deps.otherVoiceWork ? await deps.otherVoiceWork() : null;
        if (busy === null) throw new TtsJobError("No se pudo comprobar si hay videos generándose. Reintenta en unos minutos; no se cobró nada.");
        if (busy > 0) throw new TtsJobError("Hay videos generándose ahora mismo y usan la misma cuenta de voz. Reintenta cuando terminen; no se cobró nada de lo que falta.");
      }
      await checkRoom(billableCharacters(pending), false);
    }

    // Tope = la reserva de todos los fragmentos (cada uno reserva su costo +20 %); nunca se amplía en un reintento.
    ledger = await openStorageLedger(service, TTS_BUCKET, ttsStoragePrefix(jobId), {
      capUsd: real ? voiceReserveUsd(characters) + 0.01 : 0,
    });

    const parts: ConcatPart[] = [];
    let synthesized = 0;
    let slowestMs = 0;
    for (const segment of segments) {
      const remainingChars = billableCharacters(segments.slice(segment.index));
      if (deps.deadlineMs !== undefined && segment.index > (row.segments_done ?? 0)) {
        const nextMs = Math.max(20_000, slowestMs * 1.5);
        if (now() + nextMs > deps.deadlineMs) throw new TtsPausedError(segment.index, segments.length);
      }
      if (real && long && synthesized > 0 && synthesized % LONG_QUOTA_RECHECK_EVERY === 0) await checkRoom(remainingChars, true);
      const started = now();
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
      if (!result.reused) {
        synthesized += 1;
        slowestMs = Math.max(slowestMs, now() - started);
      }
      parts.push({ audio: result.audioBuffer, extension: result.extension, pauseAfterMs: segment.pauseAfterMs });
      const progress = await update({ segments_done: segment.index + 1 }).select("id").maybeSingle();
      if (progress.error || !progress.data) throw new TtsJobError("La pieza cambió de estado mientras se generaba. No se repetirá automáticamente.");
    }

    const estimatedAudio = parts.reduce((sum, p) => sum + p.pauseAfterMs / 1000, 0) + billableCharacters(segments) / 12;
    // Solo se pausa antes de unir si esta ejecución sintetizó algo: una reanudación que ya solo tiene que unir,
    // une (si no, volvería a pausarse siempre); el timeout del workflow y mark-tts-failed la protegen.
    if (deps.deadlineMs !== undefined && synthesized > 0 && now() + assemblySecondsEstimate(estimatedAudio) * 1000 > deps.deadlineMs) {
      throw new TtsPausedError(segments.length, segments.length);
    }
    const final = await deps.concat(parts);
    await uploadWithRetry(service, TTS_BUCKET, ttsAudioPath(jobId), final.audio, "audio/mpeg");
    const done = await update({
      status: "completed",
      audio_path: ttsAudioPath(jobId),
      duration_seconds: Math.round(final.durationSeconds * 10) / 10,
      narration_loudness: final.loudness ?? null,
      completed_at: (deps.now?.() ?? new Date()).toISOString(),
      error_message: null,
    })
      .select("id")
      .maybeSingle();
    if (done.error || !done.data) throw new Error("No se pudo marcar la pieza como completada.");
    return { result: "completed", durationSeconds: final.durationSeconds };
  } catch (err) {
    const paused = err instanceof TtsPausedError;
    if (!paused) console.error(`[atomivid:tts] pieza ${jobId} intento ${attempt}:`, err instanceof Error ? err.message : err);
    const uncertainOpen = (ledger?.summary().openUncertainKeys.length ?? 0) > 0;
    await update({ status: "failed", error_message: ttsFailureMessage(err, uncertainOpen) });
    return { result: paused ? "paused" : "failed" };
  }
}

/**
 * Mezcla con música a partir de la narración YA guardada (no sintetiza).
 * Reclamo propio: mix_status pending → processing, mix_attempts + 1.
 */
async function runMixPhase(row: TtsJobRow, deps: TtsDeps, knownNarrationSeconds?: number): Promise<"completed" | "skipped" | "failed"> {
  const { service } = deps;
  const music = row.music_choice ?? "none";
  if (music === "none" || !row.audio_path) return "skipped";
  const attempt = (row.mix_attempts ?? 0) + 1;
  const claim = await service
    .from("tts_jobs")
    .update({ mix_status: "processing", mix_attempts: attempt, mix_error: null, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "completed")
    .eq("mix_status", "pending")
    .eq("mix_attempts", row.mix_attempts ?? 0)
    .select("id")
    .maybeSingle();
  if (claim.error || !claim.data) return "skipped";
  const update = (values: Record<string, unknown>) =>
    service.from("tts_jobs").update({ ...values, updated_at: new Date().toISOString() }).eq("id", row.id).eq("mix_status", "processing").eq("mix_attempts", attempt);

  try {
    if (!deps.mix) throw new Error("Mezcla no disponible en este worker.");
    const now = (deps.now?.() ?? new Date()).getTime();
    if (deps.deadlineMs !== undefined && knownNarrationSeconds !== undefined && now + assemblySecondsEstimate(knownNarrationSeconds) * 1000 > deps.deadlineMs) {
      await update({ mix_status: "failed", mix_error: MIX_NO_TIME_MESSAGE });
      return "failed";
    }
    // El mismo fondo en cada reintento; si cambió el acompañamiento, otro del nuevo estado de ánimo.
    const saved = findMusicBed(row.music_track_id);
    const bed = saved && saved.mood === music ? saved : pickMusicBed(music, row.id);
    const { data, error } = await service.storage.from(TTS_BUCKET).download(row.audio_path);
    if (error || !data) throw new Error(`No se pudo leer la narración: ${error?.message ?? "vacía"}`);
    const narration = Buffer.from(await data.arrayBuffer());
    const mixed = await deps.mix({ narration, bed });
    await uploadWithRetry(service, TTS_BUCKET, ttsMixPath(row.id), mixed.audio, "audio/mpeg");
    const done = await update({
      mix_status: "completed",
      mix_path: ttsMixPath(row.id),
      mix_duration_seconds: Math.round(mixed.durationSeconds * 10) / 10,
      mix_loudness: mixed.loudness,
      music_track_id: bed.id,
      mix_error: null,
    })
      .select("id")
      .maybeSingle();
    if (done.error || !done.data) throw new Error("No se pudo marcar la mezcla como lista.");
    return "completed";
  } catch (err) {
    console.error(`[atomivid:tts] mezcla ${row.id} intento ${attempt}:`, err instanceof Error ? err.message : err);
    await update({ mix_status: "failed", mix_error: MIX_FAILED_MESSAGE });
    return "failed";
  }
}
