import { VOICE_PRESETS, ValidationError, type AudioProject, type TtsModelId } from "./model";

export type StudioCatalogVoice = { id: string; name: string; previewUrl: string | null; models: TtsModelId[] };
type RawVoice = { voice_id: string; name: string; category?: string; is_owner?: boolean; preview_url?: string; verified_languages?: { language?: string; preview_url?: string }[]; high_quality_base_model_ids?: string[]; fine_tuning?: { state?: Record<string, string> } };

/** Only configured public voices. Private clones are never exposed by this module. */
export function catalogFrom(voices: RawVoice[], map: Record<string, string>): StudioCatalogVoice[] {
  return VOICE_PRESETS.flatMap(p => {
    const v = voices.find(v => v.voice_id === map[p.id]);
    if (!v || v.category === "cloned" || (v.category !== "premade" && v.is_owner === true)) return [];
    const models = (["eleven_multilingual_v2", "eleven_v4_turbo"] as const).filter(m =>
      v.category === "premade" || v.high_quality_base_model_ids?.includes(m) || v.fine_tuning?.state?.[m] === "fine_tuned");
    const preview = v.verified_languages?.find(l => l.language === p.language && l.preview_url?.startsWith("https://"))?.preview_url ?? v.preview_url;
    return [{ id: p.id, name: v.name, previewUrl: preview?.startsWith("https://") ? preview : null, models }];
  });
}

/** GET only: no synthesis, charge or private account data returned. */
export async function studioCatalog(map: Record<string, string>, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<StudioCatalogVoice[]> {
  if (!env.ELEVENLABS_API_KEY) throw new ValidationError("voices", "Falta configurar ElevenLabs.");
  const res = await fetchImpl("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ValidationError("voices", "No se pudieron comprobar las voces. Inténtalo de nuevo; no se generó audio.");
  const body = await res.json() as { voices?: RawVoice[] };
  return catalogFrom(body.voices ?? [], map);
}

export async function validateStudioVoices(project: AudioProject, map: Record<string, string>, env: Record<string, string | undefined> = process.env) {
  const catalog = await studioCatalog(map, env);
  for (const id of project.voices) {
    const preset = VOICE_PRESETS.find(p => p.id === id);
    if (preset?.language !== project.language || !catalog.find(v => v.id === id)?.models.includes(project.ttsModel)) {
      throw new ValidationError("voices", `La voz ${preset?.label ?? id} no está disponible para ese idioma y modelo. Elige otra; no se hizo ningún cargo.`);
    }
  }
}
