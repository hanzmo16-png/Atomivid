import { synthesizeVoice } from "@/lib/ai/voice";
import type { VoiceProvider } from "../types";

export const realVoiceProvider: VoiceProvider = {
  name: "elevenlabs",
  async synthesize(text, language = "es", speed, options) {
    const result = await synthesizeVoice(text, language, speed, {
      voiceId: options?.voice?.providerVoiceId,
      previousText: options?.previousText,
      nextText: options?.nextText,
    });
    return { ...result, mimeType: "audio/mpeg", extension: "mp3" };
  },
};
