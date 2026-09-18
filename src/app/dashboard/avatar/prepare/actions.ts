"use server";

import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { validatePhotoBuffer } from "@/lib/video/avatar/photo-validation";
import { recordingFormat, MAX_AVATAR_FORM_BYTES, RECORDING_BUCKET } from "@/lib/video/avatar/recording";

export type PreparationResult = { error?: string; saved?: boolean };

/** Saves private source bytes only. Never creates requests, jobs or provider uploads. */
export async function saveAvatarPreparation(_previous: PreparationResult, form: FormData): Promise<PreparationResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) return { error: "Esta prueba privada no está disponible para tu cuenta." };
  const photo = form.get("photo");
  const audio = form.get("audio");
  if (!(photo instanceof File) || !(audio instanceof File) || !photo.size || !audio.size) {
    return { error: "Selecciona tu fotografía y tu grabación." };
  }
  if (photo.size + audio.size > MAX_AVATAR_FORM_BYTES) return { error: "Foto y audio deben pesar como máximo 3 MB en total." };
  if (form.get("consent") !== "on") return { error: "Confirma que la fotografía y la grabación son tuyas." };
  const photoBytes = Buffer.from(await photo.arrayBuffer());
  const photoCheck = validatePhotoBuffer(photoBytes, photo.type);
  if (!photoCheck.valid) return { error: photoCheck.reason };
  const audioBytes = Buffer.from(await audio.arrayBuffer());
  let audioFormat: ReturnType<typeof recordingFormat>;
  try { audioFormat = recordingFormat(audioBytes); }
  catch { return { error: "Audio no reconocido. Usa M4A, MP3 o WAV." }; }
  const prefix = `${user!.id}/preparations/${randomUUID()}`;
  const photoPath = `${prefix}/photo.${photoCheck.format}`;
  const audioPath = `${prefix}/recording.${audioFormat.extension}`;
  const bucket = createServiceClient().storage.from(RECORDING_BUCKET);
  const savedPaths: string[] = [];
  try {
    for (const [path, bytes, contentType] of [
      [photoPath, photoBytes, photo.type],
      [audioPath, audioBytes, audioFormat.mimeType],
      [`${prefix}/manifest.json`, Buffer.from(JSON.stringify({
        version: 1, ownerId: user!.id, photoPath, audioPath,
        photoSha256: createHash("sha256").update(photoBytes).digest("hex"),
        audioSha256: createHash("sha256").update(audioBytes).digest("hex"),
        createdAt: new Date().toISOString(), consent: true,
        generationAuthorized: false, durationVerified: false,
      })), "application/json"],
    ] as const) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
      if (error) throw error;
      savedPaths.push(path);
    }
  } catch {
    if (savedPaths.length) await bucket.remove(savedPaths).catch(() => {});
    return { error: "No se pudieron guardar los archivos. Inténtalo de nuevo." };
  }
  return { saved: true };
}
