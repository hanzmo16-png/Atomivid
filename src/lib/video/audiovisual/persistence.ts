/**
 * Lectura/escritura de la dirección audiovisual en video_requests
 * (migración 0020: audiovisual_selection, audiovisual_direction).
 *
 * Tolerante a que la migración aún no esté aplicada: si las columnas no
 * existen, se trata como «sin selección» (flujo anterior intacto) en vez de
 * tumbar las rutas de guion/render que comparten la tabla. Solo una
 * solicitud creada con el flag encendido (y por tanto con la migración
 * aplicada) puede tener selección.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAudiovisualSelection, type AudiovisualSelection } from "./catalog";

export type AudiovisualState = { available: boolean; selection: AudiovisualSelection | null; direction: unknown };

export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /audiovisual_(selection|direction)/.test(error.message ?? "");
}

export async function loadAudiovisualState(service: SupabaseClient, requestId: string): Promise<AudiovisualState> {
  const { data, error } = await service
    .from("video_requests")
    .select("audiovisual_selection, audiovisual_direction")
    .eq("id", requestId)
    .maybeSingle<{ audiovisual_selection: unknown; audiovisual_direction: unknown }>();
  if (error) {
    if (isMissingColumnError(error)) return { available: false, selection: null, direction: null };
    throw new Error(`No se pudo leer la dirección audiovisual: ${error.message}`);
  }
  const raw = data?.audiovisual_selection ?? null;
  if (raw !== null && !isAudiovisualSelection(raw)) {
    // Una selección guardada con forma desconocida nunca se interpreta a medias.
    throw new Error("La dirección audiovisual guardada no es válida. Vuelve a elegirla en la revisión del guion.");
  }
  return { available: true, selection: raw, direction: data?.audiovisual_direction ?? null };
}

/**
 * Invalida la dirección resuelta (el guion o la selección cambiaron). Solo
 * escribe si la solicitud tiene selección, así nunca toca filas antiguas.
 */
export async function invalidateDirection(service: SupabaseClient, requestId: string, state: AudiovisualState): Promise<void> {
  if (!state.available || !state.selection || state.direction === null) return;
  const { error } = await service.from("video_requests").update({ audiovisual_direction: null }).eq("id", requestId);
  if (error) throw new Error(`No se pudo invalidar la dirección audiovisual: ${error.message}`);
}
