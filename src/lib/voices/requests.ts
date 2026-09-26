/**
 * «Mi voz» — crear, reintentar y eliminar voces privadas (SOLO servidor).
 * Toda operación comprueba la propiedad con el id de la sesión; enviar el
 * id de una voz ajena falla igual que enviar uno inexistente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { TTS_BUCKET } from "@/lib/tts/run-tts-job";
import { MAX_SAMPLE_BYTES, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, VOICE_CONSENT_VERSION, detectSampleFormat, samplePath, testAudioPath, validateVoiceName } from "./sample";

export const VOICE_BUCKET = TTS_BUCKET;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Estados que ocupan el cupo de voces de la usuaria (una fallida o eliminada no). */
export const ACTIVE_VOICE_STATUSES = ["uploaded", "cloning", "testing", "ready", "deleting"] as const;
export const VOICE_DISPATCH_FAILED_MESSAGE = "No se pudo poner en cola la clonación. No se envió nada: puedes reintentar.";

export type UserVoiceRecord = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  provider_voice_id: string | null;
  sample_path: string | null;
  test_audio_path: string | null;
  needs_review: boolean;
  attempts: number;
};

export async function createUserVoice(input: {
  service: SupabaseClient;
  userId: string;
  form: { name: unknown; consentOwnVoice: unknown; consentProcessing: unknown; keepSample: unknown; clientRequestId: unknown; clientSeconds: unknown; file: File | null };
  maxVoicesPerUser: number;
  dispatch: (voiceId: string) => Promise<void>;
}): Promise<{ ok: true; voiceId: string; duplicate: boolean } | { ok: false; error: string }> {
  const { service, userId, form } = input;
  const clientRequestId = typeof form.clientRequestId === "string" ? form.clientRequestId.trim().toLowerCase() : "";
  if (!UUID.test(clientRequestId)) return { ok: false, error: "Recarga la página e inténtalo de nuevo." };

  const existing = await service.from("user_voices").select("id").eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle<{ id: string }>();
  if (existing.error) return { ok: false, error: "No se pudo comprobar tu voz. Intenta de nuevo." };
  if (existing.data) return { ok: true, voiceId: existing.data.id, duplicate: true };

  const name = validateVoiceName(form.name);
  if (!name.ok) return name;
  if (form.consentOwnVoice !== "on" || form.consentProcessing !== "on") return { ok: false, error: "Para clonar una voz necesitas aceptar ambas declaraciones de consentimiento." };
  if (!form.file || form.file.size === 0) return { ok: false, error: "Graba o sube una muestra de voz." };
  if (form.file.size > MAX_SAMPLE_BYTES) return { ok: false, error: `La muestra supera ${MAX_SAMPLE_BYTES / 1024 / 1024} MB.` };
  // Duración medida por el navegador: solo un filtro temprano; el worker la vuelve a medir con ffprobe.
  const clientSeconds = Number(form.clientSeconds);
  if (Number.isFinite(clientSeconds) && clientSeconds > 0 && (clientSeconds < MIN_SAMPLE_SECONDS - 1 || clientSeconds > MAX_SAMPLE_SECONDS + 1)) {
    return { ok: false, error: `La muestra debe durar entre ${MIN_SAMPLE_SECONDS} s y ${MAX_SAMPLE_SECONDS / 60} min.` };
  }
  const bytes = new Uint8Array(await form.file.arrayBuffer());
  const format = detectSampleFormat(bytes);
  if (!format) return { ok: false, error: "Formato no reconocido. Usa MP3, M4A, WAV, WEBM u OGG." };

  const active = await service.from("user_voices").select("id").eq("user_id", userId).in("status", [...ACTIVE_VOICE_STATUSES]);
  if (active.error) return { ok: false, error: "No se pudo comprobar tus voces. Intenta de nuevo." };
  if ((active.data ?? []).length >= input.maxVoicesPerUser) {
    return { ok: false, error: input.maxVoicesPerUser === 1 ? "Ya tienes una voz propia. Elimínala para crear otra." : `Ya tienes ${input.maxVoicesPerUser} voces propias. Elimina una para crear otra.` };
  }

  const inserted = await service
    .from("user_voices")
    .insert({
      user_id: userId,
      client_request_id: clientRequestId,
      name: name.name,
      status: "uploaded",
      keep_sample: form.keepSample === "on",
      sample_bytes: bytes.length,
      consent_version: VOICE_CONSENT_VERSION,
      consent_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      const again = await service.from("user_voices").select("id").eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle<{ id: string }>();
      if (again.data) return { ok: true, voiceId: again.data.id, duplicate: true };
    }
    return { ok: false, error: "No se pudo guardar tu voz. Intenta de nuevo." };
  }
  const voiceId = inserted.data.id;
  const path = samplePath(userId, voiceId, format.extension);
  const upload = await service.storage.from(VOICE_BUCKET).upload(path, Buffer.from(bytes), { contentType: format.mimeType, upsert: true });
  if (upload.error) {
    await service.from("user_voices").update({ status: "failed", error_message: "No se pudo guardar la muestra. Elimina esta voz y vuelve a intentarlo.", updated_at: new Date().toISOString() }).eq("id", voiceId);
    return { ok: false, error: "No se pudo guardar la muestra. Intenta de nuevo." };
  }
  await service.from("user_voices").update({ sample_path: path, updated_at: new Date().toISOString() }).eq("id", voiceId);
  await dispatchOrFail(service, voiceId, "uploaded", input.dispatch);
  return { ok: true, voiceId, duplicate: false };
}

