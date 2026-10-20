import type { AccountVoice } from "@/lib/podcast/voices";

export type ReelVoice = { voiceId: string; name: string; accent: string | null; previewUrl: string | null; nativeLanguage: string | null };
export type ReelVoiceCatalog = { enabled: boolean; voices: ReelVoice[]; defaultPreviewUrl: string | null };

// Public Voice Library voices already approved for this product. Never expose arbitrary private clones.
const APPROVED_LIBRARY_VOICES = new Set(["uYlzyj2kIZo3HfBB21vF", "TbvhqFC7AApJv7hnNvmY"]);
export const validVoiceId = (id: string) => /^[A-Za-z0-9]{8,64}$/.test(id);

export function reelVoiceChoices(voices: AccountVoice[], language: "es" | "en", defaultVoiceId: string): ReelVoice[] {
  const languageOf = (v: AccountVoice) => {
    const raw = v.language?.toLowerCase();
    return raw === "spanish" ? "es" : raw === "english" ? "en" : raw?.split(/[-_]/)[0] ?? null;
  };
  return voices.filter(v => validVoiceId(v.voiceId) && v.voiceId !== defaultVoiceId &&
    (v.category === "premade" || APPROVED_LIBRARY_VOICES.has(v.voiceId)) && v.previewUrl)
    .sort((a, b) => Number(languageOf(b) === language) - Number(languageOf(a) === language) || a.name.localeCompare(b.name))
    .filter((v, i, all) => all.findIndex(other => other.voiceId === v.voiceId) === i)
    .slice(0, 3)
    .map(v => ({ voiceId: v.voiceId, name: v.name, accent: v.accent, previewUrl: v.previewUrl, nativeLanguage: languageOf(v) }));
}

/** Empty/absent means the unchanged legacy voice. Never silently replace an explicit selection. */
export function validateReelVoiceSelection(raw: unknown, enabled: boolean, choices: readonly ReelVoice[]): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !validVoiceId(raw)) throw new Error("La voz seleccionada no es válida. Vuelve a elegirla.");
  if (!enabled || !choices.some(v => v.voiceId === raw)) throw new Error("Esa voz ya no está disponible. Vuelve a elegir una voz antes de continuar.");
  return raw;
}
