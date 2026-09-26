/**
 * Resolución de la voz elegida — SOLO servidor. Devuelve el voice_id real
 * que llegará al proveedor, o un error con el motivo. Nunca sustituye en
 * silencio una voz por otra.
 *
 * Voces privadas («Mi voz», tabla user_voices): se comprueba la propiedad
 * de forma explícita (user_id de la fila === usuario de la solicitud) con
 * el cliente de servicio, en cada uso: al crear la solicitud y otra vez en
 * el worker, porque la voz pudo eliminarse entre ambos momentos. Enviar el
 * id de una voz ajena falla igual que enviar uno inexistente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVoiceIdentity } from "@/lib/ai/voice";
import type { ResolvedVoice } from "@/lib/providers/types";
import { VOICE_CATALOG, catalogLanguageIssue, parseVoiceChoice, serializeVoiceChoice, type VoiceChoice, type VoiceLanguage } from "./catalog";

export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

export type UserVoiceRow = {
  id: string;
  user_id: string;
  name: string;
  status: string;
  provider_voice_id: string | null;
  deleted_at: string | null;
};

/** Voz del catálogo (sin I/O). Mateo conserva exactamente su configuración: su variable de entorno histórica y las de idioma. */
export function resolveCatalogVoice(id: keyof typeof VOICE_CATALOG, language: VoiceLanguage): ResolvedVoice {
  const issue = catalogLanguageIssue(id, language);
  if (issue) throw new VoiceUnavailableError(issue);
  const voice = VOICE_CATALOG[id];
  const providerVoiceId = id === "mateo" ? getVoiceIdentity(language).voiceId : voice.providerVoiceId;
  return { choice: id, label: voice.label, providerVoiceId, ownerId: null };
}

/** Comprueba una voz privada ya leída: propietaria, estado y que exista en el proveedor. */
export function checkUserVoice(row: UserVoiceRow | null, userId: string): ResolvedVoice {
  if (!row || row.user_id !== userId) throw new VoiceUnavailableError("Esa voz no existe o no es tuya. Elige otra voz.");
  if (row.deleted_at || row.status === "deleted" || row.status === "deleting") throw new VoiceUnavailableError(`«${row.name}» fue eliminada. Elige otra voz.`);
  if (row.status !== "ready" || !row.provider_voice_id) throw new VoiceUnavailableError(`«${row.name}» todavía no está lista.`);
  return { choice: serializeVoiceChoice({ kind: "custom", id: row.id }), label: row.name, providerVoiceId: row.provider_voice_id, ownerId: row.user_id };
}

export async function resolveVoiceChoice(input: { service: SupabaseClient; userId: string; choice: VoiceChoice; language: VoiceLanguage }): Promise<ResolvedVoice> {
  if (input.choice.kind === "catalog") return resolveCatalogVoice(input.choice.id, input.language);
  const { data, error } = await input.service
    .from("user_voices")
    .select("id, user_id, name, status, provider_voice_id, deleted_at")
    .eq("id", input.choice.id)
    .maybeSingle<UserVoiceRow>();
  if (error) throw new Error(`No se pudo comprobar la voz elegida: ${error.message}`);
  return checkUserVoice(data, input.userId);
}

function isMissingVoiceColumn(error: { code?: string; message?: string }): boolean {
  return error.code === "42703" || error.code === "PGRST204" || /voice_choice/.test(error.message ?? "");
}

/**
 * Voz guardada en una solicitud, resuelta para el worker. Tolera que la
 * migración 0021 no esté aplicada (sin columna = voz de siempre) para no
 * tumbar los renders existentes. undefined = voz por defecto (idéntico a
 * antes). Una voz privada eliminada o ajena lanza VoiceUnavailableError:
 * la producción se detiene con el motivo; nunca cambia de voz en silencio.
 */
export async function loadRequestVoice(service: SupabaseClient, requestId: string, userId: string, language: VoiceLanguage): Promise<ResolvedVoice | undefined> {
  const { data, error } = await service.from("video_requests").select("voice_choice").eq("id", requestId).maybeSingle<{ voice_choice: string | null }>();
  if (error) {
    if (isMissingVoiceColumn(error)) return undefined;
    throw new Error(`No se pudo leer la voz de la solicitud: ${error.message}`);
  }
  if (!data?.voice_choice) return undefined;
  const choice = parseVoiceChoice(data.voice_choice);
  if (!choice) throw new VoiceUnavailableError("La voz guardada en esta solicitud no es válida. Crea la solicitud de nuevo eligiendo una voz.");
  return resolveVoiceChoice({ service, userId, choice, language });
}
