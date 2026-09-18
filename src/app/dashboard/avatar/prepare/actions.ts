"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { MAX_AVATAR_FORM_BYTES, RECORDING_BUCKET } from "@/lib/video/avatar/recording";
import { digest, prepareAvatarRequest } from "@/lib/video/avatar/preparation";

export type PreparationResult = { error?: string; saved?: boolean; requestId?: string; seconds?: number };

export async function saveAvatarPreparation(_previous: PreparationResult, form: FormData): Promise<PreparationResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) return { error: "Esta prueba privada no está disponible para tu cuenta." };
  const photo = form.get("photo"), audio = form.get("audio");
  if (!(photo instanceof File) || !(audio instanceof File) || !photo.size || !audio.size) return { error: "Selecciona tu fotografía y tu grabación." };
  if (photo.size + audio.size > MAX_AVATAR_FORM_BYTES) return { error: "Foto y audio deben pesar como máximo 3 MB en total." };
  if (form.get("consent") !== "on") return { error: "Confirma que la fotografía y la grabación son tuyas." };
  try {
    const result = await prepareAvatarRequest(createServiceClient(), user!.id, Buffer.from(await photo.arrayBuffer()), photo.type, Buffer.from(await audio.arrayBuffer()));
    return { saved: true, ...result };
  } catch {
    return { error: "No se pudo validar y asociar la preparación. Usa JPEG/PNG y audio válido de hasta 45 segundos. No se generó ningún video." };
  }
}

/** Connect an existing private preparation without re-uploading or calling providers. */
export async function connectSavedPreparation(_previous: PreparationResult, form: FormData): Promise<PreparationResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!canPrepareAvatar(user)) return { error: "Esta prueba privada no está disponible para tu cuenta." };
  const id = String(form.get("preparationId") ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) return { error: "Identificador de preparación inválido." };
  const prefix = `${user!.id}/preparations/${id}`;
  const service = createServiceClient(), bucket = service.storage.from(RECORDING_BUCKET);
  try {
    const { data, error } = await bucket.download(`${prefix}/manifest.json`);
    if (error || !data || data.size > 10000) throw new Error();
    const m = JSON.parse(await data.text());
    if (m.ownerId !== user!.id || m.consent !== true || !["jpeg", "png"].some(ext => m.photoPath === `${prefix}/photo.${ext}`) || !["m4a", "mp3", "wav"].some(ext => m.audioPath === `${prefix}/recording.${ext}`)) throw new Error();
    const [p, a] = await Promise.all([bucket.download(m.photoPath), bucket.download(m.audioPath)]);
    if (p.error || a.error || !p.data || !a.data || p.data.size + a.data.size > MAX_AVATAR_FORM_BYTES) throw new Error();
    const photo = Buffer.from(await p.data.arrayBuffer()), audio = Buffer.from(await a.data.arrayBuffer());
    if (digest(photo) !== m.photoSha256 || digest(audio) !== m.audioSha256) throw new Error();
    return { saved: true, ...await prepareAvatarRequest(service, user!.id, photo, m.photoPath.endsWith(".png") ? "image/png" : "image/jpeg", audio) };
  } catch {
    return { error: "No se pudo verificar esa preparación guardada. No se inició ninguna generación." };
  }
}
