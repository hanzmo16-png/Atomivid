import { listAccountVoices } from "@/lib/podcast/voices";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { getFeatureFlags } from "./feature-flags";
import { reelVoiceChoices, validateReelVoiceSelection, validVoiceId, type ReelVoiceCatalog } from "./reel-voices";

/** Read-only catalogue. Existing provider previews; no speech synthesis or new audio charges. */
export async function getReelVoiceCatalog(language: "es" | "en"): Promise<ReelVoiceCatalog> {
  if (!getFeatureFlags().reelVoiceSelectionEnabled) return { enabled: false, voices: [], defaultPreviewUrl: null };
  const voices = await listAccountVoices({ fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) });
  const defaultId = getVoiceIdentity(language).voiceId;
  return { enabled: true, voices: reelVoiceChoices(voices, language, defaultId),
    defaultPreviewUrl: voices.find(v => v.voiceId === defaultId)?.previewUrl ?? null };
}

export async function resolveReelVoiceSelection(raw: unknown, language: "es" | "en"): Promise<string | null> {
  // The legacy route must work even when the catalogue or rollout is unavailable.
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !validVoiceId(raw)) throw new Error("La voz seleccionada no es válida. Vuelve a elegirla.");
  const catalog = await getReelVoiceCatalog(language);
  return validateReelVoiceSelection(raw, catalog.enabled, catalog.voices);
}
