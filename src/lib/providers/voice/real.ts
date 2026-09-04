import { synthesizeVoice } from "@/lib/ai/voice";
import type { VoiceProvider } from "../types";

export const realVoiceProvider: VoiceProvider = {
  name: "elevenlabs",
  async synthesize(text) {
    const result = await synthesizeVoice(text);
    return { ...result, mimeType: "audio/mpeg", extension: "mp3" };
  },
};
