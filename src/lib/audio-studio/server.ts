import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "@/lib/supabase/env";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { canAccessAudioStudio } from "./access";
import { AUDIO_STUDIO_BUCKET, storageStore, type BlobStore, type ProjectStore } from "./store";
import type { Deps } from "./service";
import { voiceAvailability, type VoiceAvailability } from "./voice";
import { supabaseAudioPaidSupply, type AudioPaidSupply } from "./paid-supply-port";
import { modelRate } from "./model";

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
function studioService() {
  const client = createSupabaseClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: init?.signal ?? new AbortController().signal }) },
  });
  return client;
}

/**
 * El almacén usa la clave de servicio solo en el servidor; la ruta siempre lleva el id de la cuenta autenticada.
 * La voz depende de la cuenta: la voz de demostración (AUDIO_STUDIO_VOICE=demo) solo existe para la cuenta dueña.
 */
export function studioDeps(user: Pick<StudioUser, "owner">): Deps & { store: ProjectStore & BlobStore; voice: VoiceAvailability; paidSupply?: AudioPaidSupply } {
  const service = studioService(), voice = studioVoiceFor(user);
  return { store: storageStore(service.storage.from(AUDIO_STUDIO_BUCKET) as never), voice,
    paidSupply: voice.ok && voice.voice.mode === "elevenlabs" ? supabaseAudioPaidSupply(service) : undefined };
}

/** Fuente única de la voz de la cuenta autenticada (rutas, páginas y ruta de voces usan esta misma función). */
export function studioVoiceFor(user: Pick<StudioUser, "owner">, env: Record<string, string | undefined> = process.env): VoiceAvailability {
  return voiceAvailability(env, (m) => modelRate(m, env).rate, { owner: user.owner === true });
}
