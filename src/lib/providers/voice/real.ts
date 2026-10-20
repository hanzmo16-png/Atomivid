import { synthesizeVoice } from "@/lib/ai/voice";
import type { VoiceProvider } from "../types";

export function realVoiceProviderFor(voiceId?: string): VoiceProvider {
  return {
    name: "elevenlabs",
    async synthesize(text, language = "es", speed) {
      const result = await synthesizeVoice(text, language, speed, voiceId);
      return { ...result, mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
}

export const realVoiceProvider: VoiceProvider = realVoiceProviderFor();
