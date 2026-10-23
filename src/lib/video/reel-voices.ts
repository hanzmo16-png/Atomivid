import type { AccountVoice } from "@/lib/podcast/voices";
import { canUsePrivateVoice, isPrivateVoice, supportsModel, type VoiceViewer } from "@/lib/voices/private-voices";

/** default = the legacy language voice; stock = provider premade; library = approved public voice; private = the viewer's own clone. */
export type ReelVoiceKind = "stock" | "library" | "private";
export type ReelVoice = {
  voiceId: string; name: string; accent: string | null; previewUrl: string | null; nativeLanguage: string | null;
  kind: ReelVoiceKind; /** Provider category as reported (premade / professional / cloned). */ category: string | null;
};
export type ReelVoiceCatalog = { storageScope?: string; enabled: boolean; voices: ReelVoice[]; defaultPreviewUrl: string | null; defaultName?: string | null };

// Public Voice Library voices already approved for this product. Private clones need an explicit server grant.
// cCYjmrGZaI86GUJ7F2Nn = "David - Audiobook & Documentary" (professional library voice, American English): the
// narrator of the published Thermopylae documentary (Storage video-004-thermopylae/narration/S1..S9 and voice/setup.json).
const APPROVED_LIBRARY_VOICES = new Set(["uYlzyj2kIZo3HfBB21vF", "TbvhqFC7AApJv7hnNvmY", "cCYjmrGZaI86GUJ7F2Nn"]);
export const validVoiceId = (id: string) => /^[A-Za-z0-9]{8,64}$/.test(id);
export const REEL_TTS_MODEL = "eleven_multilingual_v2";

type Ctx = { viewer?: VoiceViewer; env?: Record<string, string | undefined>; model?: string };

export function reelVoiceChoices(voices: AccountVoice[], language: "es" | "en", defaultVoiceId: string, ctx: Ctx = {}): ReelVoice[] {
  const model = ctx.model ?? REEL_TTS_MODEL;
  const languageOf = (v: AccountVoice) => {
    const raw = v.language?.toLowerCase();
    return raw === "spanish" ? "es" : raw === "english" ? "en" : raw?.split(/[-_]/)[0] ?? null;
  };
  const unique = voices.filter((v, i, all) => validVoiceId(v.voiceId) && v.voiceId !== defaultVoiceId
    && all.findIndex(other => other.voiceId === v.voiceId) === i);
  const byLanguage = (a: AccountVoice, b: AccountVoice) => Number(languageOf(b) === language) - Number(languageOf(a) === language) || a.name.localeCompare(b.name);
  const toChoice = (kind: ReelVoiceKind) => (v: AccountVoice): ReelVoice => ({ voiceId: v.voiceId, name: v.name, accent: v.accent,
    previewUrl: v.previewUrl, nativeLanguage: languageOf(v), kind, category: v.category });
  // Private clones: only the granted viewer, only when trained for the model in use. No preview needed (it may not exist).
  const mine = unique.filter(v => isPrivateVoice(v) && canUsePrivateVoice(v.voiceId, ctx.viewer, ctx.env) && supportsModel(v, model))
    .sort(byLanguage).map(toChoice("private"));
  // Approved library voices are always offered (they were chosen for this product); the cap of three applies to the
  // provider's premade stock only, so an approved narrator can never be pushed out by alphabetical order.
  const library = unique.filter(v => !isPrivateVoice(v) && v.previewUrl && v.category !== "premade" && APPROVED_LIBRARY_VOICES.has(v.voiceId))
    .sort(byLanguage).map(toChoice("library"));
  const stock = unique.filter(v => !isPrivateVoice(v) && v.previewUrl && v.category === "premade")
    .sort(byLanguage).slice(0, 3).map(toChoice("stock"));
  return [...mine, ...library, ...stock];
}

/** Empty/absent means the unchanged legacy voice. Never silently replace an explicit selection. */
export function validateReelVoiceSelection(raw: unknown, enabled: boolean, choices: readonly ReelVoice[]): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !validVoiceId(raw)) throw new Error("La voz seleccionada no es válida. Vuelve a elegirla.");
  if (!enabled || !choices.some(v => v.voiceId === raw)) throw new Error("Esa voz ya no está disponible. Vuelve a elegir una voz antes de continuar.");
  return raw;
}
