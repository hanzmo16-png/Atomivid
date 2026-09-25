import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validatePhotoBuffer } from "./photo-validation";
import { measureNarrationSeconds } from "./measure-narration";
import { recordingFormat, recordingPath, RECORDING_BUCKET } from "./recording";
import { PREPARATION_MAX_SECONDS } from "./private-access";

/**
 * Límite legacy exclusivo de la prueba privada D-ID (/dashboard/avatar/
 * prepare) — ya no forma parte del flujo normal (RC mission Avatar,
 * 2026-09-25: ver ContentTypeStep, que ya no enlaza a esa página). Se
 * deja igual a como era para no cambiar el comportamiento de una ruta
 * que ningún usuario normal puede alcanzar; el flujo real usa
 * MAX_AVATAR_PHOTO_BYTES/MAX_RECORDING_BYTES en recording.ts.
 */
const LEGACY_AVATAR_TRIAL_MAX_COMBINED_BYTES = 3 * 1024 * 1024;

export const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function preparationId(userId: string, photo: Buffer, audio: Buffer, provider = "did"): string {
  const h = digest(Buffer.from(`${provider === "did" ? "avatar-preparation-v2" : "avatar-preparation-heygen-v1"}:${userId}:${digest(photo)}:${digest(audio)}`));
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

/** No provider imports, dispatch or generation. Repeated uploads reuse one request. */
export async function prepareAvatarRequest(service: SupabaseClient, userId: string, photo: Buffer, mime: string, audio: Buffer) {
  if (photo.length + audio.length > LEGACY_AVATAR_TRIAL_MAX_COMBINED_BYTES) throw new Error("Foto y audio superan 3 MB.");
  const check = validatePhotoBuffer(photo, mime);
  if (!check.valid) throw new Error("La fotografía no es válida.");
  if (check.format === "webp") throw new Error("Para el avatar usa una foto JPEG o PNG.");
  const format = recordingFormat(audio);
  const seconds = await measureNarrationSeconds(audio);
  if (seconds > PREPARATION_MAX_SECONDS) throw new Error("La grabación supera 45 segundos; no se ha recortado.");
  const id = preparationId(userId, photo, audio, "heygen");
  const photoPath = `${userId}/${id}/photo.${check.format}`;
  const audioPath = recordingPath(userId, id, format.extension);
  const bucket = service.storage.from(RECORDING_BUCKET);
  for (const [path, bytes, contentType] of [[photoPath, photo, mime], [audioPath, audio, format.mimeType]] as const) {
    // Duplicate-object conflicts are safe only after verifying the stored bytes.
    await bucket.upload(path, bytes, { contentType, upsert: false });
    const { data, error } = await bucket.download(path);
    if (error || !data || digest(Buffer.from(await data.arrayBuffer())) !== digest(bytes)) {
      throw new Error("No se pudo verificar la integridad de los archivos guardados.");
    }
  }
  // Decode the exact stored recording, not just browser metadata or input bytes.
  const { data: stored, error: storedError } = await bucket.download(audioPath);
  if (storedError || !stored) throw new Error("No se pudo verificar el audio guardado.");
  const storedSeconds = await measureNarrationSeconds(Buffer.from(await stored.arrayBuffer()));
  if (Math.abs(storedSeconds - seconds) > .001) throw new Error("La duración guardada no coincide.");
  const { error: avatarError } = await service.from("avatars").upsert({
    id, user_id: userId, name: "Avatar privado", provider: "heygen", status: "uploaded",
    source_photo_path: photoPath, consent_given: true, consent_given_at: new Date().toISOString(), consent_policy_version: "private-preparation-v2",
  }, { onConflict: "id", ignoreDuplicates: true });
  if (avatarError) throw new Error("No se pudo asociar la fotografía privada.");
  const { error: requestError } = await service.from("video_requests").upsert({
    id, user_id: userId, topic: "Avatar con grabación original", style: "Personal",
    duration_seconds: Math.ceil(seconds), language: "es", mode: "avatar", avatar_id: id,
    recorded_audio_path: audioPath, status: "script_ready", idempotency_key: `private-avatar:${id}`,
    // No fabricated transcript: the original recording is the narration source.
    script_json: { title: "Avatar con grabación original", segments: [] },
  }, { onConflict: "id", ignoreDuplicates: true });
  if (requestError) throw new Error("No se pudo crear la solicitud privada. No se inició generación.");
  const { data: request, error } = await service.from("video_requests").select("id, user_id, avatar_id, recorded_audio_path")
    .eq("id", id).eq("user_id", userId).single();
  if (error || request?.avatar_id !== id || request?.recorded_audio_path !== audioPath) throw new Error("No se pudo verificar la asociación de la solicitud.");
  return { requestId: id, seconds: storedSeconds };
}
