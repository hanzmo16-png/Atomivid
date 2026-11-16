import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/supabase/env";
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

/**
 * Cliente de Storage del módulo con la clave de servicio (solo servidor). Cada petición es «no-store» y lleva su propia
 * señal: Next memoiza los GET idénticos dentro de un mismo render, y sin esto la lectura de un proyecto recién creado
 * devolvía el 404 anterior (la biblioteca salía vacía). No se toca el cliente compartido de otros módulos.
 */
function storageBucket() {
  const client = createSupabaseClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: init?.signal ?? new AbortController().signal }) },
  });
  return client.storage.from(AUDIO_STUDIO_BUCKET);
}

/** El almacén usa la clave de servicio solo en el servidor; la ruta siempre lleva el id de la cuenta autenticada. */
export function studioDeps(): Deps & { store: ProjectStore & BlobStore; voice: VoiceAvailability } {
  return { store: storageStore(storageBucket() as never), voice: voiceAvailability() };
}
