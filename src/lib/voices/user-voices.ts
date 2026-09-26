/**
 * Lectura de voces privadas («Mi voz») para los formularios. Tolera que la
 * migración 0021 no esté aplicada: sin tabla = sin voces privadas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export function isMissingRelationError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /relation .* does not exist|Could not find the table/i.test(error.message ?? "");
}

/** Voces privadas LISTAS de la usuaria (RLS limita la lectura a sus propias filas). */
export async function listReadyUserVoices(supabase: SupabaseClient, userId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase
    .from("user_voices")
    .select("id, name")
    .eq("user_id", userId)
    .eq("status", "ready")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(`No se pudieron leer tus voces: ${error.message}`);
  }
  return (data ?? []) as { id: string; name: string }[];
}
