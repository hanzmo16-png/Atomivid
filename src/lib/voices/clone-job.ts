/**
 * Worker de «Mi voz» (workflow voice-clone.yml).
 *
 *  uploaded → cloning → testing → ready     (primer intento)
 *  testing  → testing → ready               (reintento de la prueba; la voz ya existe)
 *
 * - Reclamo condicional por (estado, attempts): dos disparos no clonan dos veces.
 * - La duración se mide aquí con ffprobe (la del navegador es solo un aviso).
 * - Antes de clonar se comprueba que la cuenta tenga un espacio libre.
 * - Clonación: un error HTTP = no se creó nada (se puede reintentar); un
 *   fallo de red o una respuesta rota = INCIERTO: pudo crearse una voz y
 *   ocupar un espacio, así que queda needs_review y no se repite sola.
 * - El voice_id se guarda en cuanto existe; la prueba corta pasa por la
 *   caché de voz y el registro de gasto (como cualquier narración).
 * - La muestra original se borra al terminar salvo que la usuaria pidiera
 *   conservarla; si algo falla, se conserva para poder reintentar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceProvider } from "@/lib/providers/types";
import { classifyVoiceFailure, openStorageLedger, voiceReserveUsd } from "@/lib/video/audiovisual/paid-costs";
import { synthesizeNarrationCached, VoiceCacheUncertainError } from "@/lib/video/audiovisual/voice-cache";
import { UncertainPaidOperationError } from "@/lib/video/audiovisual/paid-ledger";
import { uploadWithRetry } from "@/lib/video/audiovisual/storage-state";
import { checkUserVoice } from "./resolve";
import { VOICE_BUCKET } from "./requests";
import { VOICE_TEST_TEXT, sampleDurationIssue, testAudioPath, userVoicePrefix } from "./sample";

type Row = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  provider_voice_id: string | null;
  sample_path: string | null;
  keep_sample: boolean;
  attempts: number;
  deleted_at: string | null;
};

export class VoiceCloneError extends Error {
  constructor(message: string, readonly needsReview = false) {
    super(message);
    this.name = "VoiceCloneError";
  }
}

export type CloneDeps = {
  service: SupabaseClient;
  voiceProvider: VoiceProvider;
  /** Convierte la muestra a MP3 mono y mide su duración (ffmpeg/ffprobe). */
  prepareSample: (audio: Buffer, extension: string) => Promise<{ audio: Buffer; durationSeconds: number }>;
  slots: () => Promise<{ used: number; limit: number } | null>;
  clone: (input: { name: string; description: string; audio: Buffer; filename: string; mimeType: string }) => Promise<string>;
};

