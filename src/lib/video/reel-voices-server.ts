import { listAccountVoices } from "@/lib/podcast/voices";
import { getVoiceIdentity } from "@/lib/ai/voice";
import type { VoiceViewer } from "@/lib/voices/private-voices";
import { getFeatureFlags } from "./feature-flags";
import { reelVoiceChoices, validateReelVoiceSelection, validVoiceId, type ReelVoiceCatalog } from "./reel-voices";

/** Read-only catalogue for this viewer. Existing provider previews only; no speech synthesis or new audio charges. */
export async function getReelVoiceCatalog(language: "es" | "en", viewer: VoiceViewer = null): Promise<ReelVoiceCatalog> {
  if (!getFeatureFlags().reelVoiceSelectionEnabled) return { enabled: false, voices: [], defaultPreviewUrl: null };
  const voices = await listAccountVoices({ fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) });
  const defaultId = getVoiceIdentity(language).voiceId;
  const def = voices.find(v => v.voiceId === defaultId);
  return { enabled: true, voices: reelVoiceChoices(voices, language, defaultId, { viewer }),
    defaultPreviewUrl: def?.previewUrl ?? null, defaultName: def?.name ?? null };
}

export async function resolveReelVoiceSelection(raw: unknown, language: "es" | "en", viewer: VoiceViewer = null): Promise<string | null> {
  // The legacy route must work even when the catalogue or rollout is unavailable.
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !validVoiceId(raw)) throw new Error("La voz seleccionada no es válida. Vuelve a elegirla.");
  const catalog = await getReelVoiceCatalog(language, viewer);
  return validateReelVoiceSelection(raw, catalog.enabled, catalog.voices);
}
