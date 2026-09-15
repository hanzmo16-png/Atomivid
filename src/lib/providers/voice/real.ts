import { synthesizeVoice } from "@/lib/ai/voice";
import type { VoiceProvider } from "../types";

export const realVoiceProvider: VoiceProvider = {
  name: "elevenlabs",
  async synthesize(text, language = "es") {
    const result = await synthesizeVoice(text, language);
    return { ...result, mimeType: "audio/mpeg", extension: "mp3" };
  },
};