export async function runVoiceCloneJob(voiceId: string, deps: CloneDeps): Promise<"ready" | "skipped" | "failed"> {
  const { service } = deps;
  const read = await service
    .from("user_voices")
    .select("id, user_id, name, status, provider_voice_id, sample_path, keep_sample, attempts, deleted_at")
    .eq("id", voiceId)
    .maybeSingle<Row>();
  if (read.error) throw new Error(`No se pudo leer la voz: ${read.error.message}`);
  const row = read.data;
  if (!row || row.deleted_at) return "skipped";
  const fromUploaded = row.status === "uploaded";
  const retestOnly = row.status === "testing" && Boolean(row.provider_voice_id);
  if (!fromUploaded && !retestOnly) return "skipped";

  const attempt = row.attempts + 1;
  const claimed = await service
    .from("user_voices")
    .update({ status: fromUploaded ? "cloning" : "testing", attempts: attempt, error_message: null, updated_at: new Date().toISOString() })
    .eq("id", voiceId)
    .eq("status", row.status)
    .eq("attempts", row.attempts)
    .select("id")
    .maybeSingle();
  if (claimed.error || !claimed.data) return "skipped";
  const update = (values: Record<string, unknown>) =>
    service.from("user_voices").update({ ...values, updated_at: new Date().toISOString() }).eq("id", voiceId).eq("attempts", attempt);

  try {
    let providerVoiceId = row.provider_voice_id;
    if (fromUploaded) {
      if (!row.sample_path) throw new VoiceCloneError("La muestra ya no está guardada. Elimina esta voz y crea otra.");
      const download = await service.storage.from(VOICE_BUCKET).download(row.sample_path);
      if (download.error || !download.data) throw new VoiceCloneError("No se pudo leer la muestra guardada. Reintenta en unos minutos.");
      const extension = row.sample_path.split(".").pop() ?? "mp3";
      let prepared: { audio: Buffer; durationSeconds: number };
      try {
        prepared = await deps.prepareSample(Buffer.from(await download.data.arrayBuffer()), extension);
      } catch {
        throw new VoiceCloneError("No se pudo leer el audio de la muestra. Prueba con otro archivo o graba de nuevo.");
      }
      const issue = sampleDurationIssue(prepared.durationSeconds);
      if (issue) throw new VoiceCloneError(`${issue} Elimina esta voz y crea otra con una muestra válida.`);
      await update({ sample_seconds: Math.round(prepared.durationSeconds * 10) / 10 });

      if (deps.voiceProvider.name !== "fixture") {
        const slots = await deps.slots();
        if (!slots) throw new VoiceCloneError("No se pudo comprobar la capacidad del servicio de voz. Reintenta en unos minutos.");
        if (slots.used >= slots.limit) throw new VoiceCloneError("El servicio de voz no tiene espacios de clonación libres en este momento. No se envió tu muestra; escríbenos.");
      }

      try {
        // Nombre neutro en el proveedor: nunca el nombre ni el correo de la usuaria.
        providerVoiceId = await deps.clone({
          name: `Atomivid ${voiceId.slice(0, 8)}`,
          description: "Voz privada de una usuaria de Atomivid (clonación instantánea con consentimiento).",
          audio: prepared.audio,
          filename: "sample.mp3",
          mimeType: "audio/mpeg",
        });
      } catch (err) {
        if (classifyVoiceFailure(err) === "uncertain") {
          throw new VoiceCloneError("La clonación quedó en un estado incierto (pudo crearse la voz). No se repetirá automáticamente; la revisaremos.", true);
        }
        const message = err instanceof Error ? err.message : "";
        if (/verif/i.test(message)) throw new VoiceCloneError("El servicio de voz pidió una verificación adicional para esta muestra. No se creó la voz; escríbenos.");
        throw new VoiceCloneError("El servicio de voz rechazó la muestra y no creó la voz. Prueba con otra grabación más clara (sin música ni otras voces).");
      }
      const saved = await update({ provider_voice_id: providerVoiceId, status: "testing" }).select("id").maybeSingle();
      if (saved.error || !saved.data) {
        // La voz existe en el proveedor pero no quedó registrada: nunca repetir la clonación.
        console.error(`[atomivid:my-voice] voz ${voiceId} creada (${providerVoiceId}) sin poder guardarla`);
        throw new VoiceCloneError("La voz se creó pero no se pudo registrar. La revisaremos.", true);
      }
    }

    // Prueba corta con el mismo camino de síntesis (y propiedad comprobada) que cualquier narración.
    const voice = checkUserVoice({ id: row.id, user_id: row.user_id, name: row.name, status: "ready", provider_voice_id: providerVoiceId, deleted_at: null }, row.user_id);
    const prefix = userVoicePrefix(row.user_id, voiceId);
    const ledger = await openStorageLedger(service, VOICE_BUCKET, prefix, {
      capUsd: deps.voiceProvider.name === "fixture" ? 0 : voiceReserveUsd(VOICE_TEST_TEXT.length) * 2 + 0.01,
    });
    const test = await synthesizeNarrationCached({ supabase: service, bucket: VOICE_BUCKET, requestId: prefix, voiceProvider: deps.voiceProvider, text: VOICE_TEST_TEXT, language: "es", ledger, attempt, voice });
    const testPath = testAudioPath(row.user_id, voiceId).replace(/\.mp3$/, `.${test.extension}`);
    await uploadWithRetry(service, VOICE_BUCKET, testPath, test.audioBuffer, test.mimeType);

    const keep = row.keep_sample;
    const done = await update({ status: "ready", test_audio_path: testPath, error_message: null, ...(keep ? {} : { sample_path: null }) })
      .select("id")
      .maybeSingle();
    if (done.error || !done.data) throw new Error("No se pudo marcar la voz como lista.");
    if (!keep && row.sample_path) await service.storage.from(VOICE_BUCKET).remove([row.sample_path]).catch(() => {});
    return "ready";
  } catch (err) {
    console.error(`[atomivid:my-voice] voz ${voiceId} intento ${attempt}:`, err instanceof Error ? err.message : err);
    const safe = err instanceof VoiceCloneError;
    // La prueba corta también puede quedar incierta (pudo cobrarse): no se repite sola.
    const uncertainTest = err instanceof VoiceCacheUncertainError || err instanceof UncertainPaidOperationError || (!safe && classifyVoiceFailure(err) === "uncertain" && /ElevenLabs|fetch/i.test(String(err)));
    await update({
      status: "failed",
      needs_review: (safe && err.needsReview) || uncertainTest,
      error_message: safe
        ? err.message
        : uncertainTest
          ? "La prueba de tu voz quedó en un estado incierto. No se repetirá automáticamente; la revisaremos."
          : "No se pudo terminar la prueba de tu voz. Puedes reintentar.",
    });
    return "failed";
  }
}