async function dispatchOrFail(service: SupabaseClient, voiceId: string, fromStatus: string, dispatch: (voiceId: string) => Promise<void>) {
  try {
    await dispatch(voiceId);
  } catch (err) {
    console.error(`[atomivid:my-voice] no se pudo encolar ${voiceId}:`, err instanceof Error ? err.message : err);
    await service
      .from("user_voices")
      .update({ status: "failed", error_message: VOICE_DISPATCH_FAILED_MESSAGE, updated_at: new Date().toISOString() })
      .eq("id", voiceId)
      .eq("status", fromStatus);
  }
}

async function loadOwn(service: SupabaseClient, userId: string, voiceId: unknown): Promise<UserVoiceRecord | null> {
  if (typeof voiceId !== "string" || !UUID.test(voiceId)) return null;
  const { data } = await service
    .from("user_voices")
    .select("id, user_id, name, status, provider_voice_id, sample_path, test_audio_path, needs_review, attempts")
    .eq("id", voiceId)
    .maybeSingle<UserVoiceRecord>();
  return data && data.user_id === userId ? data : null;
}

/**
 * Reintento de una voz fallida PROPIA. Sin voz en el proveedor vuelve a
 * clonar (si la muestra sigue guardada); con voz ya creada solo repite la
 * prueba corta. Una clonación incierta (needs_review) no se reintenta: pudo
 * haber creado una voz y ocupado un espacio.
 */
export async function retryUserVoice(input: { service: SupabaseClient; userId: string; voiceId: unknown; dispatch: (voiceId: string) => Promise<void> }) {
  const voice = await loadOwn(input.service, input.userId, input.voiceId);
  if (!voice || voice.status !== "failed") return { ok: false as const, error: "Esa voz no existe, no es tuya o no está fallida." };
  if (voice.needs_review) return { ok: false as const, error: "Esta voz está en revisión porque la clonación quedó en un estado incierto. Escríbenos." };
  if (!voice.provider_voice_id && !voice.sample_path) return { ok: false as const, error: "La muestra ya no está guardada. Elimina esta voz y crea otra." };
  const next = voice.provider_voice_id ? "testing" : "uploaded";
  const { data } = await input.service
    .from("user_voices")
    .update({ status: next, error_message: null, updated_at: new Date().toISOString() })
    .eq("id", voice.id)
    .eq("user_id", input.userId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (!data) return { ok: false as const, error: "No se pudo reintentar. Intenta de nuevo." };
  await dispatchOrFail(input.service, voice.id, next, input.dispatch);
  return { ok: true as const };
}

/**
 * Elimina una voz PROPIA: primero en el proveedor (si falla, la voz sigue
 * como estaba y se informa), después la muestra y la prueba guardadas. Los
 * audios y videos ya generados con ella NO se tocan: son archivos propios.
 * Una pieza pendiente que la use se detendrá con el motivo.
 */
export async function deleteUserVoice(input: {
  service: SupabaseClient;
  userId: string;
  voiceId: unknown;
  deleteProviderVoice: (providerVoiceId: string) => Promise<"deleted" | "not_found">;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const voice = await loadOwn(input.service, input.userId, input.voiceId);
  if (!voice || voice.status === "deleted") return { ok: false, error: "Esa voz no existe o no es tuya." };
  if (voice.status === "cloning" || voice.status === "testing") return { ok: false, error: "Espera a que termine la clonación para eliminarla." };
  const previous = voice.status;
  const claim = await input.service
    .from("user_voices")
    .update({ status: "deleting", updated_at: new Date().toISOString() })
    .eq("id", voice.id)
    .eq("user_id", input.userId)
    .eq("status", previous)
    .select("id")
    .maybeSingle();
  if (!claim.data) return { ok: false, error: "La voz cambió de estado. Recarga la página." };

  if (voice.provider_voice_id) {
    try {
      await input.deleteProviderVoice(voice.provider_voice_id);
    } catch (err) {
      console.error(`[atomivid:my-voice] no se pudo eliminar ${voice.id} en el proveedor:`, err instanceof Error ? err.message : err);
      await input.service.from("user_voices").update({ status: previous, updated_at: new Date().toISOString() }).eq("id", voice.id).eq("status", "deleting");
      return { ok: false, error: "No se pudo eliminar la voz en el servicio de voz. No se borró nada; intenta de nuevo." };
    }
  }
  const files = [voice.sample_path, voice.test_audio_path].filter((p): p is string => Boolean(p));
  if (files.length) await input.service.storage.from(VOICE_BUCKET).remove(files);
  await input.service
    .from("user_voices")
    .update({ status: "deleted", deleted_at: new Date().toISOString(), sample_path: null, test_audio_path: null, updated_at: new Date().toISOString() })
    .eq("id", voice.id)
    .eq("status", "deleting");
  return { ok: true };
}

export { samplePath, testAudioPath };
