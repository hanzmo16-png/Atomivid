/**
 * Voz elegida en un formulario — SOLO servidor. Valida la elección (catálogo
 * o voz privada propia, con la propiedad comprobada) y devuelve lo que se
 * guarda en la solicitud. Con el selector apagado, o eligiendo la voz por
 * defecto, no se guarda nada: la solicitud queda exactamente como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResolvedVoice } from "@/lib/providers/types";
import { DEFAULT_VOICE_ID, parseVoiceChoice, serializeVoiceChoice, type VoiceLanguage } from "./catalog";
import { resolveCatalogVoice, resolveVoiceChoice, VoiceUnavailableError } from "./resolve";

export type FormVoice = { ok: true; stored: string | null; resolved?: ResolvedVoice } | { ok: false; error: string };

export async function voiceChoiceFromForm(input: {
  raw: FormDataEntryValue | null;
  enabled: boolean;
  userId: string;
  language: VoiceLanguage;
  service: () => SupabaseClient;
}): Promise<FormVoice> {
  if (!input.enabled) return { ok: true, stored: null };
  const choice = parseVoiceChoice(input.raw);
  if (!choice) return { ok: false, error: "Elige una voz válida." };
  let resolved: ResolvedVoice;
  try {
    // El catálogo no consulta la base; solo una voz privada necesita comprobar la propiedad.
    resolved =
      choice.kind === "catalog"
        ? resolveCatalogVoice(choice.id, input.language)
        : await resolveVoiceChoice({ service: input.service(), userId: input.userId, choice, language: input.language });
  } catch (err) {
    if (err instanceof VoiceUnavailableError) return { ok: false, error: err.message };
    return { ok: false, error: "No se pudo comprobar la voz elegida. Intenta de nuevo." };
  }
  // La voz por defecto no se guarda: la solicitud queda igual que antes (y su idioma ya se validó).
  const isDefault = choice.kind === "catalog" && choice.id === DEFAULT_VOICE_ID;
  return { ok: true, stored: isDefault ? null : serializeVoiceChoice(choice), resolved };
}
