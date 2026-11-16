import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { canAccessAudioStudio } from "./access";
import { AUDIO_STUDIO_BUCKET, storageStore, type BlobStore, type ProjectStore } from "./store";
import type { Deps } from "./service";
import { voiceAvailability, type VoiceAvailability } from "./voice";

export type StudioUser = { id: string; owner: boolean };

/** Cuenta autenticada con acceso al estudio, o el error HTTP que corresponde. */
export async function audioStudioUser(): Promise<StudioUser | { error: string; status: number }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "No autenticado", status: 401 };
  if (!canAccessAudioStudio(user)) return { error: "Audio Podcast Studio no está disponible para tu cuenta.", status: 403 };
  return { id: user.id, owner: isInternalProductionOwner(user) };
}

/** El almacén usa la clave de servicio solo en el servidor; la ruta siempre lleva el id de la cuenta autenticada. */
export function studioDeps(): Deps & { store: ProjectStore & BlobStore; voice: VoiceAvailability } {
  return { store: storageStore(createServiceClient().storage.from(AUDIO_STUDIO_BUCKET) as never), voice: voiceAvailability() };
}
