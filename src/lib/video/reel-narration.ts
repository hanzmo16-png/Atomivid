import { getVoiceIdentity } from "@/lib/ai/voice";
import { getVoiceProvider } from "@/lib/providers/voice";
import { validVoiceId } from "./reel-voices";

/** One identity drives both the paid-result key and the actual provider request (including speed correction). */
export function reelNarration(language: "es" | "en", voiceId?: string | null) {
  if (voiceId != null && !validVoiceId(voiceId)) throw new Error("La voz guardada no es válida. No se ha generado audio.");
  const selected = voiceId ?? undefined;
  return { voiceProvider: getVoiceProvider(selected), voiceIdentity: getVoiceIdentity(language, selected) };
}
